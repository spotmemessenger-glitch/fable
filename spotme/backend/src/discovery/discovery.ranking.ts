/**
 * People ordering + explanation (checkpoints 2/5).
 *
 * The C5 ranking ORDER, verbatim from the mission:
 *   1 safety eligibility → 2 explicit user filters → 3 distance band →
 *   4 freshness → 5 mutual-context signals ONLY when explicitly authorized
 *   (never authorized this phase — always omitted) → 6 deterministic
 *   tie-breaker (userId).
 *
 * NEVER ranked by: engagement prediction, attractiveness, wealth, sensitive
 * traits, inferred vulnerability, paid placement — no such signal exists in
 * this module, and the C8/C12 fences assert none appears.
 *
 * Every result carries a RankingBreakdown (P5). WeIGHTS are configuration
 * values with documented defaults; the general weighted engine arrives in
 * checkpoint 8 — people ordering here is deliberately lexicographic
 * (band, then freshness), which weighted scoring must preserve.
 */

import { DistanceBand, PersonCandidateRow, RankingBreakdown } from './discovery.types';

/**
 * Documented default weights for the people explanation (config values).
 *
 * BAND-DOMINANT BY CONSTRUCTION (P5 honesty, F4.2): ordering is lexicographic
 * (band, then freshness), so the displayed `total` must be monotonic with that
 * order or the number contradicts the position. Adjacent bands differ by
 * `proximity × 0.25` in the proximity value; freshness spans `freshness × 1`.
 * With proximity 0.85 / freshness 0.15 the per-band gap (0.2125) strictly
 * exceeds the whole freshness span (0.15), so a nearer band always outscores a
 * farther one regardless of freshness — total now explains the rank.
 */
export const PEOPLE_RANKING_WEIGHTS = {
  proximity: 0.85,
  freshness: 0.15,
} as const;

export function bandForDistanceM(d: number): DistanceBand {
  if (d < 500) return 'under500m';
  if (d < 1000) return 'under1km';
  if (d < 2000) return 'under2km';
  if (d < 5000) return 'under5km';
  return 'over5km';
}

const BAND_ORDER: DistanceBand[] = ['under500m', 'under1km', 'under2km', 'under5km', 'over5km'];
export const bandIndex = (b: DistanceBand) => BAND_ORDER.indexOf(b);

/** Freshness value in [0,1]: 1 at observation, linear to 0 at expiry. */
export function freshnessValue(row: PersonCandidateRow, now: Date): number {
  const span = row.expiresAt.getTime() - row.observedAt.getTime();
  if (span <= 0) return 0;
  const left = row.expiresAt.getTime() - now.getTime();
  return Math.max(0, Math.min(1, left / span));
}

/** Proximity value in [0,1] by band (banded on purpose — C-BAND). */
export function proximityValue(band: DistanceBand): number {
  return 1 - bandIndex(band) / (BAND_ORDER.length - 1);
}

/**
 * Order candidates by the C5 rules. Safety eligibility (blocks, visibility,
 * expiry, self) is enforced in the repository predicates BEFORE this runs;
 * ordering re-asserts expiry defensively (a stale row must never surface).
 */
export function orderPeople(rows: PersonCandidateRow[], now: Date): PersonCandidateRow[] {
  return rows
    .filter((r) => r.expiresAt.getTime() > now.getTime())
    .sort((a, b) => {
      const ba = bandIndex(bandForDistanceM(a.coarseDistanceM));
      const bb = bandIndex(bandForDistanceM(b.coarseDistanceM));
      if (ba !== bb) return ba - bb;                       // 3: distance band
      const fa = freshnessValue(a, now);
      const fb = freshnessValue(b, now);
      if (fa !== fb) return fb - fa;                       // 4: freshness
      return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0; // 6: tie-break
    });
}

/** The mandatory explanation for a person result (P5). */
export function explainPerson(row: PersonCandidateRow, now: Date): RankingBreakdown {
  const band = bandForDistanceM(row.coarseDistanceM);
  const prox = proximityValue(band);
  const fresh = freshnessValue(row, now);
  const components = [
    {
      signal: 'proximity',
      weight: PEOPLE_RANKING_WEIGHTS.proximity,
      value: prox,
      weighted: +(PEOPLE_RANKING_WEIGHTS.proximity * prox).toFixed(4),
      reason: `${band} band`,
    },
    {
      signal: 'freshness',
      weight: PEOPLE_RANKING_WEIGHTS.freshness,
      value: +fresh.toFixed(4),
      weighted: +(PEOPLE_RANKING_WEIGHTS.freshness * fresh).toFixed(4),
      reason: `presence expires ${row.expiresAt.toISOString()}`,
    },
  ];
  return {
    total: +components.reduce((s, c) => s + c.weighted, 0).toFixed(4),
    components,
    // Mutual-context exists as a REGISTERED-but-unauthorized signal: always
    // omitted this phase, and its omission is visible (P5).
    omittedSignals: ['mutual-context'],
    confidence: 0.9,
    source: 'deterministic-baseline',
  };
}
