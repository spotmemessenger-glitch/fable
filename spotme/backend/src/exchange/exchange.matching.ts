/**
 * Exchange matching engine (Phase 3C) — deterministic, explainable, closed.
 *
 * Mirrors the discovery ranking discipline: a CLOSED signal registry (no
 * popularity / sponsored / engagement path — supplying one THROWS), safety as
 * a HARD GATE before scoring, unknown evidence contributes ZERO (never an
 * invented benefit), and proximity is weighted so it materially dominates —
 * a closer viable counterpart beats a popular-but-distant one. Every match
 * carries a full ExchangeMatchExplanation. Weights are [PROPOSED] config
 * defaults (PRD §4.4); the SHAPE is contract.
 */

export const EXCHANGE_MATCH_SIGNALS = ['intentFit', 'proximity', 'availability', 'trust', 'freshness'] as const;
export type ExchangeMatchSignal = (typeof EXCHANGE_MATCH_SIGNALS)[number];

/** [PROPOSED] defaults (PRD §4.4). Proximity is weighted so its span dominates
 *  any single non-proximity signal — proximity-outranks-popularity is a
 *  validated invariant, and there is no popularity signal to begin with. */
export const EXCHANGE_MATCH_WEIGHTS: Record<ExchangeMatchSignal, number> = {
  intentFit: 0.35,
  proximity: 0.25,
  availability: 0.20,
  trust: 0.15,
  freshness: 0.05,
};

export class ExchangeClosedRegistryError extends Error {
  constructor(signal: string) {
    super(`unregistered exchange match signal '${signal}' — the registry is closed (no popularity/sponsored/engagement path exists)`);
    this.name = 'ExchangeClosedRegistryError';
  }
}
export class ExchangeWeightError extends Error {
  constructor(signal: string) {
    super(`exchange match weight for '${signal}' must be a finite number >= 0`);
    this.name = 'ExchangeWeightError';
  }
}

export interface ExchangeMatchCandidate {
  id: string;
  /** HARD GATE: false ⇒ excluded before scoring; no weight can override it. */
  safetyEligible: boolean;
  /** Distance BAND to the seeker — never metres. */
  distanceBand: 'under500m' | 'under1km' | 'under2km' | 'under5km' | 'over5km';
  /** Evidence in [0,1] per registered signal; ABSENT means UNKNOWN (→ 0). */
  evidence: Partial<Record<ExchangeMatchSignal, { value: number; reason: string }>>;
}

export interface ExchangeMatchExplanation {
  components: { signal: ExchangeMatchSignal; weight: number; value: number; weighted: number }[];
  total: number;
  omittedSignals: ExchangeMatchSignal[];
  safetyEligible: true;
}

export interface ExchangeRankedMatch {
  id: string;
  score: number;
  distanceBand: ExchangeMatchCandidate['distanceBand'];
  explanation: ExchangeMatchExplanation;
}

const BAND_ORDER = ['under500m', 'under1km', 'under2km', 'under5km', 'over5km'] as const;

/** Score + rank candidates. Ineligible candidates are dropped BEFORE scoring. */
export function rankExchangeMatches(
  candidates: ExchangeMatchCandidate[],
  weights: Record<ExchangeMatchSignal, number> = EXCHANGE_MATCH_WEIGHTS,
): ExchangeRankedMatch[] {
  const registered = new Set<string>(EXCHANGE_MATCH_SIGNALS);
  for (const s of EXCHANGE_MATCH_SIGNALS) {
    const w = weights[s];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new ExchangeWeightError(s);
  }
  for (const k of Object.keys(weights)) if (!registered.has(k)) throw new ExchangeClosedRegistryError(k);

  const eligible = candidates.filter((c) => c.safetyEligible === true);

  const ranked = eligible.map((c) => {
    for (const key of Object.keys(c.evidence)) {
      if (!registered.has(key)) throw new ExchangeClosedRegistryError(key);
    }
    const components: ExchangeMatchExplanation['components'] = [];
    const omitted: ExchangeMatchSignal[] = [];
    for (const signal of EXCHANGE_MATCH_SIGNALS) {
      const ev = c.evidence[signal];
      if (!ev || !Number.isFinite(ev.value)) { omitted.push(signal); continue; }
      const value = Math.max(0, Math.min(1, ev.value));
      const weight = weights[signal];
      components.push({ signal, weight, value: +value.toFixed(4), weighted: +(weight * value).toFixed(4) });
    }
    const total = +components.reduce((s, x) => s + x.weighted, 0).toFixed(4);
    return {
      id: c.id,
      score: total,
      distanceBand: c.distanceBand,
      explanation: { components, total, omittedSignals: omitted, safetyEligible: true as const },
    };
  });

  // Deterministic order: score desc, then nearer band, then id asc.
  ranked.sort((a, b) =>
    b.score - a.score ||
    BAND_ORDER.indexOf(a.distanceBand) - BAND_ORDER.indexOf(b.distanceBand) ||
    a.id.localeCompare(b.id));
  return ranked;
}

/** Proximity evidence from a band — nearer bands score higher (banded on
 *  purpose; never a numeric distance). Exposed so the candidate assembler and
 *  its tests agree on the mapping. */
export function proximityFromBand(band: ExchangeMatchCandidate['distanceBand']): number {
  return 1 - BAND_ORDER.indexOf(band) / (BAND_ORDER.length - 1);
}
