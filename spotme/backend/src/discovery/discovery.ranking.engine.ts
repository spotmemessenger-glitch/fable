/**
 * The general ranking engine (checkpoint 8) — explainable or nothing.
 *
 * Combines: explicit user intent · safety eligibility (a HARD GATE, not a
 * weight — an ineligible candidate never enters scoring, so no score can win
 * past safety) · proximity · relevance · freshness · source confidence ·
 * availability evidence. Every numeric weight is a configuration value with a
 * documented default. Every response exposes total, per-component scores,
 * reasons, omitted signals, confidence, and source (P5).
 *
 * HONESTY RULES, enforced structurally:
 *  - UNKNOWN evidence contributes NOTHING: a missing signal is omitted and
 *    listed in `omittedSignals` — it never receives an invented positive
 *    value (P4).
 *  - The signal registry is CLOSED: evidence for an unregistered signal
 *    ('popularity', 'sponsored', 'engagement', …) is rejected — there is no
 *    code path by which paid placement or engagement prediction can enter a
 *    score (P5; threat model C-NOSPONSOR).
 */

import { RankingBreakdown, RankingComponent } from './discovery.types';

/** The COMPLETE closed signal registry. Nothing outside this list can score. */
export const RANKING_SIGNALS = [
  'intentMatch',
  'proximity',
  'relevance',
  'freshness',
  'sourceConfidence',
  'availabilityEvidence',
] as const;
export type RankingSignal = (typeof RANKING_SIGNALS)[number];

/** Documented default weights — configuration values, deliberately
 *  proximity-dominant (P1: closer viable results outrank popularity). */
export const RANKING_WEIGHTS_DEFAULTS: Record<RankingSignal, number> = {
  intentMatch: 0.30,
  proximity: 0.30,
  relevance: 0.15,
  freshness: 0.10,
  sourceConfidence: 0.10,
  availabilityEvidence: 0.05,
};

export interface RankingCandidate {
  id: string;
  /** HARD GATE: false ⇒ excluded before scoring; no weight can override it. */
  safetyEligible: boolean;
  /** Evidence in [0,1] per registered signal; ABSENT means UNKNOWN. */
  evidence: Partial<Record<RankingSignal, { value: number; reason: string }>>;
}

export interface RankedCandidate {
  id: string;
  breakdown: RankingBreakdown;
}

export class ClosedRegistryError extends Error {
  constructor(signal: string) {
    super(`unregistered ranking signal '${signal}' — the registry is closed (no popularity/sponsored/engagement path exists)`);
    this.name = 'ClosedRegistryError';
  }
}

export function rankCandidates(
  candidates: RankingCandidate[],
  weights: Record<RankingSignal, number> = RANKING_WEIGHTS_DEFAULTS,
): RankedCandidate[] {
  const registered = new Set<string>(RANKING_SIGNALS);

  const eligible = candidates.filter((c) => c.safetyEligible === true);

  const ranked = eligible.map((c) => {
    const components: RankingComponent[] = [];
    const omitted: string[] = [];

    for (const key of Object.keys(c.evidence)) {
      if (!registered.has(key)) throw new ClosedRegistryError(key);
    }

    for (const signal of RANKING_SIGNALS) {
      const ev = c.evidence[signal];
      if (!ev || !Number.isFinite(ev.value)) {
        omitted.push(signal); // unknown stays unknown — zero contribution
        continue;
      }
      const value = Math.max(0, Math.min(1, ev.value));
      const weight = weights[signal];
      components.push({
        signal,
        weight,
        value: +value.toFixed(4),
        weighted: +(weight * value).toFixed(4),
        reason: ev.reason,
      });
    }

    const total = +components.reduce((s, x) => s + x.weighted, 0).toFixed(4);
    const evidenceCoverage = components.length / RANKING_SIGNALS.length;

    const breakdown: RankingBreakdown = {
      total,
      components,
      omittedSignals: omitted,
      confidence: +evidenceCoverage.toFixed(2),
      source: 'deterministic-baseline',
    };
    return { id: c.id, breakdown };
  });

  // Deterministic order: total desc, then id asc (stable tie-break).
  ranked.sort((a, b) => b.breakdown.total - a.breakdown.total || a.id.localeCompare(b.id));
  return ranked;
}
