/**
 * Spot Me — confidence taxonomy and the quality feedback loop (design §6.1–6.2).
 *
 * TWO THINGS THE ENGINE COMPUTES AND THROWS AWAY TODAY, made first-class:
 *
 *  1. CONFIDENCE. Every result already "knows" how sure it is — two engines
 *     agreed, or a judge picked, or it was a lone survivor — but that certainty
 *     is never surfaced as a number. `classifyConfidence()` / `confidenceFor()`
 *     turn the engine's own branches into the design's numeric bands so the
 *     client can show "confirmed" vs "single engine, unverified".
 *
 *  2. QUALITY. The adjudicator verdicts and wrong-script disqualifications are
 *     computed on almost every verified request and then dropped (one
 *     `console.log`). `updateQuality()` is the rolling EWMA that keeps them: a
 *     per-(provider,pair) score the router reads as its `quality` term and an
 *     observability signal for drift. This is the "missing piece" the design
 *     calls the feedback loop.
 *
 * SKELETON, NOT WIRED. These are pure functions with no store behind them yet —
 * the persistence (TranslationQualityScore, design §13) lands with the DB work,
 * gated. Here they are correct, deterministic, and unit-tested.
 */

/**
 * The confidence bands (design §6.1). Ordered high→low; each has a numeric range
 * and a representative value the engine's branch maps to.
 */
export const CONFIDENCE_BANDS = Object.freeze([
  Object.freeze({ name: 'confirmed', min: 0.90, max: 1.00, rep: 0.95 }),
  Object.freeze({ name: 'adjudicated', min: 0.70, max: 0.89, rep: 0.78 }),
  Object.freeze({ name: 'single', min: 0.50, max: 0.69, rep: 0.60 }),
  Object.freeze({ name: 'fallback', min: 0.30, max: 0.49, rep: 0.40 }),
  Object.freeze({ name: 'degraded', min: 0.00, max: 0.29, rep: 0.20 })
])

/** How the engine's verification outcome maps to a band name. */
export const VERIFICATION_BAND = Object.freeze({
  agree: 'confirmed',       // two independent engines agree()
  adjudicated: 'adjudicated', // judge picked, faithfulness-first, scriptOk-checked
  single: 'single',         // one engine, passed scriptOk, no second opinion
  fallback: 'fallback',     // keyless tail (gtx/MyMemory) or no script opinion
  none: 'degraded'          // wrong-script survivor / unverified last resort
})

/** Which band does this numeric confidence fall in? Clamps out-of-range input. */
export function classifyConfidence (score) {
  const s = Number(score)
  if (!Number.isFinite(s)) return 'degraded'
  for (const band of CONFIDENCE_BANDS) {
    if (s >= band.min) return band.name
  }
  return 'degraded'
}

/** The representative confidence for a verification outcome or band name. */
export function confidenceFor (kind) {
  const bandName = VERIFICATION_BAND[kind] || kind
  const band = CONFIDENCE_BANDS.find((b) => b.name === bandName)
  return band ? band.rep : 0.2
}

/* ------------------------------------------------- the quality feedback loop */

/** EWMA smoothing factor. Small, so one bad sample nudges rather than lurches. */
export const QUALITY_ALPHA = 0.1

/** Seed for an unseen (provider,pair) — matches the scorer's QUALITY_SEED. */
export const QUALITY_SEED = 0.6

/**
 * Sample signals (design §6.2). These are the observations already made on the
 * verified path today, then discarded except one log line. Positive pulls the
 * score up, negative down; a wrong script is the strongest penalty because it
 * is the worst, most reader-invisible failure the product has.
 */
export const QUALITY_SAMPLE = Object.freeze({
  adjudicationWin: 1.0,   // won an adjudication
  agree: 0.8,             // agreed with an independent engine
  adjudicationLoss: 0.0,  // lost an adjudication
  wrongScript: -1.0,      // disqualified for wrong script
  userReject: -0.6        // user tapped "show original" / reported it
})

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n)

/** Numeric value of a named sample signal, or a raw number passed straight in. */
export function sampleValue (signal) {
  if (typeof signal === 'number') return signal
  const v = QUALITY_SAMPLE[signal]
  return typeof v === 'number' ? v : 0
}

/**
 * One EWMA step: fold a new sample into the rolling score. The sample may be
 * negative (wrong script), so the result is clamped back into [0,1] — a run of
 * wrong-script answers drives the score to the floor, which is exactly what
 * should shed that provider from the router's `quality` term.
 *
 *   q_new = clamp( α·sample + (1−α)·q_old , 0, 1 )
 */
export function updateQuality (prev, signal, alpha = QUALITY_ALPHA) {
  const q = typeof prev === 'number' ? prev : QUALITY_SEED
  const a = alpha > 0 && alpha < 1 ? alpha : QUALITY_ALPHA
  return clamp01(a * sampleValue(signal) + (1 - a) * q)
}

/**
 * A tiny in-memory quality store the router can read and the verification path
 * can feed. NO plaintext ever lives here — only (provider, pair) → score. The
 * durable version (design §13 TranslationQualityScore) replaces the Map behind
 * this same shape, gated, when the DB work lands.
 */
export function createQualityStore (opts = {}) {
  const seed = typeof opts.seed === 'number' ? opts.seed : QUALITY_SEED
  const alpha = opts.alpha || QUALITY_ALPHA
  const scores = new Map() // "provider|pair" -> number

  const keyOf = (provider, pair) => `${provider}|${pair}`
  return {
    /** Current score for a (provider,pair), seeded when unseen. */
    get (provider, pair) {
      const k = keyOf(provider, pair)
      return scores.has(k) ? scores.get(k) : seed
    },
    /** Fold a sample in and return the new score. */
    record (provider, pair, signal) {
      const k = keyOf(provider, pair)
      const next = updateQuality(scores.has(k) ? scores.get(k) : seed, signal, alpha)
      scores.set(k, next)
      return next
    },
    /** A data view for observability — no content, just aggregate scores. */
    snapshot () {
      const out = {}
      for (const [k, v] of scores) out[k] = v
      return out
    },
    clear () { scores.clear() }
  }
}
