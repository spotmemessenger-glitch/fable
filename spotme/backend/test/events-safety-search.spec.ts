/**
 * Phase 4B — Events safety (blocking + origin-leak guard) and the sanitized
 * search projection (no coordinates in any index doc).
 */

import { filterForSafety, assertNoOriginLeak } from '../src/events/events.safety';
import { toEventSearchProjection, stripCoordinateTokens, UnconfiguredEventSearchAdapter, orderEventHits } from '../src/events/events.search';
import type { NormalizedEvent, StatedEvent } from '../src/events/events.types';

const ev = (over: Partial<NormalizedEvent> & { id: string }): NormalizedEvent => ({
  category: 'music', title: 'Gig', description: null,
  startUTC: 1000, endUTC: 2000, timezone: null, allDay: false, occurrenceId: null,
  lifecycle: 'scheduled', coarseLat: 12.972, coarseLon: 77.595, coarseCell: 'g12.972:77.595',
  popularity: null, fetchedAtUTC: null, restricted: false, unsafe: false,
  source: { provider: 'p', providerEventId: 'x', providerSourceId: null, organizerRef: null, sourceName: 'Acme', url: null, revisionUTC: null, confidence: null, provenance: null },
  ...over,
});

describe('events safety', () => {
  it('removes events from a blocked provider/source/organiser', () => {
    const kept = ev({ id: 'a' });
    const blocked = ev({ id: 'b', source: { ...ev({ id: 'x' }).source, sourceName: 'BadOrg' } });
    const out = filterForSafety([kept, blocked], { isBlocked: (id) => id === 'BadOrg' });
    expect(out.map((e) => e.id)).toEqual(['a']);
  });

  it('removes source-flagged unsafe/restricted unless explicitly allowed', () => {
    const restricted = ev({ id: 'r', restricted: true });
    expect(filterForSafety([restricted])).toHaveLength(0);
    expect(filterForSafety([restricted], { allowRestricted: true })).toHaveLength(1);
  });

  it('assertNoOriginLeak throws if the user origin appears on a record (mutation guard)', () => {
    const origin = { lat: 12.9716, lon: 77.5946 };
    expect(assertNoOriginLeak([ev({ id: 'ok' }) as unknown as Record<string, unknown>], origin)).toBe(true);
    expect(() => assertNoOriginLeak([{ id: 'leak', originLat: 12.9716, originLon: 77.5946 }], origin)).toThrow(/origin/i);
    expect(() => assertNoOriginLeak([{ id: 'leak2', userLat: 1 }], origin)).toThrow(/origin-shaped/i);
  });
});

describe('events search projection (T-EV-5/6)', () => {
  const stated = (over: Partial<StatedEvent> = {}): StatedEvent => ({ ...ev({ id: 'p:1' }), state: 'upcoming', ...over });

  it('the projection carries NO coordinate field and no lat/lon key', () => {
    const doc = toEventSearchProjection(stated());
    expect(Object.keys(doc).sort()).toEqual(['category', 'coarseCell', 'id', 'normalizedText', 'startUTC', 'state', 'title']);
    expect('lat' in doc).toBe(false);
    expect('lon' in doc).toBe(false);
    expect('coarseLat' in doc).toBe(false);
  });

  it('a coordinate embedded in the title/description is stripped from the projection', () => {
    const doc = toEventSearchProjection(stated({ title: 'Meet at 12.9716,77.5946', description: 'near 77.594609' }));
    const json = JSON.stringify(doc);
    expect(json).not.toContain('12.9716');
    expect(json).not.toContain('77.594609');
    expect(stripCoordinateTokens('a 12.9716,77.5946 b')).toBe('a b');
  });

  it('the default search adapter is unconfigured — typed unavailability, no network', async () => {
    const a = new UnconfiguredEventSearchAdapter();
    expect(await a.search('x')).toEqual({ state: 'provider-unavailable', reason: 'unconfigured' });
    expect(await a.index({ id: 'x', category: 'music', title: 't', normalizedText: 't', coarseCell: 'g', startUTC: null, state: 'upcoming' })).toEqual({ ok: false });
  });

  it('exact hits pin ahead of fuzzy, deterministically', () => {
    const ordered = orderEventHits([{ id: 'z', exactMatch: false }, { id: 'a', exactMatch: true }]);
    expect(ordered[0].id).toBe('a');
  });
});
