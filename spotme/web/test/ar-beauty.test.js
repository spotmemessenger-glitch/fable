/**
 * Proves beauty TIER 0 is real image math with real limits: the skin
 * classifier classifies, the bilateral smoother smooths NOISE but not
 * EDGES and not non-skin, tone/warmth/brighten do exactly their documented
 * curves, every stage is pure, and every naturalness cap is a hard bound
 * (over-cap params are byte-identical to at-cap).
 *
 *   node test/ar-beauty.test.js
 */
import {
  BEAUTY_LIMITS, skinToneMask, skinSmoothStage, toneWarmthStage, brightenStage,
  toneCurve, beautyTier0Stages,
} from '../src/lib/ar/beauty.js'
import { createPipeline, validateStage } from '../src/lib/camera/pipeline.js'
import { manualClock } from '../src/lib/camera/clock.js'
import { solidImage, skinEdgeImage, columnNoise, SKIN_RGB, SKY_RGB } from './helpers/ar-fixtures.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

/* -------------------------------------------------- 1. skin classifier --- */

{
  const probe = (rgb) => skinToneMask(solidImage(2, 2, rgb)).data[0]
  check('typical skin tone → probability ≈ 1', probe(SKIN_RGB) > 0.95)
  check('deep skin tone (81,52,41) is inside the chroma cluster', probe([81, 52, 41]) > 0.5)
  check('saturated blue (sky) → exactly 0', probe(SKY_RGB) === 0)
  check('saturated green (foliage) → exactly 0', probe([80, 200, 90]) === 0)
  check('near-black is gated out by the shadow ramp', probe([20, 15, 12]) === 0)
  check('the mask is a plane of the image geometry', (() => {
    const m = skinToneMask(solidImage(5, 3, SKIN_RGB))
    return m.width === 5 && m.height === 3 && m.data.length === 15
  })())
}

/* ------------------------------- 2. edge-preserving, skin-masked smooth -- */

{
  const image = skinEdgeImage(48, 32)
  const before = new Uint8ClampedArray(image.data)
  const stage = skinSmoothStage(1)
  const out = stage.cpu(image, stage.params)

  check('smoothing is PURE — the input buffer is untouched', bytesEqual(image.data, before))
  check('noise on skin drops by ≥ 25% at full strength',
    columnNoise(out, 4, 20) < columnNoise(image, 4, 20) * 0.75)

  const edgeX = Math.floor(48 / 2)
  let edgeIntact = true
  for (let y = 0; y < 32; y++) {
    const i = (y * 48 + edgeX) * 4
    if (out.data[i] !== image.data[i] || out.data[i + 1] !== image.data[i + 1] || out.data[i + 2] !== image.data[i + 2]) edgeIntact = false
  }
  check('the hard dark edge is BYTE-IDENTICAL — masked out and range-rejected', edgeIntact)

  const sky = skinEdgeImage(24, 16)
  for (let i = 0; i < sky.data.length; i += 4) { sky.data[i] = SKY_RGB[0]; sky.data[i + 1] = SKY_RGB[1]; sky.data[i + 2] = SKY_RGB[2] }
  const skyOut = stage.cpu(sky, { strength: 1 })
  check('a non-skin image passes through byte-identical (mask 0 everywhere)', bytesEqual(skyOut.data, sky.data))

  const capped = stage.cpu(image, { strength: 1 })
  const overCapped = stage.cpu(image, { strength: 5 })
  check('CAP IS A HARD BOUND: strength 5 is byte-identical to strength 1', bytesEqual(capped.data, overCapped.data))
  check('strength 0 is identity', bytesEqual(stage.cpu(image, { strength: 0 }).data, image.data))
  check('strength 0.5 smooths LESS than 1 (monotone dial)', (() => {
    const half = stage.cpu(image, { strength: 0.5 })
    const nHalf = columnNoise(half, 4, 20)
    return nHalf < columnNoise(image, 4, 20) && nHalf > columnNoise(out, 4, 20)
  })())
}

/* ----------------------------------------------------- 3. tone/warmth ---- */

{
  const gray = solidImage(4, 4, [128, 128, 128])
  const stage = toneWarmthStage(0, 0)
  check('identity params are byte-identity', bytesEqual(stage.cpu(gray, { tone: 0, warmth: 0 }).data, gray.data))

  const warm = stage.cpu(gray, { tone: 0, warmth: 1 })
  check(`warmth +1 shifts R up and B down by exactly the ${BEAUTY_LIMITS.WARMTH_MAX_SHIFT}-unit cap, G untouched`,
    warm.data[0] === 128 + BEAUTY_LIMITS.WARMTH_MAX_SHIFT &&
    warm.data[1] === 128 &&
    warm.data[2] === 128 - BEAUTY_LIMITS.WARMTH_MAX_SHIFT)
  const cool = stage.cpu(gray, { tone: 0, warmth: -1 })
  check('warmth −1 is the mirror', cool.data[0] === 128 - BEAUTY_LIMITS.WARMTH_MAX_SHIFT && cool.data[2] === 128 + BEAUTY_LIMITS.WARMTH_MAX_SHIFT)
  check('warmth over-cap clamps (3 ≡ 1)', bytesEqual(stage.cpu(gray, { tone: 0, warmth: 3 }).data, warm.data))

  const curve = toneCurve(1)
  check('tone +1 is a capped S-curve: shadows darken, highlights lift, midpoint pinned',
    curve[64] < 64 && curve[192] > 192 && Math.abs(curve[128] - 128) <= 1)
  check('tone curve is monotone non-decreasing (no banding inversions)',
    [...curve].every((v, i, a) => i === 0 || v >= a[i - 1]))
  const flat = toneCurve(-1)
  check('tone −1 flattens toward mid-grey by the cap',
    flat[64] === Math.round(64 + BEAUTY_LIMITS.TONE_MAX_BLEND * (128 - 64)) && flat[192] < 192)
  check('tone over-cap clamps (±5 ≡ ±1)',
    bytesEqual(toneCurve(5), toneCurve(1)) && bytesEqual(toneCurve(-5), toneCurve(-1)))
  check('alpha is never touched', (() => {
    const img = solidImage(2, 2, [10, 20, 30, 77])
    return stage.cpu(img, { tone: 0.5, warmth: 0.5 }).data[3] === 77
  })())
}

