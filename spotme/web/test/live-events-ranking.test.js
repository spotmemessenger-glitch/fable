/**
 * Live Nearby Events ranking — deterministic, transparent, time-aware, blind to
 * people; popularity only when the source supplied it.
 *   node test/live-events-ranking.test.js
 */
import { rankEvents, scoreBreakdown, RANKING_WEIGHTS } from '../src/lib/live-events/ranking.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const e = (id, over = {}) => ({
  id, title: id, category: 'music', lifecycle: 'scheduled',
  startUTC: T0 + HOUR, endUTC: T0 + 3 * HOUR, distanceM: 1000, popularity: null, ...over
})

check('weights are explicit and sum to 1', (() => {
  return Math.abs(Object.values(RANKING_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9
})())

check('DETERMINISTIC: same input → same order', (() => {
  const input = [e('a', { distanceM: 500 }), e('b', { distanceM: 100 }), e('c', { distanceM: 900 })]
  const one = rankEvents(input, { text: '' }, T0).map((r) => r.id).join(',')
  const two = rankEvents(input.slice().reverse(), { text: '' }, T0).map((r) => r.id).join(',')
  return one === two
})())

check('HAPPENING-NOW outranks a far-future upcoming', (() => {
  const now = e('now', { startUTC: T0 - HOUR, endUTC: T0 + HOUR })
  const later = e('later', { startUTC: T0 + 48 * HOUR, endUTC: T0 + 49 * HOUR })
  const out = rankEvents([later, now], { text: '' }, T0)
  return out[0].id === 'now'
})())

check('sooner upcoming outranks later upcoming', (() => {
  const soon = e('soon', { startUTC: T0 + HOUR })
  const far = e('far', { startUTC: T0 + 60 * HOUR })
  const out = rankEvents([far, soon], { text: '' }, T0)
  return out[0].id === 'soon'
})())

check('ENDED sinks below live', (() => {
  const ended = e('ended', { startUTC: T0 - 5 * HOUR, endUTC: T0 - 4 * HOUR })
  const live = e('live', { startUTC: T0 - HOUR, endUTC: T0 + HOUR })
  const out = rankEvents([ended, live], { text: '' }, T0)
  return out[0].id === 'live' && out[1].id === 'ended'
})())

check('closer beats farther at equal time', (() => {
  const near = e('near', { distanceM: 100 })
  const far = e('far', { distanceM: 50000 })
  const out = rankEvents([far, near], { text: '' }, T0)
  return out[0].id === 'near'
})())

check('text relevance lifts a matching event', (() => {
  const match = e('m', { title: 'Blue Jazz Trio', distanceM: 3000 })
  const other = e('o', { title: 'Random Meetup', distanceM: 2900 })
  const out = rankEvents([other, match], { text: 'jazz' }, T0)
  return out[0].id === 'm'
})())

check('popularity contributes ONLY when supplied (null = neutral 0)', (() => {
  const withPop = scoreBreakdown(e('a', { popularity: 1 }), { text: '' }, T0)
  const noPop = scoreBreakdown(e('a', { popularity: null }), { text: '' }, T0)
  return withPop.components.popularity.signal === 1 && noPop.components.popularity.signal === 0 &&
    withPop.score > noPop.score
})())

check('scoreBreakdown exposes every weighted component (transparent)', (() => {
  const { components } = scoreBreakdown(e('a'), { text: '' }, T0)
  return Object.keys(RANKING_WEIGHTS).every((k) => components[k] &&
    typeof components[k].signal === 'number' && components[k].weight === RANKING_WEIGHTS[k])
})())

check('ranking ignores sensitive/unknown fields entirely', (() => {
  const base = scoreBreakdown(e('a'), { text: '' }, T0).score
  const junk = scoreBreakdown({ ...e('a'), gender: 'x', age: 30 }, { text: '' }, T0).score
  return base === junk
})())

check('ties break by id → total stable order', (() => {
  const out = rankEvents([e('z'), e('a')], { text: '' }, T0)
  return out[0].id === 'a' && out[1].id === 'z'
})())

check('inputs are not mutated (pure)', (() => {
  const src = e('a')
  rankEvents([src], { text: '' }, T0)
  return src.score === undefined && src.rankReason === undefined
})())

console.log('\n========== live-events ranking ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
