/**
 * Spot Me — the degradation ladder with recovery hysteresis. WS3 design
 * §13.3 ("never silence"), ADR-011b.
 *
 * When a stage fails or the budget is breached the session does not flap or
 * fall silent — it walks DOWN a ladder of explicitly-named tiers, and walks
 * back UP only after sustained health. The tiers (mission + design §13.3,
 * collapsed to the three modes this build can actually deliver):
 *
 *   FULL           translated voice + dual captions + ducked original
 *   CAPTIONS_ONLY  translated captions, no synthesized voice, full original
 *   ORIGINAL_ONLY  the untouched E2E call; translation contributes nothing
 *
 * ORIGINAL_ONLY is always reachable and always safe because the original call
 * audio NEVER stopped flowing underneath (the translated stream is additive —
 * §3.1). Dropping to it is loss of a feature, never loss of the call.
 *
 * HYSTERESIS, BOTH DIRECTIONS. Demotion needs `demoteAfter` breaches inside
 * `windowMs` (one hiccup is not a trend); promotion needs `promoteAfterMs` of
 * clean running (a provider that just recovered gets a probation period, the
 * ADR-012 §3 damping pattern) — so a flaky provider cannot make the UI
 * strobe between modes. Every move is announced through `onChange` so the
 * honesty rule (§13.3: "each downgrade is announced") is enforceable by the
 * event consumer, and every move carries its reason.
 */

export const DEGRADATION_TIERS = Object.freeze({
  FULL: 'full',
  CAPTIONS_ONLY: 'captions-only',
  ORIGINAL_ONLY: 'original-only'
})

/** Ladder order, most capable first. */
export const TIER_ORDER = Object.freeze([
  DEGRADATION_TIERS.FULL,
  DEGRADATION_TIERS.CAPTIONS_ONLY,
  DEGRADATION_TIERS.ORIGINAL_ONLY
])

export const LADDER_DEFAULTS = Object.freeze({
  demoteAfter: 2,        // breaches within the window to drop one tier
  windowMs: 10_000,      // breach-counting window
  promoteAfterMs: 15_000 // sustained-clean time to climb one tier
})

/**
 * Create the ladder. `clock.now()` injectable. `onChange({ from, to, reason,
 * direction })` fires on every move.
 */
export function createDegradationLadder (opts = {}) {
  const cfg = { ...LADDER_DEFAULTS, ...opts }
  const clock = opts.clock || { now: () => Date.now() }
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null

  let tierIndex = 0
  let breaches = []          // timestamps inside the window (bounded by pruning)
  let cleanSince = clock.now()
  const history = []         // bounded move log
  const MAX_HISTORY = 64

  const prune = (now) => { breaches = breaches.filter((t) => now - t <= cfg.windowMs) }
  const move = (nextIndex, reason, direction) => {
    const from = TIER_ORDER[tierIndex]
    tierIndex = nextIndex
    const to = TIER_ORDER[tierIndex]
    const rec = { from, to, reason, direction, at: clock.now() }
    history.push(rec)
    while (history.length > MAX_HISTORY) history.shift()
    if (onChange) onChange(rec)
    return rec
  }

  return {
    get tier () { return TIER_ORDER[tierIndex] },
    get atBottom () { return tierIndex === TIER_ORDER.length - 1 },
    moves: () => history.slice(),

    /** May the current tier synthesize voice? Render translated captions? */
    allows () {
      const tier = TIER_ORDER[tierIndex]
      return {
        voice: tier === DEGRADATION_TIERS.FULL,
        translatedCaptions: tier !== DEGRADATION_TIERS.ORIGINAL_ONLY,
        originalAudio: true // ALWAYS — the never-silence invariant
      }
    },

    /**
     * Report a breach (over-budget utterance, stage failure, provider
     * exhaustion, sustained loss). Demotes one tier when the hysteresis
     * threshold is met. Returns the move record or null.
     */
    recordBreach (reason = 'breach') {
      const now = clock.now()
      breaches.push(now)
      prune(now)
      cleanSince = now // any breach restarts the promotion probation
      if (breaches.length >= cfg.demoteAfter && tierIndex < TIER_ORDER.length - 1) {
        breaches = []
        return move(tierIndex + 1, reason, 'demote')
      }
      return null
    },

    /**
     * Report a clean, on-budget utterance (or periodic health tick). Promotes
     * one tier after `promoteAfterMs` of unbroken health. Returns the move
     * record or null.
     */
    recordClean () {
      const now = clock.now()
      prune(now)
      if (tierIndex > 0 && now - cleanSince >= cfg.promoteAfterMs) {
        cleanSince = now
        return move(tierIndex - 1, 'sustained-clean', 'promote')
      }
      return null
    },

    /** Hard drop to the bottom tier (kill switch / cap hit / flag off). */
    forceBottom (reason = 'forced') {
      if (tierIndex === TIER_ORDER.length - 1) return null
      breaches = []
      cleanSince = clock.now()
      return move(TIER_ORDER.length - 1, reason, 'demote')
    },

    /** Reset to FULL (new session). */
    reset () {
      tierIndex = 0
      breaches = []
      cleanSince = clock.now()
      history.length = 0
    }
  }
}
