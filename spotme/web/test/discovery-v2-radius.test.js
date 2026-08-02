/**
 * Discovery V2 adaptive radius — expansion ladder, min-result stop, cap, dedup,
 * cancellation, and stale-request rejection.
 *
 *   node test/discovery-v2-radius.test.js
 */
import {
  expandingSearch, RADIUS_STEPS_KM, MAX_RADIUS_KM, DEFAULT_MIN_RESULTS,
  AbortError, SupersededError
} from '../src/lib/discovery-v2/radius.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const place = (id, n = 1) => Array.from({ length: n }, (_, i) => ({ id: `${id}-${i}` }))

async function run () {
  check('ladder is 10→15→25→50→100 with a 100km cap',
    JSON.stringify(RADIUS_STEPS_KM) === JSON.stringify([10, 15, 25, 50, 100]) &&
    MAX_RADIUS_KM === 100)

  check('stops at the FIRST radius that clears minResults', await (async () => {
    const seen = []
    const out = await expandingSearch({
      minResults: 3,
      fetchAtRadius: (km) => { seen.push(km); return place('a', 5) }
    })
    return seen.length === 1 && seen[0] === 10 && out.stoppedBy === 'min-results' && out.radiusKm === 10
  })())

  check('EXPANDS through the ladder while under minResults', await (async () => {
    const seen = []
    // each radius adds one NEW result; need 4 → expect to reach the 4th rung
    const out = await expandingSearch({
      minResults: 4,
      fetchAtRadius: (km) => { seen.push(km); return place(`r${km}`, 1) }
    })
    return seen.length === 4 && out.results.length === 4 && out.radiusKm === 50
  })())

  check('CAPS at max radius and reports stoppedBy=max-radius', await (async () => {
    const out = await expandingSearch({
      minResults: 999,
      fetchAtRadius: () => place('x', 1) // never enough
    })
    return out.radiusKm === MAX_RADIUS_KM && out.stoppedBy === 'max-radius' && out.steps === RADIUS_STEPS_KM.length
  })())

  check('DEDUPES results that recur across widening radii', await (async () => {
    // every radius returns the SAME 2 ids → merged stays 2, never enough → cap
    const out = await expandingSearch({
      minResults: 5,
      fetchAtRadius: () => [{ id: 'dup-1' }, { id: 'dup-2' }]
    })
    return out.results.length === 2 && out.stoppedBy === 'max-radius'
  })())

  check('CANCELS on an aborted signal before the next step', await (async () => {
    const ctrl = new AbortController()
    let calls = 0
    try {
      await expandingSearch({
        minResults: 999,
        signal: ctrl.signal,
        fetchAtRadius: () => { calls++; ctrl.abort(); return place('y', 1) }
      })
      return false
    } catch (e) {
      return e instanceof AbortError && calls === 1
    }
  })())

  check('REJECTS a superseded search (newer epoch started)', await (async () => {
    let latest = 5
    try {
      await expandingSearch({
        minResults: 999,
        epoch: 1,
        currentEpoch: () => latest,
        fetchAtRadius: () => place('z', 1)
      })
      return false
    } catch (e) {
      return e instanceof SupersededError
    }
  })())

  check('default min-results constant is a sane positive number',
    typeof DEFAULT_MIN_RESULTS === 'number' && DEFAULT_MIN_RESULTS > 0)

  console.log('\n========== discovery-v2 radius ==========')
  for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  const passed = names.filter((n) => results[n]).length
  console.log(`  ${passed}/${names.length} passed\n`)
  process.exit(passed === names.length ? 0 : 1)
}

run()
