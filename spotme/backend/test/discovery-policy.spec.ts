/**
 * Checkpoint 2 — policy validation and service composition (in-memory fakes).
 * The refusal battery IS the server half of the privacy boundary: everything
 * the threat model says must be refused, is refused here with a typed error.
 */

import { validateDiscoveryQuery, decodeCursor, encodeCursor, validateVisibilityUpsert, DISCOVERY_POLICY_DEFAULTS } from '../src/discovery/discovery.policy';
import { DiscoveryError } from '../src/discovery/discovery.errors';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { DiscoveryPeopleRepository, DiscoveryVisibilityRepository } from '../src/discovery/discovery.repository';
import { PersonCandidateRow } from '../src/discovery/discovery.types';
import { orderPeople, explainPerson } from '../src/discovery/discovery.ranking';

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

  it('cursors are opaque, signed, and round-trip an EXACT float distance (F10.1)', () => {
    // A fractional distance must survive verbatim — rounding it would re-emit
    // or skip keyset-boundary rows.
    const c = encodeCursor({ d: 1234.4567, u: 'user_9', depth: 2 });
    expect(decodeCursor(c)).toEqual({ d: 1234.4567, u: 'user_9', depth: 2 });
    expectCode(() => decodeCursor('not-a-cursor'), 'INVALID_CURSOR');
    expectCode(() => validateDiscoveryQuery('me', okQuery({ cursor: 'zzz' })), 'INVALID_CURSOR');
  });

  it('a FORGED cursor is rejected — the payload is signed, not just base64 (F6)', () => {
    // An attacker crafting {d,u,depth} by hand (no valid HMAC) cannot turn the
    // cursor into a distance oracle.
    const forged = Buffer.from(JSON.stringify({ d: 500, u: 'victim', depth: 0 }), 'utf8').toString('base64url') + '.deadbeefdeadbeefdeadbe';
    expectCode(() => decodeCursor(forged), 'INVALID_CURSOR');
    // Tampering with a legitimately-issued cursor's payload also fails the check.
    const good = encodeCursor({ d: 10, u: 'u', depth: 0 });
    const tampered = Buffer.from(JSON.stringify({ d: 999999, u: 'u', depth: 0 }), 'utf8').toString('base64url') + '.' + good.split('.')[1];
    expectCode(() => decodeCursor(tampered), 'INVALID_CURSOR');
  });

  it('cursor depth is the enforced enumeration bound (F5)', () => {
    const deep = encodeCursor({ d: 10, u: 'u', depth: 20 });
    expectCode(() => validateDiscoveryQuery('me', okQuery({ cursor: deep })), 'CURSOR_TOO_DEEP');
    const shallow = encodeCursor({ d: 10, u: 'u', depth: 3 });
    expect(() => validateDiscoveryQuery('me', okQuery({ cursor: shallow }))).not.toThrow();
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
    // The metre value 340 must not appear in ANY numeric context — a bare
    // `:340` is how JSON serializes a leaked number, so a quoted-only check was
    // vacuous (F11.2). The cursor is NOT a leak here (single row → no cursor).
    expect(json).not.toMatch(/[:,[]\s*340\s*[,}\]]/);
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

  it('setVisibility validates + coarsens the body (F1) and bounds the TTL (F4.1)', async () => {
    let stored: unknown = null;
    const people: DiscoveryPeopleRepository = { findNearbyPeople: async () => [] };
    const vis: DiscoveryVisibilityRepository = {
      setVisibility: async (_id, v) => { stored = v; return { visibilityVersion: 1 }; },
      getVisibility: async () => null,
    };
    const svc = new DiscoveryService(people, vis);
    // A precise fix REQUESTING a year-long window: coords must be re-quantized
    // to the coarse grid and the TTL clamped to the ceiling.
    await svc.setVisibility('me', { enabled: true, origin: { lat: 12.9716523, lon: 77.5946891 }, expiresInMinutes: 525600 });
    const s = stored as { coarseLat: number; coarseLon: number; expiresAt: Date };
    expect(s.coarseLat).toBe(12.972); // 3-decimal grid, not the precise value
    expect(s.coarseLon).toBe(77.595);
    const ttlMin = (s.expiresAt.getTime() - Date.now()) / 60_000;
    expect(ttlMin).toBeLessThanOrEqual(DISCOVERY_POLICY_DEFAULTS.maxVisibilityTtlMinutes + 1);
  });
});

describe('visibility write refusals (F1)', () => {
  const expectCode = (fn: () => unknown, code: string) => {
    try { fn(); throw new Error('expected a refusal'); }
    catch (e) { expect(e).toBeInstanceOf(DiscoveryError); expect((e as DiscoveryError).code).toBe(code); }
  };
  it('refuses a precise GeolocationCoordinates shape', () => {
    expectCode(() => validateVisibilityUpsert({ enabled: true, origin: { lat: 1, lon: 2, accuracy: 5 } }), 'PRECISE_LOCATION_REFUSED');
    expectCode(() => validateVisibilityUpsert({ enabled: true, coords: { latitude: 1 } } as unknown), 'PRECISE_LOCATION_REFUSED');
  });
  it('refuses unknown keys (A3: no age/gender ride-along) and out-of-range coords', () => {
    // Unknown keys fail the shared exact-key allow-list (MALFORMED_QUERY);
    // range/shape failures raise VISIBILITY_REFUSED. Both are typed, fail-closed.
    expectCode(() => validateVisibilityUpsert({ enabled: true, origin: { lat: 1, lon: 2 }, age: 30 } as unknown), 'MALFORMED_QUERY');
    expectCode(() => validateVisibilityUpsert({ enabled: true, origin: { lat: 200, lon: 2 } }), 'VISIBILITY_REFUSED');
  });
  it('disabling needs no coordinates', () => {
    const v = validateVisibilityUpsert({ enabled: false });
    expect(v.enabled).toBe(false);
  });
});

describe('ranking explanation preserves the sort order (F4.2, P5)', () => {
  const row = (userId: string, dist: number, minsLeft: number): PersonCandidateRow => ({
    userId, displayName: userId, handle: null, avatarRef: null, coarseDistanceM: dist,
    coarseLat: 0, coarseLon: 0, coarseCell: 'c',
    observedAt: new Date(Date.now() - 10 * 60_000), expiresAt: new Date(Date.now() + minsLeft * 60_000),
  });
  it('for every adjacent pair in orderPeople, explain(a).total >= explain(b).total', () => {
    const now = new Date();
    // A nearer-but-stale row vs a farther-but-fresh row — the exact case that
    // made the old 0.6/0.4 weights display a total contradicting the rank.
    const rows = [row('near-stale', 100, 1), row('far-fresh', 1500, 60), row('mid', 700, 30), row('nearest-fresh', 50, 55)];
    const ordered = orderPeople(rows, now);
    for (let i = 1; i < ordered.length; i++) {
      const a = explainPerson(ordered[i - 1], now).total;
      const b = explainPerson(ordered[i], now).total;
      expect(a).toBeGreaterThanOrEqual(b);
    }
  });
});
