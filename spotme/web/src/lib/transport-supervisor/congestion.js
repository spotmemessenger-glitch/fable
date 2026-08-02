/**
 * Spot Me — CONGESTION CONTROL + BACKOFF CLASSES for the drain. ADR-012b.
 *
 * The outbox drain must not fire its whole backlog into a link the moment it
 * appears — a reconnect after an hour offline can hold hundreds of envelopes,
 * and a BLE link delivers tens of bytes per event. Two mechanisms, both
 * classical because classical is what is known to converge:
 *
 *   WINDOW (AIMD). At most `window` sends in flight. Every acked send grows
 *   the window additively (+1/window, the TCP congestion-avoidance shape);
 *   every failure or timeout halves it (multiplicative decrease, floor 1).
 *   The window is the drain's speed limit, discovered from the link itself
 *   rather than configured per transport — which is the point: the same
 *   drain code is honest on a gigabit LAN and on a 20-byte-MTU radio.
 *
 *   BACKOFF CLASSES. Not all failures deserve the same patience.
 *     transient  — a timeout, a dropped socket: short exponential backoff
 *                  with jitter (retry soon, the link may be fine).
 *     persistent — transport reports unavailable/disqualified: long backoff
 *                  (retrying a link that says "iOS has no Web Bluetooth"
 *                  every 500 ms is battery arson).
 *   Jitter is ±50 % — a fleet of clients reconnecting after an outage must
 *   not retry in lockstep (the thundering-herd lesson).
 *
 * ADAPTIVE BUFFERING rides on the same signal: `pressure()` folds window
 * utilisation and consecutive failures into 0..1, and the QoS queue's shed
 * valve plus the supervisor's scoring read it. Pure state machine; the clock
 * is only ever read by callers, never here.
 */

export const CONGESTION_DEFAULTS = Object.freeze({
  initialWindow: 4,
  minWindow: 1,
  maxWindow: 64
})

export const BACKOFF_CLASSES = Object.freeze({
  transient: Object.freeze({ baseMs: 500, factor: 2, maxMs: 30_000 }),
  persistent: Object.freeze({ baseMs: 15_000, factor: 2, maxMs: 10 * 60_000 })
})

/**
 * Delay for the `attempt`-th retry (0-based) of the given class, with
 * deterministic-when-injected jitter. `rand` is injectable so tests assert
 * exact schedules; production uses Math.random.
 */
export function backoffDelay (cls, attempt, rand = Math.random) {
  const policy = BACKOFF_CLASSES[cls]
  if (!policy) throw new Error(`backoff: unknown class "${cls}"`)
  const n = Math.max(0, Math.floor(attempt))
  const raw = Math.min(policy.maxMs, policy.baseMs * Math.pow(policy.factor, n))
  const jitter = 0.5 + rand()   // ×0.5 .. ×1.5
  return Math.round(raw * jitter)
}

/**
 * The AIMD controller. One instance per (transport) drain lane.
 */
export function createCongestionController ({ config = {} } = {}) {
  const cfg = { ...CONGESTION_DEFAULTS, ...config }
  if (!(cfg.minWindow >= 1) || !(cfg.maxWindow >= cfg.minWindow)) throw new Error('congestion: bad window bounds')
  let window = Math.min(cfg.maxWindow, Math.max(cfg.minWindow, cfg.initialWindow))
  let inFlight = 0
  let consecutiveFailures = 0
  const counters = { acked: 0, failed: 0, halved: 0 }

  return Object.freeze({
    /** May another send launch right now? */
    canSend () { return inFlight < Math.floor(window) },
    /** A send launched. */
    launched () { inFlight++ },
    /** A send was acknowledged: additive increase. */
    acked () {
      inFlight = Math.max(0, inFlight - 1)
      consecutiveFailures = 0
      window = Math.min(cfg.maxWindow, window + 1 / Math.max(1, Math.floor(window)))
      counters.acked++
    },
    /** A send failed or timed out: multiplicative decrease. */
    failed () {
      inFlight = Math.max(0, inFlight - 1)
      consecutiveFailures++
      window = Math.max(cfg.minWindow, Math.floor(window / 2) || cfg.minWindow)
      counters.failed++
      counters.halved++
    },
    /**
     * 0..1 pressure: how loaded this lane feels. 0 = idle and growing;
     * 1 = window pinned at min with repeated failures. The shed valve and
     * adaptive buffering read this.
     */
    pressure () {
      const utilisation = Math.min(1, inFlight / Math.max(1, Math.floor(window)))
      const failurePressure = Math.min(1, consecutiveFailures / 5)
      const windowPressure = 1 - (window - cfg.minWindow) / Math.max(1, cfg.maxWindow - cfg.minWindow)
      return Math.max(0, Math.min(1, 0.4 * utilisation + 0.35 * failurePressure + 0.25 * windowPressure))
    },
    get window () { return Math.floor(window) },
    get inFlight () { return inFlight },
    get consecutiveFailures () { return consecutiveFailures },
    stats: () => ({ ...counters, window: Math.floor(window), inFlight })
  })
}
