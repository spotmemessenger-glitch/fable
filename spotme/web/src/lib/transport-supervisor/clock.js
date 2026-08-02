/**
 * Spot Me — the INJECTABLE CLOCK the whole adaptive layer runs on. ADR-012b.
 *
 * Every timer, timeout, and "how long has it been?" in this directory goes
 * through one of these objects, never through the globals directly. Two
 * reasons, both load-bearing:
 *
 *   1. DETERMINISM. "Does the supervisor flap under six simulated hours of
 *      jitter?" must be a unit test that runs in milliseconds. That is only
 *      possible if time is a value the test advances, not a wall the test
 *      waits on. `createManualClock` is that value.
 *   2. THE OFF-STATE PROOF. The master flag off means NO timers are
 *      constructed. That claim is testable precisely because construction
 *      goes through an injected clock — the test injects one that throws on
 *      any timer call and proves the factory never touches it.
 *
 * BOUNDED TIMEOUTS EVERYWHERE. `withTimeout` is the one helper every
 * connect/send/drain path wraps its promises in. An adaptive layer that can
 * hang on one transport's dead promise has re-invented the stuck state it
 * exists to escape.
 */

/** The real clock: thin, unmockable pass-throughs to the platform. */
export function createSystemClock () {
  return Object.freeze({
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (t) => clearInterval(t)
  })
}

/**
 * A manual clock for tests and benchmarks. Time moves only when `advance` is
 * called; due timers fire IN DUE ORDER (earliest first, FIFO among equals),
 * and a timer scheduled by a firing timer fires in the same advance if it
 * falls due — which is what makes "simulate six hours" one call.
 */
export function createManualClock (start = 0) {
  let now = start
  let seq = 0
  const timers = new Map()   // id -> { at, fn, everyMs|null, order }

  function schedule (fn, ms, everyMs) {
    if (typeof fn !== 'function') throw new Error('clock: timer fn required')
    const id = ++seq
    const delay = Math.max(0, Number(ms) || 0)
    timers.set(id, { at: now + delay, fn, everyMs: everyMs ?? null, order: seq })
    return id
  }

  function due () {
    let best = null
    for (const [id, t] of timers) {
      if (t.at > now) continue
      if (!best || t.at < best.t.at || (t.at === best.t.at && t.order < best.t.order)) best = { id, t }
    }
    return best
  }

  return Object.freeze({
    now: () => now,
    setTimeout: (fn, ms) => schedule(fn, ms, null),
    clearTimeout: (id) => { timers.delete(id) },
    setInterval: (fn, ms) => schedule(fn, ms, Math.max(1, Number(ms) || 1)),
    clearInterval: (id) => { timers.delete(id) },

    /** Advance by `ms`, firing everything that falls due, in order. */
    advance (ms = 0) {
      const target = now + Math.max(0, ms)
      for (;;) {
        // Move to the earliest due timer at or before target, fire it, repeat.
        let next = null
        for (const [id, t] of timers) {
          if (t.at > target) continue
          if (!next || t.at < next.t.at || (t.at === next.t.at && t.order < next.t.order)) next = { id, t }
        }
        if (!next) break
        now = Math.max(now, next.t.at)
        if (next.t.everyMs != null) next.t.at = now + next.t.everyMs
        else timers.delete(next.id)
        next.t.fn()
      }
      now = target
      return now
    },

    /** Fire everything currently due without moving time (drain at `now`). */
    flush () {
      for (let guard = 0; guard < 10_000; guard++) {
        const d = due()
        if (!d) return
        if (d.t.everyMs != null) d.t.at = now + d.t.everyMs
        else timers.delete(d.id)
        d.t.fn()
      }
      throw new Error('clock: flush did not settle in 10000 firings — a timer re-arms itself at now')
    },

    /** How many timers are armed. The off-state test asserts this stays 0. */
    get pending () { return timers.size }
  })
}

/**
 * Bound a promise. Settles with the promise if it beats `ms`, rejects with a
 * named TimeoutError otherwise. ALWAYS clears its timer — a timeout helper
 * that leaks timers would fail the very discipline it enforces.
 *
 * `label` rides in the error message so a timeout in a log names its victim
 * ("ble connect", "outbox drain") instead of reading as a generic hang.
 */
export function withTimeout (promise, ms, label = 'operation', clock = null) {
  const c = clock || createSystemClock()
  if (!(ms > 0)) return Promise.reject(new Error(`withTimeout: bound for "${label}" must be > 0`))
  let timer = null
  const bounded = new Promise((resolve, reject) => {
    timer = c.setTimeout(() => {
      const err = new Error(`${label} timed out after ${ms}ms`)
      err.name = 'TimeoutError'
      err.timeout = true
      reject(err)
    }, ms)
    Promise.resolve(promise).then(
      (v) => { c.clearTimeout(timer); resolve(v) },
      (e) => { c.clearTimeout(timer); reject(e) }
    )
  })
  return bounded
}
