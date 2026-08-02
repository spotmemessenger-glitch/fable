/**
 * THE PRIVACY BOUNDARY — proves precise GPS never reaches the public presence
 * path, and that the public position is an honest, bounded, rotating
 * approximation.
 *
 * The load-bearing test is MUTATION-STYLE: if someone restores raw coordinates
 * to publicPositionFor (the single boundary the lobby announces through), the
 * "never equals the precise fix" assertions fail. That is the regression this
 * whole fix exists to prevent.
 *
 *   node test/discovery-privacy.test.js
 */
import {
  approxPublicPosition, publicPositionFor, maxDisplacementM, snapToCell,
  CELL_M, WINDOW_MS, MAX_OFFSET_M,
} from '../src/lib/geo-approx.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

// Local haversine (metres) — the test stays pure and never imports the
// browser-coupled discovery.js. Mirrors discovery.js's distanceM.
function distanceM (a, b) {
  if (a?.lat == null || b?.lat == null || a?.lon == null || b?.lon == null) return null
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLon = ((b.lon - a.lon) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(s)))
}

// A precise fix (somewhere in Bengaluru) and a person id (privacy seed).
const PRECISE = { lat: 12.971598, lon: 77.594566 }
const ID = 'person-abc'
const T0 = 1_700_000_000_000

/* ---------------------------------------------- the approximation itself -- */

check('deterministic: same (lat,lon,id,now) → identical output', (() => {
  const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 })
  const b = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 })
  return a.lat === b.lat && a.lon === b.lon
})())

check('the public point is NEVER the precise fix', (() => {
  const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 })
  return a.lat !== PRECISE.lat && a.lon !== PRECISE.lon && distanceM(PRECISE, a) > 0
})())

check('displacement never exceeds the safe bound', (() => {
  const bound = maxDisplacementM()
  for (let w = 0; w < 48; w++) {
    const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 + w * WINDOW_MS })
    if (distanceM(PRECISE, a) > bound) return false
  }
  return true
})())

check('STABLE within a privacy window (start and just-before-next are equal)', (() => {
  // Align to a window boundary — T0 mid-window would straddle the next window
  // at +WINDOW_MS-1, which correctly (not buggily) rotates the offset.
  const W0 = Math.floor(T0 / WINDOW_MS) * WINDOW_MS
  const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: W0 })
  const b = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: W0 + WINDOW_MS - 1 })
  return a.lat === b.lat && a.lon === b.lon
})())

check('ROTATES across privacy windows (next window differs)', (() => {
  const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 })
  const b = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 + WINDOW_MS })
  return a.lat !== b.lat || a.lon !== b.lon
})())

check('no TELEPORT: consecutive windows drift by a bounded chord (≤ 2×MAX_OFFSET)', (() => {
  let prev = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 })
  for (let w = 1; w < 12; w++) {
    const cur = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 + w * WINDOW_MS })
    if (distanceM(prev, cur) > 2 * MAX_OFFSET_M + 1) return false
    prev = cur
  }
  return true
})())

check('correlation-resistant: two fixes in the same cell share the same coarse centre', (() => {
  // Build a second, distinct fix guaranteed to land in the SAME cell as
  // PRECISE. The lon grid depends on latitude (cosLat), so we hold latitude
  // fixed and nudge only longitude to a fraction of a cell off the shared
  // centre — avoiding both cell-edge and cross-latitude grid flakiness.
  const cell = snapToCell(PRECISE.lat, PRECISE.lon)
  const cosLat = Math.max(0.01, Math.cos((PRECISE.lat * Math.PI) / 180))
  const cellDegLon = CELL_M / (111_320 * cosLat)
  const near = { lat: PRECISE.lat, lon: cell.lon + cellDegLon * 0.2 }
  const sameCell = snapToCell(near.lat, near.lon)
  const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 })
  const b = approxPublicPosition(near.lat, near.lon, { id: ID, now: T0 })
  // Distinct points, same cell ⇒ same base; same window+id ⇒ same offset ⇒
  // identical public output. distanceM confirms they really are metres apart.
  return near.lon !== PRECISE.lon &&
    sameCell.lat === cell.lat && sameCell.lon === cell.lon &&
    a.lat === b.lat && a.lon === b.lon &&
    distanceM(PRECISE, near) > 0 && distanceM(PRECISE, near) < CELL_M
})())

check('averaging many windows converges on the CELL CENTRE, not the true fix', (() => {
  // The core anti-correlation property: over a full rotation the offset cancels,
  // so a long-term average lands on the coarse cell centre — never the home point.
  const cell = snapToCell(PRECISE.lat, PRECISE.lon)
  let sumLat = 0; let sumLon = 0; const N = 60
  for (let w = 0; w < N; w++) {
    const p = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: ID, now: T0 + w * WINDOW_MS })
    sumLat += p.lat; sumLon += p.lon
  }
  const avg = { lat: sumLat / N, lon: sumLon / N }
  // The mean sits at the cell centre (well inside MAX_OFFSET), and that centre
  // is NOT the precise fix.
  return distanceM(avg, cell) < MAX_OFFSET_M &&
    distanceM(avg, PRECISE) > 0 &&
    (cell.lat !== PRECISE.lat || cell.lon !== PRECISE.lon)
})())

check('different people get different approximations for the same fix', (() => {
  const a = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: 'alice', now: T0 })
  const b = approxPublicPosition(PRECISE.lat, PRECISE.lon, { id: 'bob', now: T0 })
  return a.lat !== b.lat || a.lon !== b.lon
})())

check('invalid input yields null (not a leak, not a throw)', (() => {
  return approxPublicPosition(NaN, 10, { id: ID, now: T0 }) === null &&
    approxPublicPosition(10, undefined, { id: ID, now: T0 }) === null &&
    approxPublicPosition(999, 999, { id: ID, now: T0 }) === null
})())

/* -------------------------------------- the live announcement boundary ---- */

check('HIDDEN mode transmits NO coordinates (show=false → null,null)', (() => {
  const out = publicPositionFor(PRECISE, false, ID, T0)
  return out.lat === null && out.lon === null
})())

check('no fix → null,null', (() => {
  const out = publicPositionFor(null, true, ID, T0)
  return out.lat === null && out.lon === null
})())

check('visible mode → APPROXIMATE, never the precise coordinates', (() => {
  const out = publicPositionFor(PRECISE, true, ID, T0)
  return out.lat != null && out.lon != null &&
    out.lat !== PRECISE.lat && out.lon !== PRECISE.lon &&
    distanceM(PRECISE, out) > 0 && distanceM(PRECISE, out) <= maxDisplacementM()
})())

check('MUTATION GUARD: the serialized public model contains no precise coord string', (() => {
  const out = publicPositionFor(PRECISE, true, ID, T0)
  const json = JSON.stringify(out)
  // Restoring raw coords (the exact defect) would put these substrings on the wire.
  return !json.includes(String(PRECISE.lat)) && !json.includes(String(PRECISE.lon))
})())

check('publicPositionFor is deterministic under an injected clock', (() => {
  const a = publicPositionFor(PRECISE, true, ID, T0)
  const b = publicPositionFor(PRECISE, true, ID, T0)
  return a.lat === b.lat && a.lon === b.lon
})())

console.log('\n========================================')
console.log('  discovery privacy — precise GPS stays device-local')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
