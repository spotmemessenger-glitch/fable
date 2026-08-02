/**
 * Spot Me — the transport MONITOR: continuous, passive-first sampling. ADR-012b.
 *
 * One loop, one clock, one job: keep a fresh, SMOOTHED picture of every
 * registered transport so the supervisor's ranking runs on estimates rather
 * than single readings. Each tick it asks every transport for its cheap
 * synchronous signals — `quality()`, `costSignal()`, `status()` — feeds the
 * quality estimator, folds the result through the health FSM, and (at a lower
 * cadence) runs the degradation prediction.
 *
 * PASSIVE FIRST, BY DESIGN. `quality()` is a read of what the transport
 * already knows from carrying real traffic — no probe frames, no pings
 * manufactured just to be measured. Active probing costs battery and radio
 * time, which is exactly the budget the adaptive layer is supposed to
 * conserve; a transport that wants richer numbers samples its own real
 * operations (the adapters do). The monitor's own cost is bounded: O(n)
 * synchronous calls per tick, no allocation beyond the snapshots.
 *
 * A MISBEHAVING TRANSPORT CANNOT KILL THE LOOP. Every per-transport read is
 * wrapped; a throw becomes a recorded observation failure (which the health
 * FSM sees as DOWN via lifecycle), never an exception out of the tick. The
 * one thing worse than a broken transport is a broken monitor that stops
 * watching the healthy ones.
 *
 * The clock is injected; `start()` arms one interval and `stop()` disarms it.
 * Nothing is armed at construction — the off-state factory proof depends on
 * construction being timer-free.
 */
import { createQualityEstimator } from './ewma.js'
import { createHealthTracker } from './health-fsm.js'

/** Defaults. Data, injectable. */
export const MONITOR_DEFAULTS = Object.freeze({
  tickMs: 2_000,           // sampling cadence
  predictEveryTicks: 3,    // prediction cadence (multiple of ticks; it costs a fit)
  horizonMs: 10_000,       // how far ahead prediction projects
  latencyCeilingMs: 1500,  // projected latency at/over this ⇒ degrading
  lossCeiling: 0.5         // projected loss at/over this ⇒ degrading
})

export function createMonitor ({ registry, clock, config = {}, thresholds = undefined } = {}) {
  if (!registry) throw new Error('monitor: registry required')
  if (!clock) throw new Error('monitor: clock required')
  const cfg = { ...MONITOR_DEFAULTS, ...config }

  // name -> { estimator, health, lastCost, lastStatus, lastError, prediction }
  const perTransport = new Map()
  let interval = null
  let ticks = 0
  const listeners = new Set()

  function laneFor (name) {
    let lane = perTransport.get(name)
    if (!lane) {
      lane = {
        estimator: createQualityEstimator(),
        health: createHealthTracker(thresholds ? { thresholds } : {}),
        lastCost: null,
        lastStatus: null,
        lastError: null,
        prediction: null
      }
      perTransport.set(name, lane)
    }
    return lane
  }

  /** One observation of one transport. Never throws. */
  function observe (entry, now, runPrediction) {
    const lane = laneFor(entry.name)
    const t = entry.transport
    if (!t) {
      // Registered capabilities without a live transport object: nothing to
      // sample; health stays whatever it was (UNKNOWN until wiring provides one).
      return
    }
    try {
      const status = t.status()
      const q = t.quality()
      lane.lastStatus = status
      lane.lastCost = t.costSignal()
      lane.lastError = null

      // Feed the estimator only with actual measurements — a null latency is
      // "no reading", not "0ms".
      if (q && typeof q.latencyMs === 'number') lane.estimator.pushLatency(q.latencyMs, now)
      if (q && typeof q.throughputKbps === 'number' && q.throughputKbps != null) lane.estimator.pushBandwidth(q.throughputKbps, now)
      // Raw lossPct from the transport is itself an observation of recent
      // sends; treat >0 as fractional failures by pushing weighted outcomes is
      // over-modelling — instead adapters report outcomes via reportOutcome(),
      // and quality().lossPct is used directly only when the estimator has no
      // outcome samples of its own (bootstrap honesty).

      const unavailableReason = q && q.connected === false && status === 'failed' && t.unavailableReason
        ? t.unavailableReason()
        : (typeof t.unavailableReason === 'function' ? t.unavailableReason() : null)

      lane.health.observe({
        status,
        quality: lane.estimator.snapshot(),
        unavailableReason: unavailableReason || null,
        at: now
      })

      if (runPrediction) {
        lane.prediction = lane.estimator.predict({
          now, horizonMs: cfg.horizonMs, latencyCeilingMs: cfg.latencyCeilingMs, lossCeiling: cfg.lossCeiling
        })
      }
    } catch (err) {
      lane.lastError = String(err?.message || err)
      lane.health.observe({ status: 'failed', at: now })
    }
  }

  function tick () {
    const now = clock.now()
    ticks++
    const runPrediction = ticks % cfg.predictEveryTicks === 0
    for (const entry of registry.list()) observe(entry, now, runPrediction)
    const snap = snapshot(now)
    for (const fn of listeners) {
      try { fn(snap) } catch { /* a listener must not kill the loop */ }
    }
    return snap
  }

  /**
   * Adapters push real send outcomes here (delivered / failed / rtt), so the
   * loss and latency estimates are grounded in traffic that actually happened
   * rather than in synthetic probes.
   */
  function reportOutcome (name, { delivered, rttMs = null }) {
    const lane = laneFor(name)
    const now = clock.now()
    lane.estimator.pushOutcome(delivered === true, now)
    if (typeof rttMs === 'number' && Number.isFinite(rttMs)) lane.estimator.pushLatency(rttMs, now)
  }

  /** The full smoothed picture, per transport, at `now`. */
  function snapshot (now = clock.now()) {
    const out = {}
    for (const [name, lane] of perTransport) {
      out[name] = Object.freeze({
        quality: lane.estimator.snapshot(),
        health: lane.health.state(now),
        healthReason: lane.health.reason(),
        selectable: lane.health.selectable(now),
        status: lane.lastStatus,
        cost: lane.lastCost,
        prediction: lane.prediction,
        lastError: lane.lastError
      })
    }
    return Object.freeze({ at: now, transports: Object.freeze(out) })
  }

  return Object.freeze({
    start () {
      if (interval != null) return
      interval = clock.setInterval(tick, cfg.tickMs)
    },
    stop () {
      if (interval == null) return
      clock.clearInterval(interval)
      interval = null
    },
    /** One synchronous tick on demand (tests, and the supervisor's forced re-check). */
    tick,
    reportOutcome,
    snapshot,
    onSample (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    get running () { return interval != null },
    get tickCount () { return ticks },
    config: Object.freeze({ ...cfg })
  })
}
