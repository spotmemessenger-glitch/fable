/**
 * Golden vectors for the computational-photography core: FFT round trips,
 * phase-correlation shift recovery with a PINNED sign convention, Mertens
 * fusion behaviour, and night stacking (noise ↓ √N, alignment, motion
 * rejection). All fixtures are tiny, synthetic and seeded — no camera, no
 * screenshots, numeric assertions only.
 *
 *   node test/camera-algorithms.test.js
 */
import { fft1d, fft2d, isPow2 } from '../src/lib/camera/fft.js'
import { estimateShift, MIN_SHIFT_CONFIDENCE } from '../src/lib/camera/align.js'
import { weightPlane, fuseExposures } from '../src/lib/camera/hdr.js'
import { stackFrames } from '../src/lib/camera/night.js'
import {
  lumaPlane, downscalePlane, shiftImage, shiftPlane, boxBlurPlane, boxBlurImage,
  meanAbsDiff, planeVariance, nextPow2,
} from '../src/lib/camera/imagemath.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/** Deterministic PRNG — every "random" fixture is replayable. */
function mulberry32 (seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function grey (v, width, height, alpha = 255) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = alpha }
  return { data, width, height }
}

/** A structured 64×64 scene: gradient + two rectangles, enough texture for
 *  correlation to lock onto. */
function scene64 () {
  const width = 64; const height = 64
  const image = grey(0, width, height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      let v = 40 + ((x + y) % 32) * 3
      if (x >= 12 && x < 24 && y >= 12 && y < 20) v = 220
      if (x >= 36 && x < 52 && y >= 30 && y < 44) v = 130
      image.data[i] = v; image.data[i + 1] = v; image.data[i + 2] = v
    }
  }
  return image
}

function addNoise (image, sigma, rand) {
  const out = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height }
  for (let i = 0; i < out.data.length; i += 4) {
    // Box–Muller: honest Gaussian noise, deterministic via the seed.
    const n = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()) * sigma
    out.data[i] += n; out.data[i + 1] += n; out.data[i + 2] += n
  }
  return out
}

/* ------------------------------------------------------------ 1. FFT ------ */

check('isPow2 and nextPow2 agree', isPow2(64) && !isPow2(48) && nextPow2(48) === 64 && nextPow2(64) === 64)

check('fft1d of an impulse is flat 1s (the analytic answer)', (() => {
  const re = new Float32Array(8); const im = new Float32Array(8)
  re[0] = 1
  fft1d(re, im)
  return [...re].every((v) => Math.abs(v - 1) < 1e-6) && [...im].every((v) => Math.abs(v) < 1e-6)
})())

check('fft1d of a pure cosine puts its energy in exactly bins k and N−k', (() => {
  const N = 16
  const re = new Float32Array(N); const im = new Float32Array(N)
  for (let x = 0; x < N; x++) re[x] = Math.cos((2 * Math.PI * 3 * x) / N)
  fft1d(re, im)
  const mag = [...re].map((r, i) => Math.hypot(r, im[i]))
  const big = mag.map((m, i) => (m > 1 ? i : -1)).filter((i) => i >= 0)
  return big.join(',') === '3,13' && Math.abs(mag[3] - N / 2) < 1e-4
})())

check('fft2d → inverse fft2d round-trips to the input (1e-5)', (() => {
  const rand = mulberry32(7)
  const N = 16
  const original = new Float32Array(N * N).map(() => rand())
  const re = new Float32Array(original); const im = new Float32Array(N * N)
  fft2d(re, im, N, N)
  fft2d(re, im, N, N, true)
  return original.every((v, i) => Math.abs(v - re[i]) < 1e-5)
})())

check('a non-pow2 size THROWS instead of quietly padding', (() => {
  try { fft1d(new Float32Array(12), new Float32Array(12)); return false } catch { return true }
})())

/* --------------------------------------------- 2. phase correlation ------- */

check('recovers a known (+4,+2) shift — the SIGN CONVENTION pin', (() => {
  const reference = lumaPlane(scene64())
  const moved = shiftPlane(reference, 4, 2)              // content moved +4,+2
  const est = estimateShift(reference, moved)
  return Math.abs(est.dx - 4) <= 1 && Math.abs(est.dy - 2) <= 1 && est.confidence > 0.2
})())

check('recovers a negative shift (−6,−3)', (() => {
  const reference = lumaPlane(scene64())
  const moved = shiftPlane(reference, -6, -3)
  const est = estimateShift(reference, moved)
  return Math.abs(est.dx + 6) <= 1 && Math.abs(est.dy + 3) <= 1
})())

check('zero shift reports ~zero with HIGH confidence', (() => {
  const reference = lumaPlane(scene64())
  const est = estimateShift(reference, reference)
  return Math.abs(est.dx) <= 0.5 && Math.abs(est.dy) <= 0.5 && est.confidence > 0.3
})())

