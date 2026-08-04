/**
 * Phase 5C — feed ordering (M2 FROZEN): chronological default, closed registry,
 * FORBIDDEN signals throw by name, unknown evidence omitted (never invented).
 */

import {
  chronological, rankMoments, scoreBreakdown,
  MOMENT_RANKING_WEIGHTS, FORBIDDEN_RANKING_SIGNALS,
  MomentRankingRegistryError, MomentRankingWeightError, RankableMoment,
} from '../src/moments/moments.ranking';

const m = (id: string, createdAtUTC: number, evidence: RankableMoment['evidence'] = {}): RankableMoment =>
  ({ id, createdAtUTC, evidence });

describe('moments ranking (M2 frozen)', () => {
  it('CHRONOLOGICAL is the default order — newest first, ties by id', () => {
    const out = chronological([m('b', 100), m('a', 100), m('c', 300)]);
    expect(out.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('EVERY forbidden signal throws BY NAME — as evidence and as weight', () => {
    for (const bad of FORBIDDEN_RANKING_SIGNALS) {
      expect(() => scoreBreakdown(m('x', 1, { [bad]: 1 } as never)))
        .toThrow(MomentRankingRegistryError);
      expect(() => rankMoments([m('x', 1)], { ...MOMENT_RANKING_WEIGHTS, [bad]: 0.5 } as never))
        .toThrow(MomentRankingRegistryError);
    }
    // The error explains WHY for engagement-maximization names.
    expect(() => scoreBreakdown(m('x', 1, { watchTime: 1 } as never)))
      .toThrow(/FORBIDDEN engagement-maximization/);
  });

  it('any other unregistered signal also throws', () => {
    expect(() => scoreBreakdown(m('x', 1, { astrology: 1 } as never))).toThrow(MomentRankingRegistryError);
  });

  it('unknown evidence is OMITTED and disclosed — never an invented zero', () => {
    const b = scoreBreakdown(m('x', 1, { recency: 1 }));
    expect(b.components.map((c) => c.signal)).toEqual(['recency']);
    expect(b.omittedSignals).toEqual(['relationship', 'proximity', 'explicitFollows', 'explicitInterests', 'freshness']);
    expect(b.total).toBeCloseTo(MOMENT_RANKING_WEIGHTS.recency, 4);
  });

  it('breakdown total equals the weighted component sum; ranked order is deterministic', () => {
    const a = m('a', 100, { recency: 1, proximity: 0.5 });
    const b = m('b', 200, { recency: 1, proximity: 0.5 });
    const ranked = rankMoments([a, b]);
    for (const r of ranked) {
      const sum = r.ranking.components.reduce((s, c) => s + c.weighted, 0);
      expect(Math.abs(sum - r.ranking.total)).toBeLessThan(1e-9);
    }
    expect(ranked[0].moment.id).toBe('b'); // equal total → newer first
  });

  it('weight validation: negative/NaN refused', () => {
    expect(() => rankMoments([m('a', 1)], { ...MOMENT_RANKING_WEIGHTS, recency: -1 })).toThrow(MomentRankingWeightError);
    expect(() => rankMoments([m('a', 1)], { ...MOMENT_RANKING_WEIGHTS, freshness: NaN })).toThrow(MomentRankingWeightError);
  });
});
