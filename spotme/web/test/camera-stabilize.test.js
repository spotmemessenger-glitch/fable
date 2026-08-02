/**
 * Proves TIER_BASIC EIS on a synthetic jitter sequence: the displayed path
 * gets measurably smoother, corrections respect the crop margin, low
 * confidence contributes zero, and the advanced tier is honestly deferred.
 *
 *   node test/camera-stabilize.test.js
 */
import {
  createStabilizer, stabilizeFrame, stabilizerStage, stabilizationAvailability, EIS_TIER,
} from '../src/lib/camera/stabilize.js'
import { lumaPlane, shiftImage } from '../src/lib/camera/imagemath.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

function mulberry32 (seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The same textured 64×64 scene the align tests trust. */
function scene64 () {
  const width = 64; const height = 64
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let v = 40 + ((x + y) % 32) * 3
      if (x >= 12 && x < 24 && y >= 12 && y < 20) v = 220
      if (x >= 36 && x < 52 && y >= 30 && y < 44) v = 130
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { data, width, height }
}

/** A hand-shake path: bounded random walk, seeded. */
function jitterPath (steps, seed, amplitude = 2) {
  const rand = mulberry32(seed)
  const path = [{ x: 0, y: 0 }]
  for (let i = 1; i < steps; i++) {
    const prev = path[i - 1]
    const nx = Math.max(-4, Math.min(4, prev.x + Math.round((rand() - 0.5) * 2 * amplitude)))
    const ny = Math.max(-4, Math.min(4, prev.y + Math.round((rand() - 0.5) * 2 * amplitude)))
    path.push({ x: nx, y: ny })
  }
  return path
}

const diffVariance = (series) => {
  const deltas = []
  for (let i = 1; i < series.length; i++) deltas.push(series[i] - series[i - 1])
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length
  return deltas.reduce((a, d) => a + (d - mean) ** 2, 0) / deltas.length
}

/* ------------------------------------------------------- 1. the tiers ----- */

check('TIER_BASIC is available; TIER_ADVANCED is DEFERRED_NATIVE naming the gyro gap', (() => {
  const basic = stabilizationAvailability(EIS_TIER.BASIC)
  const advanced = stabilizationAvailability(EIS_TIER.ADVANCED)
  return basic.available && basic.tier === EIS_TIER.BASIC &&
    advanced.available === false && advanced.reason === CAMERA_UNAVAILABLE.DEFERRED_NATIVE &&
    /IMU|gyro/i.test(advanced.detail)
})())

/* ------------------------------------------- 2. the jitter benchmark ------ */

check('a 40-frame synthetic hand-shake: DISPLAYED path is ≥3× smoother than the camera path', (() => {
  const clean = scene64()
  const path = jitterPath(40, 1234)
  const stabilizer = createStabilizer()
  const displayedX = []
  const displayedY = []
  for (const p of path) {
    const frame = shiftImage(clean, p.x, p.y)
    const correction = stabilizer.feed(lumaPlane(frame))
    displayedX.push(p.x + correction.dx)
    displayedY.push(p.y + correction.dy)
  }
  const rawVar = diffVariance(path.map((p) => p.x)) + diffVariance(path.map((p) => p.y))
  const outVar = diffVariance(displayedX) + diffVariance(displayedY)
  return outVar * 3 < rawVar
})())

check('a STILL camera produces zero corrections — the stabilizer invents no motion', (() => {
  const clean = scene64()
  const stabilizer = createStabilizer()
  let maxCorrection = 0
  for (let i = 0; i < 10; i++) {
    const c = stabilizer.feed(lumaPlane(clean))
    maxCorrection = Math.max(maxCorrection, Math.abs(c.dx), Math.abs(c.dy))
  }
  return maxCorrection < 0.75
})())

check('corrections NEVER exceed the crop margin, and clamping is reported', (() => {
  const clean = scene64()
  const stabilizer = createStabilizer({ cropMargin: 0.05, smoothing: 0.98 })
  // A sustained pan: the smoothed path lags far behind, demanding huge
  // corrections the margin must clip.
  let sawClamp = false
  let withinBounds = true
  for (let i = 0; i < 12; i++) {
    const frame = shiftImage(clean, i * 3, 0)
    const c = stabilizer.feed(lumaPlane(frame))
    if (c.clamped) sawClamp = true
    if (Math.abs(c.dx) > 64 * 0.05 + 1e-9 || Math.abs(c.dy) > 64 * 0.05 + 1e-9) withinBounds = false
  }
  return sawClamp && withinBounds && stabilizer.state().clampedCount > 0
})())

check('an untexturable frame (flat grey) contributes ZERO delta — low confidence is distrusted', (() => {
  const clean = scene64()
  const flat = { data: new Uint8ClampedArray(64 * 64 * 4).fill(128), width: 64, height: 64 }
  const stabilizer = createStabilizer()
  stabilizer.feed(lumaPlane(clean))
  stabilizer.feed(lumaPlane(flat))                       // structure → flat: garbage estimate
  const pathAfterFlat = { ...stabilizer.state().path }
  return Math.abs(pathAfterFlat.x) < 0.01 && Math.abs(pathAfterFlat.y) < 0.01
})())

check('reset() forgets the take', (() => {
  const stabilizer = createStabilizer()
  stabilizer.feed(lumaPlane(scene64()))
  stabilizer.feed(lumaPlane(shiftImage(scene64(), 4, 0)))
  stabilizer.reset()
  const s = stabilizer.state()
  return s.frames === 0 && s.path.x === 0 && s.smooth.x === 0
})())

/* ------------------------------------------------- 3. frame application --- */

check('stabilizeFrame: fixed centre crop, constant geometry, correct pixel mapping', (() => {
  const image = scene64()
  const out = stabilizeFrame(image, { dx: 0, dy: 0 }, 0.125)   // margin 8px
  if (out.width !== 48 || out.height !== 48) return false
  // Output (0,0) must equal input (8,8).
  const src = (8 * 64 + 8) * 4
  return out.data[0] === image.data[src] && out.data[1] === image.data[src + 1]
})())

check('…and a (+3,+2) correction shifts content into the crop as expected', (() => {
  const image = scene64()
  const out = stabilizeFrame(image, { dx: 3, dy: 2 }, 0.125)
  // Shift moves content right/down by (3,2): output (0,0) = shifted (8,8)
  // = original (8−3, 8−2) = (5,6).
  const src = (6 * 64 + 5) * 4
  return out.data[0] === image.data[src]
})())

check('the pipeline-stage form stabilizes a jitter sequence with CONSTANT output geometry', (() => {
  const clean = scene64()
  const stage = stabilizerStage(createStabilizer(), { cropMargin: 0.1 })
  const path = jitterPath(8, 77)
  let constantGeometry = true
  for (const p of path) {
    const out = stage.cpu(shiftImage(clean, p.x, p.y), stage.params)
    if (out.width !== 52 || out.height !== 52) constantGeometry = false
  }
  return constantGeometry
})())

console.log('\n========================================')
console.log('  stabilization — TIER_BASIC EIS, measured, clamped, honest')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
