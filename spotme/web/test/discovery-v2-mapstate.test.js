/**
 * Discovery V2 map/result single source of truth — selection and hover are one
 * shared state the map and list both read, and a vanished item can never stay
 * selected.
 *
 *   node test/discovery-v2-mapstate.test.js
 */
import { createMapState } from '../src/lib/discovery-v2/mapstate.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const R = (id, lat = 1, lon = 1) => ({ id, name: id, lat, lon })

check('setResults populates the single store; snapshot is immutable', (() => {
  const s = createMapState()
  s.setResults({ results: [R('a'), R('b')], state: 'ok', radiusKm: 10 })
  const snap = s.snapshot()
  let mutated = false
  try { snap.results.push(R('x')) } catch { mutated = false }
  return snap.results.length === 2 && snap.state === 'ok' && snap.radiusKm === 10 && !mutated
})())

check('selecting a row is the SAME state the map reads (one selectedId)', (() => {
  const s = createMapState()
  s.setResults({ results: [R('a'), R('b')] })
  s.select('b')
  return s.snapshot().selectedId === 'b' && s.selected().id === 'b'
})())

check('selecting recentres the map on that item (map follows selection)', (() => {
  const s = createMapState()
  s.setResults({ results: [R('a', 5, 6)] })
  s.select('a')
  const c = s.snapshot().center
  return c.lat === 5 && c.lon === 6
})())

check('selecting an ABSENT id is ignored (no dangling selection)', (() => {
  const s = createMapState()
  s.setResults({ results: [R('a')] })
  s.select('ghost')
  return s.snapshot().selectedId === null
})())

check('a new result set PRUNES a now-absent selection/hover', (() => {
  const s = createMapState()
  s.setResults({ results: [R('a'), R('b')] })
  s.select('b'); s.hover('a')
  s.setResults({ results: [R('c')] }) // a and b gone
  const snap = s.snapshot()
  return snap.selectedId === null && snap.hoveredId === null
})())

check('subscribers are notified on each mutation with a fresh snapshot', (() => {
  const s = createMapState()
  let count = 0; let last = null
  s.subscribe((snap) => { count++; last = snap })
  s.setResults({ results: [R('a')] })
  s.select('a')
  return count === 2 && last.selectedId === 'a'
})())

check('setView updates centre/zoom through the same store', (() => {
  const s = createMapState()
  s.setView({ lat: 10, lon: 20 }, 16)
  const snap = s.snapshot()
  return snap.center.lat === 10 && snap.center.lon === 20 && snap.zoom === 16
})())

check('hover mirrors select semantics (present-only, shared)', (() => {
  const s = createMapState()
  s.setResults({ results: [R('a')] })
  s.hover('a'); s.hover('absent')
  return s.snapshot().hoveredId === 'a'
})())

console.log('\n========== discovery-v2 mapstate ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
