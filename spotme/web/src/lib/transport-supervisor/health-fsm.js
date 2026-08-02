/**
 * Spot Me — the per-transport CONNECTION-HEALTH state machine. ADR-012b.
 *
 * TransportStatus (ADR-002) answers "what did the lifecycle last do?". The
 * selector needs a different question answered: "how USABLE is this link
 * right now?" — which folds the lifecycle together with the smoothed quality
 * the estimator reports. This FSM is that fold, with one added state the
 * lifecycle does not have: DEGRADED, a link that is up but visibly worsening,
 * still selectable but scoring lower and a candidate for proactive migration.
 *
 * States (WS4 §11.1, made executable):
 *
 *   UNKNOWN ── first sample ──▶ HEALTHY ◀──recovers── DEGRADED
 *      │                          │  ▲                   │
 *      └── unavailable ──▶ UNAVAILABLE  └──worsens───────┘
 *                               ▲  │                     │
 *          (platform absent,    │  └──── comes up        ▼
 *           radio off, flag-    │                      DOWN ◀── lifecycle drop /
 *           gated off)          └────────────────────────┘      loss ≥ hard limit
 *
 * UNAVAILABLE is deliberately distinct from DOWN: DOWN is a link that exists
 * and died (worth probing again soon); UNAVAILABLE is a link this platform or
 * configuration cannot offer at all (Web Bluetooth on iOS, Centrifugo with no
 * broker URL) — probing it on a timer would be battery spent on a fact that
 * cannot change within a session. The BLE adapter's honest iOS answer lands
 * here, not in DOWN.
 *
 * Pure: transitions are driven by `observe()` calls with injected timestamps;
 * every transition is recorded with a machine-readable reason so the
 * supervisor's event log can replay WHY a link was demoted.
 */

export const HEALTH = Object.freeze({
  UNKNOWN: 'unknown',
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  DOWN: 'down',
  UNAVAILABLE: 'unavailable'
})

/** Default thresholds. Data, injectable, so tuning is config not code. */
export const HEALTH_THRESHOLDS = Object.freeze({
  degradedLatencyMs: 800,    // smoothed latency above this ⇒ degraded
  degradedLoss: 0.15,        // smoothed loss above this ⇒ degraded
  downLoss: 0.6,             // smoothed loss above this ⇒ down (effectively dead)
  recoverLatencyMs: 500,     // must come back under BOTH of these to re-earn healthy
  recoverLoss: 0.08,         //   (hysteresis: the demote and promote bars differ
                             //    so a link cannot oscillate on the boundary)
  staleMs: 45_000            // no sample for this long ⇒ the state itself is stale ⇒ unknown
})

/**
 * Create a health tracker for one transport.
 *
 * `observe({ status, quality, unavailableReason, at })` folds a lifecycle
 * status (TransportStatus string), a smoothed quality snapshot (from
 * createQualityEstimator), and an optional hard unavailability into the next
 * state. Any input may be omitted; the fold uses what it is given.
 */
export function createHealthTracker ({ thresholds = HEALTH_THRESHOLDS } = {}) {
  const t = { ...HEALTH_THRESHOLDS, ...thresholds }
  let state = HEALTH.UNKNOWN
  let reason = 'no samples yet'
  let since = 0
  let lastObservedAt = null
  const transitions = []   // bounded log: { at, from, to, reason }
  const LOG_CAP = 64

  function transition (to, why, at) {
    if (to === state) { reason = why; return false }
    transitions.push({ at, from: state, to, reason: why })
    if (transitions.length > LOG_CAP) transitions.shift()
    state = to
    reason = why
    since = at
    return true
  }

  function observe ({ status = null, quality = null, unavailableReason = null, at }) {
    if (typeof at !== 'number') throw new Error('health: at (ms) is required')
    lastObservedAt = at

    // Hard unavailability wins over everything — it is a fact about the
    // platform, not a measurement about the link.
    if (unavailableReason) {
      transition(HEALTH.UNAVAILABLE, `unavailable: ${unavailableReason}`, at)
      return state
    }

    // Lifecycle says the link is not up: that is DOWN regardless of how good
    // the last samples looked — samples describe the past, the status the now.
    if (status && ['failed', 'closed', 'reconnecting'].includes(status)) {
      transition(HEALTH.DOWN, `lifecycle: ${status}`, at)
      return state
    }
    if (status && ['idle', 'connecting'].includes(status) && state === HEALTH.UNKNOWN) {
      // Not yet up, never measured: stay unknown rather than calling it down.
      reason = `lifecycle: ${status}`
      return state
    }

    if (!quality || quality.sampledAt == null) {
      // Connected but never measured: give it healthy-on-probation — the
      // selector's neutral prior does the caution; a link must not be
      // unselectable merely because it is new.
      if (status === 'connected' && state === HEALTH.UNKNOWN) {
        transition(HEALTH.HEALTHY, 'connected, no samples yet (probation)', at)
      }
      return state
    }

    const lat = quality.latencyMs
    const loss = quality.lossKnown ? quality.lossPct : null

    if (loss != null && loss >= t.downLoss) {
      transition(HEALTH.DOWN, `loss ${loss.toFixed(2)} >= ${t.downLoss}`, at)
      return state
    }

    const badLatency = lat != null && lat >= t.degradedLatencyMs
    const badLoss = loss != null && loss >= t.degradedLoss
    if (badLatency || badLoss) {
      transition(HEALTH.DEGRADED,
        badLatency ? `latency ${Math.round(lat)}ms >= ${t.degradedLatencyMs}ms` : `loss ${loss.toFixed(2)} >= ${t.degradedLoss}`, at)
      return state
    }

    // Promotion back to healthy demands the stricter recover bars (hysteresis).
    const okLatency = lat == null || lat <= t.recoverLatencyMs
    const okLoss = loss == null || loss <= t.recoverLoss
    if (okLatency && okLoss) {
      transition(HEALTH.HEALTHY, 'within recover thresholds', at)
    }
    // In the band between degrade and recover: keep whatever state we had.
    return state
  }

  /** Current state, but honest about staleness: a reading nobody has
   *  refreshed in `staleMs` is UNKNOWN again, not confidently healthy. */
  const stateAt = (now = null) => {
    if (now != null && lastObservedAt != null && now - lastObservedAt > t.staleMs) return HEALTH.UNKNOWN
    return state
  }

  return Object.freeze({
    observe,
    state: stateAt,
    reason: () => reason,
    since: () => since,
    /** True iff the selector may offer this transport at all. */
    selectable (now = null) {
      const s = stateAt(now)
      return s === HEALTH.HEALTHY || s === HEALTH.DEGRADED || s === HEALTH.UNKNOWN
    },
    transitions: () => [...transitions]
  })
}