check('shift recovery survives seeded sensor noise (σ=6)', (() => {
  const rand = mulberry32(42)
  const clean = scene64()
  const reference = lumaPlane(addNoise(clean, 6, rand))
  const moved = lumaPlane(addNoise(shiftImage(clean, 3, -2), 6, rand))
  const est = estimateShift(reference, moved)
  return Math.abs(est.dx - 3) <= 1 && Math.abs(est.dy + 2) <= 1
})())

check('a FLAT (textureless) frame gets confidence 0 and zero shift — the texture gate', (() => {
  const structured = lumaPlane(scene64())
  const flat = lumaPlane(grey(128, 64, 64))
  const est = estimateShift(structured, flat)
  const estBoth = estimateShift(flat, flat)
  return est.confidence === 0 && est.dx === 0 && est.dy === 0 && est.flat === true &&
    estBoth.confidence === 0 && estBoth.flat === true
})())

check('two UNRELATED noise fields score BELOW the trust floor — no hallucinated shift', (() => {
  const randA = mulberry32(1)
  const randB = mulberry32(99)
  const a = lumaPlane(addNoise(grey(128, 64, 64), 20, randA))
  const b = lumaPlane(addNoise(grey(128, 64, 64), 20, randB))
  const est = estimateShift(a, b)
  return est.confidence < MIN_SHIFT_CONFIDENCE
})())

/* --------------------------------------------------- 3. HDR fusion -------- */

check('fusing one frame is the identity (fresh buffer)', (() => {
  const image = scene64()
  const fused = fuseExposures([image])
  return fused.available && fused.image.data !== image.data &&
    [...fused.image.data].join(',') === [...image.data].join(',')
})())

check('well-exposedness dominates flat fields: fused mid+dark ≈ leans mid', (() => {
  // Dark frame (20) and mid frame (128): a flat scene has no contrast or
  // saturation signal, so exposedness decides — 128 is near-ideal, 20 poor.
  const dark = grey(20, 16, 16)
  const mid = grey(128, 16, 16)
  const fused = fuseExposures([dark, mid], { blurRadius: 2 })
  const v = fused.image.data[4 * (8 * 16 + 8)]
  return fused.available && v > 100 && v <= 128
})())

check('an over-exposed white field loses to a mid grey the same way', (() => {
  const hot = grey(250, 16, 16)
  const mid = grey(128, 16, 16)
  const fused = fuseExposures([hot, mid], { blurRadius: 2 })
  const v = fused.image.data[4 * (8 * 16 + 8)]
  return v >= 128 && v < 165
})())

check('fusion output stays inside the hull of its inputs (no ringing off bytes)', (() => {
  const rand = mulberry32(5)
  const a = addNoise(scene64(), 10, rand)
  const b = addNoise(scene64(), 10, rand)
  const fused = fuseExposures([a, b], { blurRadius: 4 })
  for (let i = 0; i < fused.image.data.length; i += 4) {
    const low = Math.min(a.data[i], b.data[i]) - 1
    const high = Math.max(a.data[i], b.data[i]) + 1
    if (fused.image.data[i] < low || fused.image.data[i] > high) return false
  }
  return true
})())

check('weightPlane: a mid-grey pixel outweighs a near-black one on exposedness', (() => {
  const w1 = weightPlane(grey(128, 4, 4)).data[5]
  const w2 = weightPlane(grey(10, 4, 4)).data[5]
  return w1 > w2 * 10
})())

check('mismatched geometry is a named refusal', (() => {
  const r = fuseExposures([grey(1, 4, 4), grey(1, 8, 8)])
  return r.available === false && /geometry/.test(r.detail)
})())

/* ------------------------------------------------- 4. night stacking ------ */

check('stacking 8 noisy frames cuts noise variance ≥ 3× (√N law, N=8 → ~8×)', (() => {
  const rand = mulberry32(11)
  const clean = scene64()
  const frames = Array.from({ length: 8 }, () => addNoise(clean, 12, rand))
  const stacked = stackFrames(frames, { motionThreshold: 1 })   // no rejection: pure averaging
  const noiseBefore = planeVariance({ data: residual(frames[1], clean), width: 64, height: 64 })
  const noiseAfter = planeVariance({ data: residual(stacked.image, clean), width: 64, height: 64 })
  return stacked.available && noiseAfter * 3 < noiseBefore
})())

check('shifted frames are ALIGNED before averaging: structure stays sharp', (() => {
  const rand = mulberry32(23)
  const clean = scene64()
  const frames = [
    addNoise(clean, 6, rand),
    addNoise(shiftImage(clean, 3, 1), 6, rand),
    addNoise(shiftImage(clean, -2, 2), 6, rand),
    addNoise(shiftImage(clean, 1, -3), 6, rand),
  ]
  const aligned = stackFrames(frames)
  const unaligned = stackFrames(frames, { maxShiftFraction: 0 })  // alignment path disabled: all dropped
  // Aligned stack must sit closer to the clean scene than any raw shifted frame.
  const err = meanAbsDiff(lumaPlane(aligned.image), lumaPlane(clean))
  const errShifted = meanAbsDiff(lumaPlane(frames[1]), lumaPlane(clean))
  return aligned.available && aligned.framesUsed === 4 && err < errShifted * 0.7 &&
    unaligned.framesUsed === 1
})())

