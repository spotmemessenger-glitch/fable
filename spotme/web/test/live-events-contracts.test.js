/**
 * Live Nearby Events contracts — provider-neutral normalisation, attribution,
 * secret rejection, no invented fields.
 *   node test/live-events-contracts.test.js
 */
import {
  normalizeEvent, isValidEventProvider, assertNoSecrets, RESULT_STATE, EVENT_STATE,
  EVENT_CATEGORY_LIST
} from '../src/lib/live-events/contracts.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const T0 = 1_700_000_000_000

check('RESULT_STATE extends Discovery V2 with LOADING', (() => {
  return RESULT_STATE.LOADING === 'loading' && RESULT_STATE.OK === 'ok' &&
    RESULT_STATE.UNAVAILABLE === 'unavailable' && RESULT_STATE.SUPERSEDED === 'superseded'
})())

check('EVENT_STATE covers upcoming/happening-now/ended/cancelled/postponed', (() => {
  return Boolean(EVENT_STATE.UPCOMING && EVENT_STATE.HAPPENING_NOW && EVENT_STATE.ENDED &&
    EVENT_STATE.CANCELLED && EVENT_STATE.POSTPONED)
})())

check('normalizeEvent builds a stable record with composed id + attribution', (() => {
  const e = normalizeEvent({
    providerId: '42', title: 'Jazz Night', category: 'music',
    startTime: '2023-11-14T20:00:00Z', endTime: '2023-11-14T23:00:00Z',
    timezone: 'Asia/Kolkata', lat: 12.97, lon: 77.59,
    source: 'City Listings', url: 'https://example.org/e/42'
  }, 'listings')
  return e.id === 'listings:42' && e.title === 'Jazz Night' && e.category === 'music' &&
    typeof e.startUTC === 'number' && typeof e.endUTC === 'number' &&
    e.timezone === 'Asia/Kolkata' && e.attribution.source === 'City Listings' &&
    e.attribution.url === 'https://example.org/e/42' && e.attribution.provider === 'listings'
})())

check('ISO and epoch start times both normalise to epoch ms', (() => {
  const iso = normalizeEvent({ providerId: '1', title: 't', startTime: '2023-11-14T20:00:00Z', lat: 1, lon: 1 }, 'p')
  const epoch = normalizeEvent({ providerId: '2', title: 't', startUTC: T0, lat: 1, lon: 1 }, 'p')
  return iso.startUTC === Date.parse('2023-11-14T20:00:00Z') && epoch.startUTC === T0
})())

check('missing id/title/coords → null (no half-built event)', (() => {
  return normalizeEvent({ title: 'x', lat: 1, lon: 1 }, 'p') === null &&
    normalizeEvent({ providerId: '1', lat: 1, lon: 1 }, 'p') === null &&
    normalizeEvent({ providerId: '1', title: 'x' }, 'p') === null
})())

check('unknown category → other; unknown lifecycle → scheduled', (() => {
  const e = normalizeEvent({ providerId: '1', title: 't', category: 'xyz', lifecycle: 'weird', lat: 1, lon: 1 }, 'p')
  return e.category === 'other' && e.lifecycle === 'scheduled' && EVENT_CATEGORY_LIST.includes('music')
})())

check('popularity trusted ONLY as a bounded number; absent → null (never invented)', (() => {
  const withPop = normalizeEvent({ providerId: '1', title: 't', lat: 1, lon: 1, popularity: 1.7 }, 'p')
  const noPop = normalizeEvent({ providerId: '2', title: 't', lat: 1, lon: 1 }, 'p')
  const junkPop = normalizeEvent({ providerId: '3', title: 't', lat: 1, lon: 1, popularity: 'lots' }, 'p')
  return withPop.popularity === 1 && noPop.popularity === null && junkPop.popularity === null
})())

check('raw provider payload does NOT propagate (no smuggled fields)', (() => {
  const e = normalizeEvent({ providerId: '1', title: 't', lat: 1, lon: 1, trackingId: 'abc', _raw: { k: 1 } }, 'p')
  return e.trackingId === undefined && e._raw === undefined
})())

check('cancelled lifecycle is preserved from the source', (() => {
  const e = normalizeEvent({ providerId: '1', title: 't', lat: 1, lon: 1, lifecycle: 'cancelled' }, 'p')
  return e.lifecycle === 'cancelled'
})())

check('isValidEventProvider requires name + searchEvents', (() => {
  return isValidEventProvider({ name: 'p', searchEvents: async () => [] }) &&
    !isValidEventProvider({ name: 'p' }) && !isValidEventProvider({ searchEvents: async () => [] })
})())

check('assertNoSecrets throws on a credential-shaped field', (() => {
  try { assertNoSecrets({ name: 'p', apiKey: 'x' }); return false } catch { return true }
})())

console.log('\n========== live-events contracts ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
