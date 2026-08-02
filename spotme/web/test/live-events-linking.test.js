/**
 * Live Nearby Events linking — event→place/marker/directions, on the honest
 * Discovery V2 primitives, and the shared map store.
 *   node test/live-events-linking.test.js
 */
import { eventPlace, eventMapMarker, eventDirections, selectEventOnMap } from '../src/lib/live-events/linking.js'
import { createMapState } from '../src/lib/discovery-v2/mapstate.js'
import { DIRECTIONS_STATE } from '../src/lib/discovery-v2/directions.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const EV = { id: 'p:1', provider: 'p', title: 'Show', category: 'music', lat: 12.98, lon: 77.60, state: 'upcoming', distanceM: 1200 }

async function run () {
  check('eventPlace returns the embedded normalised place when present', (() => {
    const place = { id: 'p:v', provider: 'p', name: 'Hall', lat: 1, lon: 2, category: 'other', address: null, rating: null, distanceM: null, raw: {} }
    return eventPlace({ ...EV, place }).id === 'p:v'
  })())

  check('eventPlace synthesizes a place from coords when none embedded', (() => {
    const p = eventPlace(EV)
    return p.lat === 12.98 && p.lon === 77.60 && p.name === 'Show' && p.id === 'p:1:venue'
  })())

  check('eventMapMarker carries id/coords/title/state — no user data', (() => {
    const m = eventMapMarker(EV)
    const keys = Object.keys(m).sort().join(',')
    return keys === 'category,id,lat,lon,state,title' && m.id === 'p:1'
  })())

  check('eventMapMarker is null without coordinates', (() => {
    return eventMapMarker({ id: 'x', title: 't' }) === null
  })())

  check('directions with NO router → honest straight-line, no invented ETA', await (async () => {
    const d = await eventDirections(EV, { lat: 12.97, lon: 77.59 })
    return d.state === DIRECTIONS_STATE.UNSUPPORTED && d.durationS === null && d.kind === 'straight-line'
  })())

  check('directions with a router → real ETA passed through', await (async () => {
    const provider = { name: 'r', route: async () => ({ durationS: 480, distanceM: 1500 }) }
    const d = await eventDirections(EV, { lat: 12.97, lon: 77.59 }, { provider })
    return d.state === DIRECTIONS_STATE.OK && d.durationS === 480
  })())

  check('selectEventOnMap drives the SHARED Discovery V2 store', (() => {
    const map = createMapState()
    map.setResults({ results: [{ id: 'p:1', lat: 12.98, lon: 77.60 }] })
    selectEventOnMap(map, EV)
    return map.snapshot().selectedId === 'p:1' && map.snapshot().center.lat === 12.98
  })())

  console.log('\n========== live-events linking ==========')
  for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  const passed = names.filter((n) => results[n]).length
  console.log(`  ${passed}/${names.length} passed\n`)
  process.exit(passed === names.length ? 0 : 1)
}

run()
