/**
 * Discovery V2 people markers — the privacy boundary on the map: approximate
 * only, hidden/ghost withheld, blocked filtered, no precise coordinate
 * recoverable from a marker.
 *
 *   node test/discovery-v2-people.test.js
 */
import { toPeopleMarkers, assertNoPreciseLeak } from '../src/lib/discovery-v2/people.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

// Approximate public announcements (as they'd arrive from the lobby).
const ann = (id, over = {}) => ({ id, name: id, lat: 12.9716, lon: 77.5946, ghost: false, ...over })

check('a visible person → exactly one approximate marker', (() => {
  const m = toPeopleMarkers([ann('alice')])
  return m.length === 1 && m[0].id === 'alice' && m[0].approximate === true
})())

check('GHOST/hidden person → NO marker, NO coordinates', (() => {
  const m = toPeopleMarkers([ann('ghosty', { ghost: true })])
  return m.length === 0
})())

check('person with null position → NO marker', (() => {
  const m = toPeopleMarkers([ann('nopos', { lat: null, lon: null })])
  return m.length === 0
})())

check('BLOCKED person is filtered out', (() => {
  const m = toPeopleMarkers([ann('a'), ann('b')], { isBlocked: (id) => id === 'b' })
  return m.length === 1 && m[0].id === 'a'
})())

check('self is excluded from the markers', (() => {
  const m = toPeopleMarkers([ann('me'), ann('you')], { selfId: 'me' })
  return m.length === 1 && m[0].id === 'you'
})())

check('every positioned marker is flagged approximate=true', (() => {
  const m = toPeopleMarkers([ann('a'), ann('b')])
  return m.every((x) => x.approximate === true)
})())

check('markers carry ONLY whitelisted fields — no smuggled data', (() => {
  const m = toPeopleMarkers([ann('a', { preciseLat: 12.999999, secretHome: 'x', ts: 1 })])
  const keys = Object.keys(m[0]).sort().join(',')
  return keys === 'approximate,id,lat,lon,name' // no preciseLat/secretHome/ts
})())

check('MUTATION GUARD: no precise fix string survives into markers', (() => {
  // The announcement is already approximate; a precise fix must not be present.
  const precise = { lat: 12.971598, lon: 77.594566 }
  const m = toPeopleMarkers([ann('a', { lat: 12.9713, lon: 77.5942 })])
  try { assertNoPreciseLeak(m, [precise]); return true } catch { return false }
})())

check('assertNoPreciseLeak THROWS if a precise coord is present', (() => {
  const precise = { lat: 12.971598, lon: 77.594566 }
  const leaked = [{ id: 'x', lat: 12.971598, lon: 77.594566, approximate: true }]
  try { assertNoPreciseLeak(leaked, [precise]); return false } catch { return true }
})())

check('assertNoPreciseLeak THROWS on a precise-looking extra field', (() => {
  const leaked = [{ id: 'x', lat: 12.97, lon: 77.59, approximate: true, gpsExact: 12.9 }]
  try { assertNoPreciseLeak(leaked); return false } catch { return true }
})())

check('accuracyM (the honest displacement bound) is surfaced when given', (() => {
  const m = toPeopleMarkers([ann('a')], { maxDisplacementM: 503 })
  return m[0].accuracyM === 503
})())

console.log('\n========== discovery-v2 people ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
