/**
 * Spot Me — candidate scoring (design §5.1–5.2).
 *
 * The router's job is to turn today's hardcoded engine order in `handler()`
 * into a number per provider, per request, so the order becomes a consequence
 * of measured signals rather than a branch. This file is that arithmetic:
 *
 *   score(p,r) = w_fit·fit + w_qual·quality + w_lat·latency + w_cost·cost + w_priv·privacy
 *
 * Every term is in [0,1] and every weight preset sums to 1.0, so a score is in
 * [0,1] and comparable across providers and profiles. The three profiles are
 * the policy knobs: `accuracy` leans on quality, `latency` on speed, `cost` on
 * price — the same table, three lenses.
 *
 * PURE AND DETERMINISTIC. Given the same capabilities, health snapshot, quality
 * score and profile, `score()` returns the same number. No clock, no network,
 * no randomness — so the router's choices are testable as fixtures.
 */
import { ROUTING_PROFILES } from './types.js'

/** Weight presets. Each row sums to 1.0 (asserted by the suite). Design §5.2. */
export const WEIGHT_PROFILES = Object.freeze({
  accuracy: Object.freeze({ fit: 0.25, quality: 0.40, latency: 0.10, cost: 0.10, privacy: 0.15 }),
  latency: Object.freeze({ fit: 0.20, quality: 0.20, latency: 0.40, cost: 0.05, privacy: 0.15 }),
  cost: Object.freeze({ fit: 0.20, quality: 0.25, latency: 0.05, cost: 0.35, privacy: 0.15 })
})

/**
 * Per-profile latency ceiling used to normalise p95 into a [0,1] term. The
 * `latency` profile is the strictest (sub-second paths, live-voice text leg),
 * so a provider's tail is judged against a tighter budget there.
 */
export const PROFILE_BUDGET_MS = Object.freeze({
  accuracy: 8000, // matches the engine's LEG_MS headroom
  latency: 2500,
  cost: 12000     // matches LLM_MS; batch tolerates a longer tail
})

/** Normalised cost by class — free is cheapest (0), premium dearest (~0.9). */
export const COST_CLASS_NORM = Object.freeze({
  free: 0.0, cheap: 0.25, metered: 0.6, premium: 0.9
})

/** Privacy bonus by posture (design §5.1). Also a hard gate via G_privacy. */
export const PRIVACY_BONUS = Object.freeze({
  'on-device': 1.0, 'cloud-contract': 0.6, 'cloud-keyless': 0.0
})

/** Default per-(provider,pair) quality when the feedback loop has no sample yet. */
export const QUALITY_SEED = 0.6

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** fit(p,r) — the provider's declared pair fitness, already 0..1. */
export function fitTerm (caps, src, tgt) {
  return clamp01(caps.languagePairs(src, tgt))
}

/** quality(p,·) — the rolling EWMA the router reads; seeded when unseen. */
export function qualityTerm (score) {
  return clamp01(typeof score === 'number' ? score : QUALITY_SEED)
}

/** latency(p) — 1 minus the p95 as a fraction of the profile budget. */
export function latencyTerm (p95Ms, budgetMs) {
  const b = budgetMs > 0 ? budgetMs : PROFILE_BUDGET_MS.accuracy
  return clamp01(1 - (Number(p95Ms) || 0) / b)
}

/** cost(p,r) — 1 minus the normalised cost class (free→1, premium→~0.1). */
export function costTerm (costClass) {
  const norm = COST_CLASS_NORM[costClass]
  return clamp01(1 - (typeof norm === 'number' ? norm : 0.6))
}

/** privacyBonus(p) — on-device rewarded, keyless zeroed. */
export function privacyTerm (privacy) {
  const b = PRIVACY_BONUS[privacy]
  return typeof b === 'number' ? b : 0
}

/**
 * Score one provider for one request. `ctx` supplies the parts the provider
 * object cannot know by itself: the routing profile and a quality lookup.
 *
 * @param {{capabilities: () => any, health: () => any}} provider
 * @param {{sourceLang?: string, targetLang: string}} request
 * @param {{profile?: string, quality?: number}} ctx
 * @returns {number} score in [0,1]
 */
export function score (provider, request, ctx = {}) {
  return scoreBreakdown(provider, request, ctx).score
}

/**
 * The same computation, but returning every term — used by the router to attach
 * a legible explanation to the RoutingDecision and by the suite to assert the
 * arithmetic term by term.
 */
export function scoreBreakdown (provider, request, ctx = {}) {
  const profile = ROUTING_PROFILES.includes(ctx.profile) ? ctx.profile : 'accuracy'
  const w = WEIGHT_PROFILES[profile]
  const budget = PROFILE_BUDGET_MS[profile]
  const caps = provider.capabilities()
  const health = provider.health() || {}

  const terms = {
    fit: fitTerm(caps, request.sourceLang, request.targetLang),
    quality: qualityTerm(ctx.quality),
    latency: latencyTerm(health.p95Ms, budget),
    cost: costTerm(caps.costClass),
    privacy: privacyTerm(caps.privacy)
  }
  const total =
    w.fit * terms.fit +
    w.quality * terms.quality +
    w.latency * terms.latency +
    w.cost * terms.cost +
    w.privacy * terms.privacy

  return { profile, weights: w, terms, score: clamp01(total) }
}
