/**
 * Phase 4B — Conservative cross-provider dedup (C4). Exact identity folds; a
 * cross-provider merge needs ALL four signals; title similarity alone never
 * merges; ambiguous candidates stay separate; decisions are explainable.
 */

import { dedupeEvents, dedupEvidence, normalizeTitle } from '../src/events/events.dedup';
import type { NormalizedEvent } from '../src/events/events.types';

const ev = (over: Partial<NormalizedEvent> & { id: string }): NormalizedEvent => ({
  category: 'music', title: 'Jazz Night', description: null,
  startUTC: 1000, endUTC: 2000, timezone: null, allDay: false, occurrenceId: null,
  lifecycle: 'scheduled', coarseLat: 12.972, coarseLon: 77.595, coarseCell: 'g12.972:77.595',
  popularity: null, fetchedAtUTC: null, restricted: false, unsafe: false,
  source: { provider: 'p', providerEventId: 'x', providerSourceId: null, organizerRef: null, sourceName: null, url: null, revisionUTC: null, confidence: null, provenance: null },
  ...over,
});

describe('events dedup (C4)', () => {
  it('EXACT provider identity folds automatically', () => {
    const a = ev({ id: 'p:1' });
    const b = ev({ id: 'p:1' });
    const { canonical, decisions } = dedupeEvents([a, b]);
    expect(canonical).toHaveLength(1);
    expect(decisions).toEqual([{ canonicalId: 'p:1', mergedId: 'p:1', basis: 'exact-provider-identity', evidence: null }]);
  });

  it('CROSS-PROVIDER merge requires ALL FOUR signals (same title+venue+time+area)', () => {
    const a = ev({ id: 'p1:1', source: { ...ev({ id: 'x' }).source, confidence: 0.9 } });
    const b = ev({ id: 'p2:9', title: 'jazz  night', source: { ...ev({ id: 'x' }).source, provider: 'p2', confidence: 0.5 } });
    const { canonical, decisions } = dedupeEvents([a, b]);
    expect(canonical.map((c) => c.id)).toEqual(['p1:1']); // higher confidence wins
    expect(decisions[0]).toMatchObject({ canonicalId: 'p1:1', mergedId: 'p2:9', basis: 'cross-provider-match' });
    expect(decisions[0].evidence).toEqual({ normalizedTitleMatch: true, venueIdentityMatch: true, timeWindowOverlap: true, coarseAreaMatch: true });
  });

  it('title similarity ALONE never merges — different venue/time stays SEPARATE', () => {
    const a = ev({ id: 'p1:1' });
    const b = ev({ id: 'p2:2', source: { ...ev({ id: 'x' }).source, provider: 'p2' }, coarseLat: 40.0, coarseLon: -70.0, coarseCell: 'g40.000:-70.000', startUTC: 9_000_000, endUTC: 9_100_000 });
    const { canonical } = dedupeEvents([a, b]);
    expect(canonical).toHaveLength(2); // same title, but different venue+time → separate
  });

  it('same title + same venue but NON-overlapping time stays separate (ambiguous)', () => {
    const a = ev({ id: 'p1:1', startUTC: 1000, endUTC: 2000 });
    const b = ev({ id: 'p2:2', source: { ...ev({ id: 'x' }).source, provider: 'p2' }, startUTC: 500_000, endUTC: 600_000 });
    const e = dedupEvidence(a, b);
    expect(e.timeWindowOverlap).toBe(false);
    expect(dedupeEvents([a, b]).canonical).toHaveLength(2);
  });

  it('normalizeTitle folds width/punctuation/case', () => {
    expect(normalizeTitle('Jazz—Night!!')).toBe(normalizeTitle('jazz night'));
  });
});
