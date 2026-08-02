/**
 * Discovery V2 ranking — deterministic, transparent, weight-driven, and blind
 * to anything about a person.
 *
 *   node test/discovery-v2-ranking.test.js
 */
import { rankPlaces, scoreBreakdown, RANKING_WEIGHTS } from '../src/lib/discovery-v2/ranking.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const p = (id, over = {}) => ({ id, name: id, category: 'food', lat: 0, lon: 0, rating: null, distanceM: 1000, ...over })

check('weights are explicit constants that sum to 1', (() => {
  const sum = Object.values(RANKING_WEIGHTS).reduce((a, b) => a + b, 0)
  return Math.abs(sum - 1) < 1e-9
})())

check('DETERMINISTIC: same input → same order', (() => {
  const input = [p('a', { distanceM: 500 }), p('b', { distanceM: 100 }), p('c', { distanceM: 900 })]
  const q = { text: '', category: null }
  const one = rankPlaces(input, q).map((r) => r.id).join(',')
  const two = rankPlaces(input.slice().reverse(), q).map((r) => r.id).join(',')
  return one === two
})())

check('closer places outrank farther ones (proximity weight)', (() => {
  const out = rankPlaces([p('far', { distanceM: 40000 }), p('near', { distanceM: 100 })], { text: '' })
  return out[0].id === 'near'
})())

check('higher rating breaks a proximity tie in the right direction', (() => {
  const out = rankPlaces([p('lo', { distanceM: 1000, rating: 2 }), p('hi', { distanceM: 1000, rating: 5 })], { text: '' })
  return out[0].id === 'hi'
})())

check('text match lifts a query-relevant place', (() => {
  const out = rankPlaces([
    p('coffee', { name: 'Blue Coffee', distanceM: 2000 }),
    p('other', { name: 'Random Shop', distanceM: 1900 })
  ], { text: 'coffee' })
  return out[0].id === 'coffee'
})())

check('ties break by id → a TOTAL, stable order', (() => {
  const identical = [p('z', { distanceM: 1000 }), p('a', { distanceM: 1000 })]
  const out = rankPlaces(identical, { text: '' })
  return out[0].id === 'a' && out[1].id === 'z'
})())

check('scoreBreakdown exposes every weighted component (transparent)', (() => {
  const { components } = scoreBreakdown(p('a', { rating: 4, distanceM: 100 }), { text: '' })
  const keys = Object.keys(RANKING_WEIGHTS)
  return keys.every((k) => components[k] &&
    typeof components[k].signal === 'number' &&
    components[k].weight === RANKING_WEIGHTS[k] &&
    typeof components[k].weighted === 'number')
})())

check('ranking ignores unknown/sensitive fields entirely', (() => {
  // Injecting a "sensitive" attribute must not change the score at all.
  const base = scoreBreakdown(p('a'), { text: '' }).score
  const withJunk = scoreBreakdown({ ...p('a'), gender: 'x', age: 40, ethnicity: 'y' }, { text: '' }).score
  return base === withJunk
})())

check('inputs are not mutated (pure)', (() => {
  const src = p('a')
  rankPlaces([src], { text: '' })
  return src.score === undefined && src.rankReason === undefined
})())

console.log('\n========== discovery-v2 ranking ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
