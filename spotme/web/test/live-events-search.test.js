/**
 * Live Nearby Events search — result states, normalisation, dedup, distance,
 * state-derivation, expiry pruning, safety filtering, cancel/supersede, and the
 * no-fake-providers rule. Deterministic via injected `now`.
 *   node test/live-events-search.test.js
 */
import { createEventSearch } from '../src/lib/live-events/search.js'
import { RESULT_STATE, EVENT_STATE } from '../src/lib/live-events/contracts.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const T0 = 1_700_000_000_000
const HOUR = 60 * 60 * 1000
const ORIGIN = { lat: 12.9716, lon: 77.5946 }
const cand = (id, over = {}) => ({
  providerId: id, title: `e${id}`, category: 'music',
  startUTC: T0 + HOUR, endUTC: T0 + 3 * HOUR, lat: 12.98, lon: 77.60, source: 'src', ...over
})
const provider = (name, list) => ({ name, searchEvents: async () => list })

async function run () {
  check('NO providers → UNAVAILABLE (never fabricated events)', await (async () => {
    const s = createEventSearch({ providers: [] })
    const out = await s.run({ text: 'music', origin: ORIGIN }, { now: T0 })
    return out.state === RESULT_STATE.UNAVAILABLE && out.results.length === 0
  })())

  check('real provider with hits → OK; distance-tagged, state-derived, ranked', await (async () => {
    const s = createEventSearch({ providers: [provider('m', [cand('1'), cand('2')])] })
    const out = await s.run({ text: 'music', category: 'music', origin: ORIGIN }, { now: T0 })
    return out.state === RESULT_STATE.OK && out.results.length === 2 &&
      out.results.every((r) => typeof r.distanceM === 'number' && typeof r.score === 'number' &&
        r.state === EVENT_STATE.UPCOMING)
  })())

  check('provider returns nothing → EMPTY', await (async () => {
    const s = createEventSearch({ providers: [provider('m', [])] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.state === RESULT_STATE.EMPTY
  })())

  check('one provider errors, one succeeds → PARTIAL', await (async () => {
    const bad = { name: 'bad', searchEvents: async () => { throw new Error('boom') } }
    const s = createEventSearch({ providers: [bad, provider('ok', [cand('1')])] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.state === RESULT_STATE.PARTIAL && out.results.length === 1 && out.providerErrors >= 1
  })())

  check('all providers error → FAILED', await (async () => {
    const bad = () => ({ name: 'bad', searchEvents: async () => { throw new Error('x') } })
    const s = createEventSearch({ providers: [bad(), bad()] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.state === RESULT_STATE.FAILED
  })())

  check('EXPIRED events are pruned before results are returned', await (async () => {
    const expired = cand('old', { startUTC: T0 - 100 * HOUR, endUTC: T0 - 99 * HOUR })
    const live = cand('live', { startUTC: T0 + HOUR, endUTC: T0 + 2 * HOUR })
    const s = createEventSearch({ providers: [provider('m', [expired, live])] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.results.length === 1 && out.results[0].id === 'm:live'
  })())

  check('BLOCKED source is filtered out of results', await (async () => {
    const s = createEventSearch({
      providers: [provider('m', [cand('1', { source: 'blockedOrg' }), cand('2')])],
      isBlocked: (id) => id === 'blockedOrg'
    })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.results.length === 1 && out.results[0].id === 'm:2'
  })())

  check('DEDUPES the same event recurring across widening radii', await (async () => {
    const s = createEventSearch({ providers: [provider('m', [cand('dup')])] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.results.length === 1
  })())

  check('two providers, same providerId → distinct (id = provider:id)', await (async () => {
    const s = createEventSearch({ providers: [provider('a', [cand('x')]), provider('b', [cand('x')])] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    return out.results.length === 2
  })())

  check('a SUPERSEDED (older) run is dropped, not rendered', await (async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const slow = { name: 'slow', searchEvents: async () => { await gate; return [cand('1')] } }
    const s = createEventSearch({ providers: [slow] })
    const first = s.run({ text: 'first', origin: ORIGIN }, { now: T0 })
    const second = s.run({ text: 'second', origin: ORIGIN }, { now: T0 })
    release()
    const [a] = await Promise.all([first, second])
    return a.state === RESULT_STATE.SUPERSEDED && a.results.length === 0
  })())

  check('provider carrying a secret-shaped field is REJECTED loudly', (() => {
    try {
      createEventSearch({ providers: [{ name: 'leaky', token: 'x', searchEvents: async () => [] }] })
      return false
    } catch { return true }
  })())

  check('the device-local origin never leaks onto a result record', await (async () => {
    const s = createEventSearch({ providers: [provider('m', [cand('1')])] })
    const out = await s.run({ text: 'x', origin: ORIGIN }, { now: T0 })
    const json = JSON.stringify(out.results)
    // The venue coords (12.98/77.60) are public; the ORIGIN coords must not appear.
    return !json.includes(String(ORIGIN.lat)) && !json.includes(String(ORIGIN.lon))
  })())

  console.log('\n========== live-events search ==========')
  for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  const passed = names.filter((n) => results[n]).length
  console.log(`  ${passed}/${names.length} passed\n`)
  process.exit(passed === names.length ? 0 : 1)
}

run()
