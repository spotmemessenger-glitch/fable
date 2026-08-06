/**
 * Nearby Moments — feed ordering (Phase 5C, M2 FROZEN).
 *
 * CHRONOLOGICAL-FIRST IS THE DEFAULT: a feed is newest-first unless the caller
 * explicitly asks for 'ranked'. The ranked path uses ONLY the closed registry —
 * recency / relationship / proximity / explicitFollows / explicitInterests /
 * freshness. The forbidden signals (outrage, watchTime, click/engagement
 * probability, addiction/session-length optimization, popularity amplification,
 * sponsored) are named in the guard and THROW loudly, as does any other
 * unregistered key. Every ranked result carries a full breakdown; unknown
 * evidence is disclosed as omitted, never invented. No AI (M7): every signal is
 * a deterministic function of the row and the viewer's explicit graph.
 */

export const MOMENT_RANKING_SIGNALS = [
  'recency', 'relationship', 'proximity', 'explicitFollows', 'explicitInterests', 'freshness',
] as const;
export type MomentRankingSignal = (typeof MOMENT_RANKING_SIGNALS)[number];

/** Forbidden by name (M2) — kept as data so the error can say WHY. */
export const FORBIDDEN_RANKING_SIGNALS = [
  'outrage', 'watchTime', 'engagement', 'clickProbability', 'engagementProbability',
  'addictionOptimization', 'sessionLength', 'popularityAmplification', 'sponsored', 'popularity',
] as const;

/** [PROPOSED] defaults (owner-retained ratification). Shape is contract. */
export const MOMENT_RANKING_WEIGHTS: Record<MomentRankingSignal, number> = {
  recency: 0.35,
  relationship: 0.20,
  proximity: 0.15,
  explicitFollows: 0.15,
  explicitInterests: 0.10,
  freshness: 0.05,
};

export class MomentRankingRegistryError extends Error {
  constructor(signal: string) {
    const why = (FORBIDDEN_RANKING_SIGNALS as readonly string[]).includes(signal)
      ? `'${signal}' is a FORBIDDEN engagement-maximization signal (M2)`
      : `'${signal}' is not a registered moments ranking signal`;
    super(`${why} — the registry is closed; chronological-first is the default`);
    this.name = 'MomentRankingRegistryError';
  }
}
export class MomentRankingWeightError extends Error {
  constructor(signal: string) {
    super(`moments ranking weight for '${signal}' must be a finite number >= 0`);
    this.name = 'MomentRankingWeightError';
  }
}

export interface RankableMoment {
  id: string;
  createdAtUTC: number;
  /** Evidence in [0,1] per registered signal; ABSENT means UNKNOWN (omitted). */
  evidence: Partial<Record<MomentRankingSignal, number>>;
}

export interface MomentRankingComponent { signal: MomentRankingSignal; weight: number; value: number; weighted: number }
export interface MomentRankingBreakdown { components: MomentRankingComponent[]; omittedSignals: MomentRankingSignal[]; total: number }
export interface RankedMoment<T extends RankableMoment = RankableMoment> { moment: T; ranking: MomentRankingBreakdown }

const clamp01 = (n: number) => (!Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n);

function assertClosed(weights: Record<string, number>): void {
  const registered = new Set<string>(MOMENT_RANKING_SIGNALS);
  for (const s of MOMENT_RANKING_SIGNALS) {
    const w = weights[s];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new MomentRankingWeightError(s);
  }
  for (const k of Object.keys(weights)) if (!registered.has(k)) throw new MomentRankingRegistryError(k);
}

export function scoreBreakdown(m: RankableMoment, weights = MOMENT_RANKING_WEIGHTS): MomentRankingBreakdown {
  assertClosed(weights);
  const registered = new Set<string>(MOMENT_RANKING_SIGNALS);
  for (const k of Object.keys(m.evidence)) if (!registered.has(k)) throw new MomentRankingRegistryError(k);
  const components: MomentRankingComponent[] = [];
  const omittedSignals: MomentRankingSignal[] = [];
  for (const signal of MOMENT_RANKING_SIGNALS) {
    const v = m.evidence[signal];
    if (v == null || !Number.isFinite(v)) { omittedSignals.push(signal); continue; }
    const weight = weights[signal];
    const value = clamp01(v);
    components.push({ signal, weight, value: +value.toFixed(4), weighted: +(weight * value).toFixed(4) });
  }
  const total = +components.reduce((s, c) => s + c.weighted, 0).toFixed(4);
  return { components, omittedSignals, total };
}

/** Chronological order — THE DEFAULT (M2). Pure; ties break by id. */
export function chronological<T extends RankableMoment>(moments: T[]): T[] {
  return [...moments].sort((a, b) => b.createdAtUTC - a.createdAtUTC || a.id.localeCompare(b.id));
}

/** The explicit ranked path — closed registry only; deterministic. */
export function rankMoments<T extends RankableMoment>(moments: T[], weights = MOMENT_RANKING_WEIGHTS): RankedMoment<T>[] {
  const ranked = moments.filter((m) => m && m.id != null).map((moment) => ({ moment, ranking: scoreBreakdown(moment, weights) }));
  ranked.sort((a, b) => b.ranking.total - a.ranking.total || b.moment.createdAtUTC - a.moment.createdAtUTC || a.moment.id.localeCompare(b.moment.id));
  return ranked;
}
