/**
 * Spot Me camera — the injectable clock.
 *
 * Every timer, timestamp and timeout in the camera engine flows through one of
 * these objects, for two reasons that are really the same reason:
 *
 *   1. DETERMINISTIC TESTS. Timelapse intervals, burst pacing, recorder caps
 *      and warm-restart timings are all time-driven; a manual clock makes each
 *      of them a pure function of ticks instead of a sleep-and-hope.
 *   2. PROVABLE INERTNESS. The dark-launch factory must arm ZERO timers. The
 *      fence test hands it a clock whose every method throws — the only way
 *      "constructs nothing" is a property rather than a promise.
 *
 * Nothing here reads the wall clock at import time.
 */

/** The real clock. Bound at call time so fake environments can swap the
 *  globals under test without this module caching stale references. */
export function realClock (env = globalThis) {
  return {
    now: () => (env.performance?.now ? env.performance.now() : Date.now()),
    setTimeout: (fn, ms) => env.setTimeout(fn, ms),
    clearTimeout: (id) => env.clearTimeout(id),
    setInterval: (fn, ms) => env.setInterval(fn, ms),
    clearInterval: (id) => env.clearInterval(id),
  }
}

/**
 * A clock advanced by hand. `advance(ms)` runs every timer that falls due, in
 * due order, including timers armed by timers within the same advance — which
 * is exactly how interval-driven capture loops behave in a browser.
 */
export function manualClock (startAt = 0) {
  let t = startAt
  let nextId = 1
  const timers = new Map()      // id → { at, ms, fn, repeat }
  const clock = {
    now: () => t,
    setTimeout (fn, ms = 0) { const id = nextId++; timers.set(id, { at: t + Math.max(0, ms), fn, ms, repeat: false }); return id },
    clearTimeout (id) { timers.delete(id) },
    setInterval (fn, ms = 0) { const id = nextId++; timers.set(id, { at: t + Math.max(1, ms), fn, ms: Math.max(1, ms), repeat: true }); return id },
    clearInterval (id) { timers.delete(id) },
    /** How many timers are currently armed — the inertness assertion. */
    armed: () => timers.size,
    async advance (ms) {
      const until = t + ms
      for (;;) {
        let dueId = null; let dueAt = Infinity
        for (const [id, timer] of timers) {
          if (timer.at <= until && timer.at < dueAt) { dueAt = timer.at; dueId = id }
        }
        if (dueId === null) break
        const timer = timers.get(dueId)
        t = timer.at
        if (timer.repeat) timer.at = t + timer.ms
        else timers.delete(dueId)
        await timer.fn()
      }
      t = until
    },
  }
  return clock
}

/** A clock that proves nothing touched it. Every call is a loud failure. */
export function throwingClock (label = 'inert') {
  const boom = (what) => () => { throw new Error(`${label}: ${what} must never be called`) }
  return {
    now: boom('now'),
    setTimeout: boom('setTimeout'),
    clearTimeout: boom('clearTimeout'),
    setInterval: boom('setInterval'),
    clearInterval: boom('clearInterval'),
  }
}

/** Thrown by `withTimeout` — named so callers can tell "slow" from "broken". */
export class TimeoutError extends Error {
  constructor (label, ms) {
    super(`${label} timed out after ${ms}ms`)
    this.name = 'TimeoutError'
    this.label = label
    this.ms = ms
  }
}

/**
 * Bound a promise. Camera hardware is the least trustworthy dependency this
 * app has — `getUserMedia` can hang forever on a wedged driver — so every
 * hardware wait in the engine goes through here and fails with a NAME.
 * The timer is always cleared; a bounded wait that leaks its own timer would
 * fail the inertness test it exists to support.
 *
 * `onLate` IS NOT OPTIONAL POLISH. Timing out REJECTS, but it cannot cancel:
 * the underlying promise keeps running and may still resolve. For most
 * promises that is harmless. For `getUserMedia` it is a camera left ON with
 * no handle to stop it — the exact failure the release-is-absolute invariant
 * exists to prevent, and the one a user reads as "this app is still watching
 * me". Every hardware wait that RESOLVES TO A RESOURCE must pass a disposer
 * here, so a late arrival is stopped instead of orphaned.
 */
export function withTimeout (promise, ms, label = 'operation', clock = realClock(), onLate = null) {
  return new Promise((resolve, reject) => {
    let done = false
    const id = clock.setTimeout(() => {
      if (done) return
      done = true
      reject(new TimeoutError(label, ms))
    }, ms)
    promise.then(
      (value) => {
        if (done) { try { onLate?.(value) } catch { /* disposer's problem */ } return }
        done = true; clock.clearTimeout(id); resolve(value)
      },
      (err) => { if (done) return; done = true; clock.clearTimeout(id); reject(err) },
    )
  })
}