check('…and the detected shifts match the synthetic ground truth', (() => {
  const rand = mulberry32(23)
  const clean = scene64()
  const frames = [addNoise(clean, 6, rand), addNoise(shiftImage(clean, 3, 1), 6, rand)]
  const stacked = stackFrames(frames)
  const applied = stacked.shifts[1].applied
  return Math.abs(applied.dx + 3) <= 1 && Math.abs(applied.dy + 1) <= 1
})())

check('a MOVING OBJECT is rejected: the ghost stays out, the reference wins', (() => {
  const clean = scene64()
  const movedObject = shiftImage(clean, 0, 0)
  // Paint a bright blob at a new place in frames 2..4 (an object moving,
  // camera still — alignment sees ~zero global shift).
  for (const frame of [movedObject]) {
    for (let y = 48; y < 56; y++) {
      for (let x = 4; x < 12; x++) {
        const i = (y * 64 + x) * 4
        frame.data[i] = 255; frame.data[i + 1] = 255; frame.data[i + 2] = 255
      }
    }
  }
  const stacked = stackFrames([clean, movedObject, movedObject, movedObject])
  // Where the blob appeared, the reference pixel value must survive.
  const i = (50 * 64 + 8) * 4
  const referenceValue = clean.data[i]
  const naive = (referenceValue + 255 * 3) / 4
  const got = stacked.image.data[i]
  return stacked.available && Math.abs(got - referenceValue) <= 2 &&
    Math.abs(got - naive) > 40 && stacked.rejectedFraction > 0.005
})())

check('median mode survives one wild outlier frame better than mean would', (() => {
  const base = grey(100, 8, 8)
  const outlier = grey(115, 8, 8)                        // within motion threshold
  const stackedMedian = stackFrames([base, base, base, outlier, base], { mode: 'median', motionThreshold: 1 })
  const stackedMean = stackFrames([base, base, base, outlier, base], { mode: 'mean', motionThreshold: 1 })
  const i = 4 * (3 * 8 + 3)
  return stackedMedian.image.data[i] === 100 && stackedMean.image.data[i] === 103
})())

check('single-frame "stack" is the frame (fresh buffer), reported as 1 used', (() => {
  const image = scene64()
  const stacked = stackFrames([image])
  return stacked.available && stacked.framesUsed === 1 &&
    [...stacked.image.data].join(',') === [...image.data].join(',')
})())

/* --------------------------------------------------- 5. plane helpers ----- */

check('lumaPlane weights: pure green is brighter than pure red than pure blue', (() => {
  const px = (r, g, b) => lumaPlane({ data: new Uint8ClampedArray([r, g, b, 255]), width: 1, height: 1 }).data[0]
  return px(0, 255, 0) > px(255, 0, 0) && px(255, 0, 0) > px(0, 0, 255) &&
    Math.abs(px(255, 255, 255) - 1) < 1e-6
})())

check('downscalePlane preserves the mean (energy-preserving box filter)', (() => {
  const rand = mulberry32(3)
  const plane = { data: new Float32Array(32 * 32).map(() => rand()), width: 32, height: 32 }
  const small = downscalePlane(plane, 8, 8)
  const mean = (p) => [...p.data].reduce((a, b) => a + b, 0) / p.data.length
  return Math.abs(mean(plane) - mean(small)) < 1e-3
})())

check('shiftImage clamps edges — no wraparound ghosts', (() => {
  const image = grey(0, 4, 4)
  image.data[0] = 200                                     // top-left red channel
  const shifted = shiftImage(image, 1, 0)
  // Column 0 clamps to the old column 0: the 200 smears, never wraps to the right edge.
  return shifted.data[4] === 200 && shifted.data[0] === 200 && shifted.data[12] === 0
})())

check('boxBlurPlane preserves a constant field exactly', (() => {
  const plane = { data: new Float32Array(64).fill(0.4), width: 8, height: 8 }
  const blurred = boxBlurPlane(plane, 2)
  return [...blurred.data].every((v) => Math.abs(v - 0.4) < 1e-6)
})())

check('boxBlurImage spreads an impulse and preserves alpha', (() => {
  const image = grey(0, 5, 5)
  image.data[(2 * 5 + 2) * 4] = 255
  const blurred = boxBlurImage(image, 1, 1)
  const centre = blurred.data[(2 * 5 + 2) * 4]
  const side = blurred.data[(2 * 5 + 1) * 4]
  return centre > 0 && centre < 255 && side > 0 && blurred.data[3] === 255
})())

function residual (image, clean) {
  const out = new Float32Array(image.width * image.height)
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = (image.data[i] - clean.data[i]) / 255
  return out
}

console.log('\n========================================')
console.log('  camera algorithms — FFT, alignment, fusion, stacking')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
