/**
 * The provider circuit breaker — closed → open → half-open (design §10.2).
 *
 * A dead provider must be shed, then probed once after a cooldown, so the router
 * stops choosing it without abandoning it forever. The machine is driven by an
 * INJECTED clock, so every transition is asserted without sleeping — the reason
 * the breaker was built behind a seam in the first place.
 *
 *   node test/translation-circuit-breaker.test.js
 */
import { createCircuitBreaker, createBreakerRegistry, CIRCUIT_DEFAULTS } from '../src/lib/translation/circuit-breaker.js'

const results = {}
const names = []
const check = (name, fn) => {
  names.push(name)
  try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message }
}

/** A breaker with a hand-cranked clock. `clock.t` is "now" in ms. */
function withClock (opts = {}) {
  const clock = { t: 0 }
  const b = createCircuitBreaker({ threshold: 3, windowMs: 1000, cooldownMs: 500, halfOpenMax: 1, now: () => clock.t, ...opts })
  return { b, clock }
}

/* ------------------------------------------------------------- closed ------ */

check('a fresh breaker is closed and admits requests', () => {
  const { b } = withClock()
  return b.state() === 'closed' && b.canRequest() === true
})

check('failures below the threshold keep it closed', () => {
  const { b } = withClock()
  b.onFailure(); b.onFailure() // 2 of 3
  return b.state() === 'closed' && b.canRequest() === true
})

check('a success resets the failure count', () => {
  const { b } = withClock()
  b.onFailure(); b.onFailure()
  b.onSuccess()
  b.onFailure(); b.onFailure() // only 2 since the reset — still closed
  return b.state() === 'closed'
})

check('THE TRIP: threshold failures within the window opens it', () => {
  const { b } = withClock()
  b.onFailure(); b.onFailure(); b.onFailure() // 3 of 3
  return b.state() === 'open' && b.canRequest() === false
})

check('failures OUTSIDE the window do not accumulate toward the threshold', () => {
  const { b, clock } = withClock()
  b.onFailure()            // t=0
  clock.t = 400; b.onFailure()
  clock.t = 1200; b.onFailure() // the first (t=0) has aged out of the 1000ms window
  // only two failures are live in any window, so it must still be closed
  return b.state() === 'closed'
})

/* --------------------------------------------------------- open→half-open -- */

check('OPEN sheds requests until the cooldown elapses', () => {
  const { b, clock } = withClock()
  b.onFailure(); b.onFailure(); b.onFailure()
  clock.t = 400 // still inside the 500ms cooldown
  return b.state() === 'open' && b.canRequest() === false
})

check('after the cooldown it moves to HALF-OPEN and admits one probe', () => {
  const { b, clock } = withClock()
  b.onFailure(); b.onFailure(); b.onFailure()
  clock.t = 500 // cooldown elapsed
  const first = b.canRequest()   // the one permitted probe
  const second = b.canRequest()  // no more probes until this one resolves
  return b.state() === 'half-open' && first === true && second === false
})

/* ------------------------------------------------- half-open resolutions --- */

check('a HALF-OPEN probe SUCCESS closes the breaker', () => {
  const { b, clock } = withClock()
  b.onFailure(); b.onFailure(); b.onFailure()
  clock.t = 500
  b.canRequest()      // take the probe
  b.onSuccess()       // it recovered
  return b.state() === 'closed' && b.canRequest() === true
})

check('a HALF-OPEN probe FAILURE re-opens it and resets the cooldown', () => {
  const { b, clock } = withClock()
  b.onFailure(); b.onFailure(); b.onFailure()
  clock.t = 500
  b.canRequest()
  b.onFailure()       // the probe failed
  const reopenedNow = b.state() // open again immediately
  clock.t = 800       // 300ms into the NEW cooldown — still open
  const stillOpen = b.state()
  clock.t = 1000      // a full cooldown after the re-open
  const halfAgain = b.state()
  return reopenedNow === 'open' && stillOpen === 'open' && halfAgain === 'half-open'
})

/* --------------------------------------------------------- snapshot -------- */

check('snapshot reports the circuit and never any content', () => {
  const { b } = withClock()
  b.onFailure()
  const s = b.snapshot()
  return s.circuit === 'closed' && s.failureCount === 1 &&
    s.threshold === 3 && typeof s.cooldownMs === 'number' &&
    !('text' in s) && !('q' in s)
})

check('defaults match the design: 5 failures / 60s window / 30s cooldown / 1 probe', () =>
  CIRCUIT_DEFAULTS.threshold === 5 && CIRCUIT_DEFAULTS.windowMs === 60_000 &&
  CIRCUIT_DEFAULTS.cooldownMs === 30_000 && CIRCUIT_DEFAULTS.halfOpenMax === 1)

/* --------------------------------------------------------- registry -------- */

check('the breaker registry returns one stable breaker per id', () => {
  const reg = createBreakerRegistry({ threshold: 2 })
  const a1 = reg.get('a'); const a2 = reg.get('a')
  reg.get('b')
  return a1 === a2 && reg.has('a') && reg.ids().sort().join(',') === 'a,b'
})

check('the registry snapshot rolls up each breaker without leaking content', () => {
  const reg = createBreakerRegistry({ threshold: 1 })
  reg.get('x').onFailure() // trips
  const snap = reg.snapshot()
  return snap.x.circuit === 'open' && Object.keys(snap).length === 1
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — circuit breaker')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
