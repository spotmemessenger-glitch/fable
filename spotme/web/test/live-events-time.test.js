/**
 * Live Nearby Events time — state derivation, source-wins lifecycle, freshness,
 * expiry, stale removal. Deterministic under an injected clock.
 *   node test/live-events-time.test.js
 */
import {
  deriveEventState, withState, isFresh, isExpired, pruneStaleEvents, effectiveEndUTC,
  DEFAULT_EVENT_DURATION_MS, DEFAULT_RETENTION_MS, DEFAULT_TTL_MS
} from '../src/lib/live-events/time.js'
import { EVENT_STATE } from '../src/lib/live-events/contracts.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const ev = (over = {}) => ({ id: 'e', lifecycle: 'scheduled', startUTC: T0, endUTC: T0 + 2 * HOUR, ...over })

check('before start → UPCOMING', deriveEventState(ev(), T0 - HOUR) === EVENT_STATE.UPCOMING)
check('between start and end → HAPPENING_NOW', deriveEventState(ev(), T0 + HOUR) === EVENT_STATE.HAPPENING_NOW)
check('after end → ENDED', deriveEventState(ev(), T0 + 3 * HOUR) === EVENT_STATE.ENDED)

check('SOURCE wins: cancelled stays CANCELLED even mid-window', (() => {
  return deriveEventState(ev({ lifecycle: 'cancelled' }), T0 + HOUR) === EVENT_STATE.CANCELLED
})())
check('SOURCE wins: postponed stays POSTPONED', (() => {
  return deriveEventState(ev({ lifecycle: 'postponed', startUTC: null }), T0) === EVENT_STATE.POSTPONED
})())

check('no end time → happening-now within the default duration, ended after', (() => {
  const e = ev({ endUTC: null })
  const during = deriveEventState(e, T0 + DEFAULT_EVENT_DURATION_MS - 1) === EVENT_STATE.HAPPENING_NOW
  const after = deriveEventState(e, T0 + DEFAULT_EVENT_DURATION_MS + 1) === EVENT_STATE.ENDED
  return during && after && effectiveEndUTC(e) === T0 + DEFAULT_EVENT_DURATION_MS
})())

check('tbd start (scheduled, no start) → UPCOMING', (() => {
  return deriveEventState(ev({ startUTC: null }), T0) === EVENT_STATE.UPCOMING
})())

check('withState attaches derived state without mutating input', (() => {
  const e = ev()
  const tagged = withState(e, T0 + HOUR)
  return tagged.state === EVENT_STATE.HAPPENING_NOW && e.state === undefined
})())

check('isFresh: within TTL true, past TTL false', (() => {
  return isFresh({ fetchedAt: T0 }, T0 + DEFAULT_TTL_MS - 1) === true &&
    isFresh({ fetchedAt: T0 }, T0 + DEFAULT_TTL_MS + 1) === false
})())

check('isExpired: ended + past retention → true; recent-ended → false', (() => {
  const e = ev()
  return isExpired(e, T0 + 2 * HOUR + DEFAULT_RETENTION_MS + 1) === true &&
    isExpired(e, T0 + 2 * HOUR + 1) === false
})())

check('cancelled/postponed are never expired by time', (() => {
  return isExpired(ev({ lifecycle: 'cancelled' }), T0 + 999 * HOUR) === false
})())

check('pruneStaleEvents removes expired, keeps live', (() => {
  const live = ev({ id: 'live', startUTC: T0 + HOUR, endUTC: T0 + 2 * HOUR })
  const gone = ev({ id: 'gone', startUTC: T0 - 10 * HOUR, endUTC: T0 - 9 * HOUR })
  const out = pruneStaleEvents([live, gone], T0)
  return out.length === 1 && out[0].id === 'live'
})())

check('pruneStaleEvents(dropStale) also removes not-fresh records', (() => {
  const stale = ev({ id: 's', fetchedAt: T0 - DEFAULT_TTL_MS - 1 })
  const fresh = ev({ id: 'f', fetchedAt: T0 })
  const out = pruneStaleEvents([stale, fresh], T0, { dropStale: true })
  return out.length === 1 && out[0].id === 'f'
})())

console.log('\n========== live-events time ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
