/**
 * Live Nearby Events safety — blocking, safety/age filtering, origin-leak guard.
 *   node test/live-events-safety.test.js
 */
import { filterForSafety, assertNoOriginLeak } from '../src/lib/live-events/safety.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const e = (id, over = {}) => ({ id, provider: 'p', attribution: { source: 'src', provider: 'p' }, ...over })

check('blocks an event whose provider is blocked', (() => {
  const out = filterForSafety([e('a', { provider: 'bad' }), e('b')], { isBlocked: (id) => id === 'bad' })
  return out.length === 1 && out[0].id === 'b'
})())

check('blocks by attribution.source', (() => {
  const out = filterForSafety([e('a', { attribution: { source: 'blockedOrg' } }), e('b')],
    { isBlocked: (id) => id === 'blockedOrg' })
  return out.length === 1 && out[0].id === 'b'
})())

check('blocks by organiser id', (() => {
  const out = filterForSafety([e('a', { organiserId: 'x' }), e('b')], { isBlocked: (id) => id === 'x' })
  return out.length === 1 && out[0].id === 'b'
})())

check('removes restricted/unsafe by default', (() => {
  const out = filterForSafety([e('a', { restricted: true }), e('b', { unsafe: true }), e('c')])
  return out.length === 1 && out[0].id === 'c'
})())

check('allowRestricted surfaces age-restricted events', (() => {
  const out = filterForSafety([e('a', { restricted: true })], { allowRestricted: true })
  return out.length === 1
})())

check('no predicate → nothing blocked (but unsafe still removed)', (() => {
  const out = filterForSafety([e('a'), e('b', { unsafe: true })])
  return out.length === 1 && out[0].id === 'a'
})())

check('assertNoOriginLeak passes for clean venue-only events', (() => {
  const origin = { lat: 12.9716, lon: 77.5946 }
  const events = [e('a', { lat: 12.98, lon: 77.60 })]
  try { assertNoOriginLeak(events, origin); return true } catch { return false }
})())

check('assertNoOriginLeak THROWS if the origin is copied onto a record', (() => {
  const origin = { lat: 12.9716, lon: 77.5946 }
  const leaked = [e('a', { originLat: 12.9716, originLon: 77.5946 })]
  try { assertNoOriginLeak(leaked, origin); return false } catch { return true }
})())

check('assertNoOriginLeak THROWS on an origin-shaped field', (() => {
  const leaked = [e('a', { userLat: 1 })]
  try { assertNoOriginLeak(leaked, { lat: 1, lon: 2 }); return false } catch { return true }
})())

console.log('\n========== live-events safety ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
