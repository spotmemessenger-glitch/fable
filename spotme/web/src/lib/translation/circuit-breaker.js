/**
 * Spot Me — per-provider circuit breaker (design §5.4, §10.2).
 *
 * WHAT IT FIXES. Today a dead provider is retried on every single request: the
 * retired Gemini model id 404s, `adjudicate()` lists it first, it throws, and
 * the request quietly falls through to the next judge — every time, paying the
 * latency and the failure on each call. A breaker sheds a provider that is
 * failing so the router stops choosing it (the `G_circuit` hard gate), then
 * probes it once after a cooldown to see if it recovered.
 *
 * closed → open → half-open, per the design's state machine:
 *   closed:    normal. Count failures inside a rolling window; at `threshold`
 *              within `windowMs`, trip OPEN.
 *   open:      shed. `canRequest()` is false until `cooldownMs` elapses, then
 *              the breaker moves to HALF-OPEN and admits up to `halfOpenMax`
 *              probes.
 *   half-open: probing. A probe success closes it; a probe failure re-opens it
 *              and resets the cooldown.
 *
 * DETERMINISTIC BY DESIGN. Time comes from an injected `now()` (defaults to
 * Date.now), so the state machine is testable without sleeping — the whole
 * point of putting it behind a seam. Timeouts and wrong-script disqualifications
 * both count as failures (design §10.2), but that policy lives in the router;
 * this object only knows success and failure.
 */

/** Default policy knobs (design §10.2). Override per provider if needed. */
export const CIRCUIT_DEFAULTS = Object.freeze({
  threshold: 5,       // failures within the window to trip OPEN
  windowMs: 60_000,   // rolling failure window
  cooldownMs: 30_000, // OPEN duration before a HALF-OPEN probe is allowed
  halfOpenMax: 1      // concurrent probes permitted in HALF-OPEN
})

/**
 * Create a breaker. `now` is injected so the machine is deterministic in tests.
 * Returns a small object; nothing here touches a network or a vendor.
 */
export function createCircuitBreaker (opts = {}) {
  const cfg = { ...CIRCUIT_DEFAULTS, ...opts }
  const now = typeof opts.now === 'function' ? opts.now : Date.now

  let state = 'closed'
  let failures = []      // timestamps inside the rolling window (closed state)
  let openedAt = null    // when we last tripped OPEN
  let probesInFlight = 0 // admitted HALF-OPEN probes not yet resolved

  /** Lazy transition OPEN → HALF-OPEN once the cooldown has elapsed. */
  function refresh () {
    if (state === 'open' && openedAt != null && now() - openedAt >= cfg.cooldownMs) {
      state = 'half-open'
      probesInFlight = 0
    }
  }

  function trip () {
    state = 'open'
    openedAt = now()
    failures = []
    probesInFlight = 0
  }

  return {
    /** Current state, after applying any due cooldown transition. */
    state () { refresh(); return state },

    /**
     * May a request go to this provider right now? Closed: always. Open: no
     * (until cooldown flips it half-open). Half-open: only while probes remain.
     */
    canRequest () {
      refresh()
      if (state === 'closed') return true
      if (state === 'half-open') {
        if (probesInFlight < cfg.halfOpenMax) { probesInFlight += 1; return true }
        return false
      }
      return false // open
    },

    /** Record a successful call. Half-open success closes the breaker. */
    onSuccess () {
      refresh()
      if (state === 'half-open') { state = 'closed'; openedAt = null }
      failures = []
      probesInFlight = 0
      return state
    },

    /**
     * Record a failed call (error, timeout, or wrong-script disqualification).
     * Half-open failure re-opens and resets the cooldown; closed accrues toward
     * the threshold within the window.
     */
    onFailure () {
      refresh()
      if (state === 'half-open') { trip(); return state }
      const t = now()
      failures = failures.filter((ts) => t - ts < cfg.windowMs)
      failures.push(t)
      if (failures.length >= cfg.threshold) trip()
      return state
    },

    /** Rolling snapshot for HealthSnapshot.circuit / observability. NO content. */
    snapshot () {
      refresh()
      return {
        circuit: state,
        openedAt,
        failureCount: state === 'closed' ? failures.length : 0,
        cooldownMs: cfg.cooldownMs,
        threshold: cfg.threshold
      }
    },

    /** Test/ops seam — force back to a clean closed breaker. */
    reset () { state = 'closed'; failures = []; openedAt = null; probesInFlight = 0 }
  }
}

/**
 * A registry of breakers, one per provider id, created on first use. The router
 * reads `get(id).canRequest()` as the `G_circuit` gate and drives success/
 * failure as the chain is walked.
 */
export function createBreakerRegistry (opts = {}) {
  const breakers = new Map()
  const make = () => createCircuitBreaker(opts)
  return {
    get (id) {
      if (!breakers.has(id)) breakers.set(id, make())
      return breakers.get(id)
    },
    has (id) { return breakers.has(id) },
    ids () { return [...breakers.keys()] },
    snapshot () {
      const out = {}
      for (const [id, b] of breakers) out[id] = b.snapshot()
      return out
    },
    clear () { breakers.clear() }
  }
}