/* -------------------------------------------------------- 4. brighten ---- */

{
  const stage = brightenStage(1)
  const dark = solidImage(2, 2, [0, 0, 0])
  const bright = solidImage(2, 2, [255, 255, 255])
  const mid = solidImage(2, 2, [100, 100, 100])
  const liftedBlack = stage.cpu(dark, { strength: 1 }).data[0]
  check(`strength 1 lifts black by exactly the ${BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT * 100}% headroom cap`,
    Math.abs(liftedBlack - 255 * BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT) <= 1)
  check('white is untouched (headroom 0 — algebraically clip-free)',
    stage.cpu(bright, { strength: 1 }).data[0] === 255)
  check('midtones lift proportionally to headroom',
    stage.cpu(mid, { strength: 1 }).data[0] === Math.round(100 + BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT * 155))
  check('strength 0 is byte-identity', bytesEqual(stage.cpu(mid, { strength: 0 }).data, mid.data))
  check('over-cap clamps (9 ≡ 1)',
    bytesEqual(stage.cpu(mid, { strength: 9 }).data, stage.cpu(mid, { strength: 1 }).data))
}

/* ------------------------------------- 5. pipeline contract + costs ------ */

{
  check('all three tier-0 stages satisfy the pipeline stage contract',
    beautyTier0Stages().every((s) => validateStage(s) === null))
  check('every tier-0 stage ships a GLSL twin whose uniforms are finite and pre-capped', (() => {
    return beautyTier0Stages({ smooth: 7, tone: 9, warmth: -9, brighten: 7 }).every((s) => {
      if (typeof s.glsl?.fragment !== 'string' || !s.glsl.fragment.includes('#version 300 es')) return false
      const uniforms = s.glsl.uniforms(s.params)
      return Object.values(uniforms).every((v) => Number.isFinite(v)) &&
        Math.abs(uniforms.u_blend ?? 0) <= BEAUTY_LIMITS.SKIN_SMOOTH_MAX_BLEND &&
        Math.abs(uniforms.u_lift ?? 0) <= BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT &&
        Math.abs(uniforms.u_warmth ?? 0) <= BEAUTY_LIMITS.WARMTH_MAX_SHIFT / 255 &&
        Math.abs(uniforms.u_toneBlend ?? 0) <= BEAUTY_LIMITS.TONE_MAX_BLEND
    })
  })())

  const pipeline = createPipeline({})
  for (const stage of beautyTier0Stages({ smooth: 0.6, tone: 0.2, warmth: 0.3, brighten: 0.2 })) {
    pipeline.addStage(stage)
  }
  check('the tier-0 chain mounts on the camera pipeline (CPU mode)', pipeline.stageCount() === 3)

  const image = skinEdgeImage(32, 24)
  const { image: processed, stageCosts } = pipeline.apply(image, {}, manualClock())
  check('PER-STAGE COST is reported for every stage, in order', (
    stageCosts.length === 3 &&
    stageCosts.map((c) => c.name).join(',') === 'beauty-skin-smooth,beauty-tone-warmth,beauty-brighten' &&
    stageCosts.every((c) => typeof c.ms === 'number')
  ))
  check('the chain output is a fresh buffer of the same geometry',
    processed.data !== image.data && processed.width === 32 && processed.height === 24)

  const strong = pipeline.apply(image, { 'beauty-brighten': { strength: 1 } }).image
  check('per-frame overrides reach the stage (brighter than the default run)',
    strong.data[0] >= processed.data[0])
}

/* ------------------------------------------------------------ 6. caps ---- */

check('BEAUTY_LIMITS is frozen — the naturalness policy is not a dial',
  Object.isFrozen(BEAUTY_LIMITS))
check('caps are the documented magnitudes',
  BEAUTY_LIMITS.SKIN_SMOOTH_MAX_BLEND === 0.65 &&
  BEAUTY_LIMITS.WARMTH_MAX_SHIFT === 12 &&
  BEAUTY_LIMITS.TONE_MAX_BLEND === 0.25 &&
  BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT === 0.30)

/* ------------------------------------------------------------- report ---- */

console.log('\n========================================')
console.log('  ar beauty tier 0 — real math, hard natural caps')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
