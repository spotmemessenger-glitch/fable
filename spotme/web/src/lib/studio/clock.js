/**
 * Spot Me — Creative Studio clock. Small and injectable, because time is an
 * input: draft TTLs, LRU ordering and composer timestamps must be testable
 * without sleeping, and an inert studio must schedule NOTHING (the fence test
 * hands createStudio() a throwing clock and expects silence).
 */

/** The real clock. `now()` is wall time in ms; timers are the host's. */
export function systemClock () {
  return {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id)
  }
}

/**
 * A hand-cranked clock for tests: `advance(ms)` runs due timers in order.
 * Deliberately minimal — no intervals, because the studio never uses any
 * (a periodic timer in a dark module would be a background cost nobody asked
 * for; everything here is demand-driven).
 */
export function manualClock (start = 0) {
  let now = start
  let seq = 0
  const timers = new Map()   // id → {at, fn}
  return {
    now: () => now,
    setTimeout (fn, ms) {
      const id = ++seq
      timers.set(id, { at: now + Math.max(0, Number(ms) || 0), fn })
      return id
    },
    clearTimeout (id) { timers.delete(id) },
    advance (ms) {
      const until = now + Math.max(0, Number(ms) || 0)
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, t] of timers) {
          if (t.at <= until && t.at < nextAt) { nextAt = t.at; nextId = id }
        }
        if (nextId === null) break
        const { fn } = timers.get(nextId)
        timers.delete(nextId)
        now = nextAt
        fn()
      }
      now = until
    },
    pending: () => timers.size
  }
}

/** A clock that proves it was never consulted. Used by the inertness tests. */
export function throwingClock (label = 'studio is dark') {
  const boom = () => { throw new Error(`clock used while ${label}`) }
  return { now: boom, setTimeout: boom, clearTimeout: boom }
}
