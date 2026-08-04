/**
 * Phase 4C — Transparent event ranking (C2). Closed registry, popularity as a
 * tie-break only, unknown popularity omitted (never invented), engagement throws.
 */

import {
  rankEvents, scoreBreakdown, EVENT_RANKING_WEIGHTS,
  EventRankingRegistryError, EventRankingWeightError, RankableEvent,
} from '../src/events/events.ranking';

const ev = (over: Partial<RankableEvent> & { id: string }): RankableEvent => ({
  state: 'upcoming', startUTC: 1000, distanceBand: 'under1km', category: 'music',
  title: 'Gig', description: null, popularity: null, ...over,
});

describe('events ranking (C2)', () => {
  it('every result carries a full breakdown whose total equals the sum of weighted components', () => {
    const [r] = rankEvents([ev({ id: 'a', state: 'happening-now', distanceBand: 'under500m', popularity: 0.5 })], {}, 1000);
    const sum = r.ranking.components.reduce((s, c) => s + c.weighted, 0);
    expect(Math.abs(sum - r.ranking.total)).toBeLessThan(1e-9);
  });

  it('UNKNOWN popularity is OMITTED, never an invented zero', () => {
    const b = scoreBreakdown(ev({ id: 'x', popularity: null }), {}, 1000);
    expect(b.omittedSignals).toContain('popularity');
    expect(b.components.some((c) => c.signal === 'popularity')).toBe(false);
  });

  it('popularity is a TIE-BREAK only — it cannot resurrect a materially more distant event', () => {
    // Same time/relevance; near has unknown popularity, far has maximal popularity.
    const near = ev({ id: 'near', distanceBand: 'under500m', popularity: null });
    const far = ev({ id: 'far', distanceBand: 'over5km', popularity: 1 });
    const [first] = rankEvents([far, near], {}, 1000);
    expect(first.event.id).toBe('near'); // distance dominates; popularity cannot override
  });

  it('popularity BREAKS a genuine tie (identical substantive score)', () => {
    const a = ev({ id: 'a', popularity: 0.2 });
    const b = ev({ id: 'b', popularity: 0.9 }); // identical except popularity
    const [first] = rankEvents([a, b], {}, 1000);
    expect(first.event.id).toBe('b');
  });

  it('a cancelled event scores zero on time and sinks below a live one', () => {
    const live = ev({ id: 'live', state: 'happening-now' });
    const cancelled = ev({ id: 'cancelled', state: 'cancelled', popularity: 1 });
    const order = rankEvents([cancelled, live], {}, 1000).map((r) => r.event.id);
    expect(order[0]).toBe('live');
  });

  it('ENGAGEMENT / sponsored signals are impossible — the registry rejects them loudly', () => {
    expect(() => rankEvents([ev({ id: 'p' })], {}, 0, { ...EVENT_RANKING_WEIGHTS, engagement: 1 } as never)).toThrow(EventRankingRegistryError);
    expect(() => rankEvents([ev({ id: 'p' })], {}, 0, { ...EVENT_RANKING_WEIGHTS, sponsored: 1 } as never)).toThrow(EventRankingRegistryError);
  });

  it('weight validation: negative/NaN weights are refused', () => {
    expect(() => rankEvents([ev({ id: 'a' })], {}, 0, { ...EVENT_RANKING_WEIGHTS, distance: -1 })).toThrow(EventRankingWeightError);
    expect(() => rankEvents([ev({ id: 'a' })], {}, 0, { ...EVENT_RANKING_WEIGHTS, time: NaN })).toThrow(EventRankingWeightError);
  });

  it('happening-now outranks a distant future event on the time signal', () => {
    const now = ev({ id: 'now', state: 'happening-now', distanceBand: 'under5km' });
    const future = ev({ id: 'future', state: 'upcoming', startUTC: 1000 + 71 * 3600_000, distanceBand: 'under500m' });
    const [first] = rankEvents([future, now], {}, 1000);
    expect(first.event.id).toBe('now');
  });
});
