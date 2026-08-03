/**
 * Checkpoint 2 — policy validation and service composition (in-memory fakes).
 * The refusal battery IS the server half of the privacy boundary: everything
 * the threat model says must be refused, is refused here with a typed error.
 */

import { validateDiscoveryQuery, decodeCursor, encodeCursor, DISCOVERY_POLICY_DEFAULTS } from '../src/discovery/discovery.policy';
import { DiscoveryError } from '../src/discovery/discovery.errors';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { DiscoveryPeopleRepository, DiscoveryVisibilityRepository } from '../src/discovery/discovery.repository';
import { PersonCandidateRow } from '../src/discovery/discovery.types';

const okQuery = (over: Record<string, unknown> = {}) => ({
  contractsVersion: 1,
  intent: { kind: 'people' },
  scope: 'people',
  origin: { lat: 12.97, lon: 77.59 },
  radius: { km: 2 },
  ...over,
});

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
    fail(`expected ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(DiscoveryError);
    expect((e as DiscoveryError).code).toBe(code);
    expect((e as DiscoveryError).nextStep.length).toBeGreaterThan(0);
  }
};

describe('discovery policy — validation & ceilings', () => {
  it('accepts a well-formed coarse query', () => {
    const v = validateDiscoveryQuery('me', okQuery());
    expect(v.origin).toEqual({ lat: 12.97, lon: 77.59 });
    expect(v.radiusKm).toBe(2);
    expect(v.pageSize).toBe(DISCOVERY_POLICY_DEFAULTS.defaultPageSize);
  });

  it('REFUSES a precise-location-shaped origin (GeolocationCoordinates markers)', () => {
    for (const marker of ['accuracy', 'altitude', 'heading', 'speed', 'timestamp']) {
      expectCode(
        () => validateDiscoveryQuery('me', okQuery({ origin: { lat: 1, lon: 2, [marker]: 5 } })),
        'PRECISE_LOCATION_REFUSED',
      );
    }
    expectCode(() => validateDiscoveryQuery('me', { ...okQuery(), coords: { latitude: 1 } }), 'PRECISE_LOCATION_REFUSED');
  });

  it('refuses unknown query/origin keys (exact-key allow-list)', () => {
    expectCode(() => validateDiscoveryQuery('me', okQuery({ extra: 1 })), 'MALFORMED_QUERY');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ origin: { lat: 1, lon: 2, precision: 'high' } })), 'MALFORMED_QUERY');
  });

  it('A3: age/gender filter keys are structurally unsupported', () => {
    expectCode(() => validateDiscoveryQuery('me', okQuery({ filters: { gender: 'f' } })), 'UNSUPPORTED_FILTER');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ filters: { minAge: 21 } })), 'UNSUPPORTED_FILTER');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ filters: { age: 30 } })), 'UNSUPPORTED_FILTER');
  });

  it('A8: openNow cannot filter people or usernames', () => {
    expectCode(() => validateDiscoveryQuery('me', okQuery({ filters: { openNow: true } })), 'UNSUPPORTED_FILTER');
    expectCode(
      () => validateDiscoveryQuery('me', okQuery({ scope: 'usernames', filters: { openNow: true } })),
      'UNSUPPORTED_FILTER',
    );
    // …but is accepted for place-capable scopes.
    const v = validateDiscoveryQuery('me', okQuery({ scope: 'places', intent: { kind: 'category', category: 'cafe' }, filters: { openNow: true } }));
    expect(v.filters.openNow).toBe(true);
  });

  it('bounds: radius ceiling refused loudly, never silently clamped', () => {
    expectCode(() => validateDiscoveryQuery('me', okQuery({ radius: { km: 26 } })), 'RADIUS_OUT_OF_BOUNDS');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ radius: { km: -1 } })), 'MALFORMED_QUERY');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ origin: { lat: 91, lon: 0 } })), 'MALFORMED_QUERY');
  });

  it('cursors are opaque and round-trip; garbage is INVALID_CURSOR', () => {
    const c = encodeCursor({ d: 1234, u: 'user_9' });
    expect(decodeCursor(c)).toEqual({ d: 1234, u: 'user_9' });
    expectCode(() => decodeCursor('not-a-cursor'), 'INVALID_CURSOR');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ cursor: 'zzz' })), 'INVALID_CURSOR');
  });

  it('contracts version is pinned', () => {
    expectCode(() => validateDiscoveryQuery('me', okQuery({ contractsVersion: 2 })), 'INVALID_CONTRACTS_VERSION');
  });
});

describe('discovery service — composition over in-memory fakes', () => {
  const now = new Date('2026-08-03T18:00:00Z');
  const mk = (userId: string, dist: number, minsLeft = 20): PersonCandidateRow => ({
    userId,
    displayName: `User ${userId}`,
    handle: null,
    avatarRef: null,
    coarseDistanceM: dist,
    coarseLat: 12.97,
    coarseLon: 77.59,
    coarseCell: 'cell-1',
    observedAt: new Date(now.getTime() - 10 * 60_000),
    expiresAt: new Date(now.getTime() + minsLeft * 60_000),
  });

  const service = (rows: PersonCandidateRow[]) => {
    const people: DiscoveryPeopleRepository = { findNearbyPeople: async () => rows };
    const vis: DiscoveryVisibilityRepository = {
      setVisibility: async () => ({ visibilityVersion: 1 }),
      getVisibility: async () => null,
    };
    return new DiscoveryService(people, vis);
  };

  it('orders band → freshness → userId; page carries NO total count', async () => {
    const rows = [mk('c', 1500), mk('a', 100), mk('b', 100, 5)];
    const page = await service(rows).queryPeople('me', okQuery(), now);
    expect(page.results.map((r) => (r.type === 'person' ? r.person.userId : ''))).toEqual(['a', 'b', 'c']);
    expect((page as unknown as Record<string, unknown>).total).toBeUndefined();
    expect((page as unknown as Record<string, unknown>).totalCount).toBeUndefined();
  });

  it('projects bands only — no numeric distance or precise coords in output', async () => {
    const page = await service([mk('a', 340)]).queryPeople('me', okQuery(), now);
    const person = page.results[0].type === 'person' ? page.results[0].person : null;
    expect(person?.distanceBand).toBe('under500m');
    const json = JSON.stringify(page);
    expect(json).not.toContain('coarseDistanceM');
    expect(json).not.toContain('"340"');
    expect((person as unknown as Record<string, unknown>).deviceDistanceM).toBeUndefined();
  });

  it('every result carries a RankingBreakdown with visible omitted signals (P5)', async () => {
    const page = await service([mk('a', 100)]).queryPeople('me', okQuery(), now);
    const r = page.results[0];
    expect(r.ranking.total).toBeGreaterThan(0);
    expect(r.ranking.components.map((c) => c.signal)).toEqual(['proximity', 'freshness']);
    expect(r.ranking.omittedSignals).toContain('mutual-context');
    expect(r.ranking.source).toBe('deterministic-baseline');
  });

  it('expired rows never surface even if a repository leaks them', async () => {
    const page = await service([mk('a', 100, -1), mk('b', 200)]).queryPeople('me', okQuery(), now);
    expect(page.results).toHaveLength(1);
    expect(page.results[0].type === 'person' && page.results[0].person.userId).toBe('b');
  });

  it('duplicates collapse; pagination emits an opaque cursor only when more exist', async () => {
    const many = Array.from({ length: 25 }, (_, i) => mk(`u${String(i).padStart(2, '0')}`, 100 + i));
    const withDupe = [...many, mk('u00', 100)];
    const page = await service(withDupe).queryPeople('me', okQuery(), now);
    expect(page.results).toHaveLength(DISCOVERY_POLICY_DEFAULTS.defaultPageSize);
    expect(typeof page.cursor).toBe('string');
    const short = await service([mk('a', 1)]).queryPeople('me', okQuery(), now);
    expect(short.cursor).toBeNull();
  });
});
