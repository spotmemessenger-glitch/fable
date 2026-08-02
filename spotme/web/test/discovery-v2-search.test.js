/**
 * Discovery V2 search orchestration — result states, normalisation, dedup,
 * distance-tagging, cancellation/supersede, and the no-fake-providers rule.
 *
 *   node test/discovery-v2-search.test.js
 */
import { createSearch, distanceM } from '../src/lib/discovery-v2/search.js'
import { RESULT_STATE } from '../src/lib/discovery-v2/contracts.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ORIGIN = { lat: 12.9716, lon: 77.5946 }
const provider = (name, places) => ({ name, search: async () => places })
const place = (id, over = {}) => ({ id, name: `p${id}`, lat: 12.98, lon: 77.60, category: 'food', ...over })

async function run () {
  check('NO providers → UNAVAILABLE (never fabricated places)', await (async () => {
    const s = createSearch({ providers: [] })
    const out = await s.run({ text: 'coffee', origin: ORIGIN })
    return out.state === RESULT_STATE.UNAVAILABLE && out.results.length === 0
  })())

  check('a real provider with hits → OK, results distance-tagged & ranked', await (async () => {
    const s = createSearch({ providers: [provider('m', [place('1'), place('2')])] })
    const out = await s.run({ text: 'food', category: 'food', origin: ORIGIN })
    return out.state === RESULT_STATE.OK && out.results.length === 2 &&
      out.results.every((r) => typeof r.distanceM === 'number' && typeof r.score === 'number')
  })())

  check('a provider returning nothing → EMPTY', await (async () => {
    const s = createSearch({ providers: [provider('m', [])] })
    const out = await s.run({ text: 'nothing', origin: ORIGIN })
    return out.state === RESULT_STATE.EMPTY && out.results.length === 0
  })())

  check('one provider errors, one succeeds → PARTIAL', await (async () => {
    const bad = { name: 'bad', search: async () => { throw new Error('boom') } }
    const s = createSearch({ providers: [bad, provider('ok', [place('1')])] })
    const out = await s.run({ text: 'x', origin: ORIGIN })
    // providerErrors accumulates across radius steps (a failing provider is
    // re-tried as the search widens); the point is it's non-zero → PARTIAL.
    return out.state === RESULT_STATE.PARTIAL && out.results.length === 1 && out.providerErrors >= 1
  })())

  check('ALL providers error → FAILED', await (async () => {
    const bad = () => ({ name: 'bad', search: async () => { throw new Error('boom') } })
    const s = createSearch({ providers: [bad(), bad()] })
    const out = await s.run({ text: 'x', origin: ORIGIN })
    return out.state === RESULT_STATE.FAILED && out.results.length === 0
  })())

  check('DEDUPES the same place recurring across widening radii', await (async () => {
    // One provider returns the same place at every radius step; minResults (8)
    // forces the ladder to widen, so the place is seen 5×. It must collapse to 1.
    const s = createSearch({ providers: [provider('a', [place('dup')])] })
    const out = await s.run({ text: 'x', category: 'food', origin: ORIGIN })
    return out.results.length === 1
  })())

  check('two providers each with the SAME providerId stay distinct (id = provider:id)', await (async () => {
    // No accidental cross-provider merge — dedup keys on the composed id.
    const s = createSearch({ providers: [provider('a', [place('x')]), provider('b', [place('x')])] })
    const out = await s.run({ text: 'x', category: 'food', origin: ORIGIN })
    return out.results.length === 2 && out.results.map((r) => r.id).sort().join(',') === 'a:x,b:x'
  })())

  check('a SUPERSEDED (older) run is dropped, not rendered', await (async () => {
    let release
    const gate = new Promise((r) => { release = r })
    const slow = { name: 'slow', search: async () => { await gate; return [place('1')] } }
    const s = createSearch({ providers: [slow] })
    const first = s.run({ text: 'first', origin: ORIGIN }) // will be superseded
    const second = s.run({ text: 'second', origin: ORIGIN }) // bumps epoch
    release()
    const [a] = await Promise.all([first, second])
    return a.state === RESULT_STATE.SUPERSEDED && a.results.length === 0
  })())

  check('distanceM matches a hand haversine (~1.1km for this pair)', (() => {
    const d = distanceM(ORIGIN, { lat: 12.98, lon: 77.60 })
    return d > 1000 && d < 1250
  })())

  check('provider carrying a secret-shaped field is REJECTED loudly', (() => {
    try {
      createSearch({ providers: [{ name: 'leaky', apiKey: 'x', search: async () => [] }] })
      return false
    } catch { return true }
  })())

  console.log('\n========== discovery-v2 search ==========')
  for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  const passed = names.filter((n) => results[n]).length
  console.log(`  ${passed}/${names.length} passed\n`)
  process.exit(passed === names.length ? 0 : 1)
}

run()
