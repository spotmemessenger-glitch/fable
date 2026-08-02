/**
 * Discovery V2 directions — honesty: no invented ETA, no straight-line masquer-
 * ading as a driving route, explicit unsupported/failed states.
 *
 *   node test/discovery-v2-directions.test.js
 */
import { getDirections, straightLine, DIRECTIONS_STATE } from '../src/lib/discovery-v2/directions.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const FROM = { lat: 12.9716, lon: 77.5946 }
const TO = { lat: 12.98, lon: 77.60 }

async function run () {
  check('NO routing provider → UNSUPPORTED, straight-line only, NO ETA', await (async () => {
    const d = await getDirections(FROM, TO)
    return d.state === DIRECTIONS_STATE.UNSUPPORTED &&
      d.kind === 'straight-line' &&
      typeof d.straightLineM === 'number' &&
      d.durationS === null && d.routeDistanceM === null
  })())

  check('straightLine is explicitly labelled as straight-line distance', (() => {
    const d = straightLine(FROM, TO)
    return d.label === 'straight-line distance' && d.kind === 'straight-line' && d.durationS === null
  })())

  check('a real router with a duration → OK with the REAL ETA', await (async () => {
    const provider = { name: 'r', route: async () => ({ durationS: 600, distanceM: 2500 }) }
    const d = await getDirections(FROM, TO, { provider })
    return d.state === DIRECTIONS_STATE.OK && d.durationS === 600 &&
      d.routeDistanceM === 2500 && d.kind === 'route' && d.label === 'estimated travel time'
  })())

  check('a router that returns NO duration → route with NO invented ETA', await (async () => {
    const provider = { name: 'r', route: async () => ({ distanceM: 2500 }) }
    const d = await getDirections(FROM, TO, { provider })
    return d.state === DIRECTIONS_STATE.OK && d.durationS === null &&
      d.label === 'route (no ETA available)'
  })())

  check('a router that THROWS → FAILED, falls back to honest straight-line', await (async () => {
    const provider = { name: 'r', route: async () => { throw new Error('down') } }
    const d = await getDirections(FROM, TO, { provider })
    return d.state === DIRECTIONS_STATE.FAILED && d.durationS === null && d.kind === 'straight-line'
  })())

  check('straight-line distance is never presented as travel time anywhere', await (async () => {
    const d = await getDirections(FROM, TO)
    // No field on the unsupported result may imply a duration/ETA.
    return !('etaS' in d) && !('drivingM' in d) && d.durationS === null
  })())

  console.log('\n========== discovery-v2 directions ==========')
  for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  const passed = names.filter((n) => results[n]).length
  console.log(`  ${passed}/${names.length} passed\n`)
  process.exit(passed === names.length ? 0 : 1)
}

run()
