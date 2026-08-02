/**
 * Proves the processing pipeline: ordered pure stages, zero-stage
 * passthrough that returns the SAME object, honest refusal of GL-only
 * stages in CPU mode, and golden vectors for both reference stages.
 *
 *   node test/camera-pipeline.test.js
 */
import { createPipeline, validateStage, cloneImage } from '../src/lib/camera/pipeline.js'
import { exposureGainStage, lutStage, gammaLut, identityLut, packLutTexture } from '../src/lib/camera/stages.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { manualClock } from '../src/lib/camera/clock.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/** A 2×2 RGBA test card: black, mid grey, saturated red, white. */
function testCard () {
  return {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      0, 0, 0, 255, /*   */ 100, 100, 100, 200,
      200, 0, 0, 255, /* */ 255, 255, 255, 255,
    ]),
  }
}

/* ------------------------------------------------------- 1. contract ------ */

check('zero stages = passthrough, SAME object, zero cost', (() => {
  const p = createPipeline({})
  const image = testCard()
  const out = p.apply(image)
  return out.image === image && out.stageCosts.length === 0 && p.mode() === 'cpu'
})())

check('stage validation names each defect', (() => {
  return validateStage(null) !== null &&
    validateStage({}) !== null &&
    validateStage({ name: 'x' }) !== null &&
    validateStage({ name: 'x', cpu: () => {} }) === null &&
    validateStage({ name: 'x', glsl: { fragment: 'f' } }) !== null &&      // uniforms missing
    validateStage({ name: 'x', glsl: { fragment: 'f', uniforms: () => ({}) } }) === null
})())

check('stages run IN ORDER — gain then gamma differs from gamma then gain', (() => {
  const a = createPipeline({})
  a.addStage(exposureGainStage(1))
  a.addStage(lutStage(gammaLut(2.2)))
  const b = createPipeline({})
  b.addStage(lutStage(gammaLut(2.2)))
  b.addStage(exposureGainStage(1))
  const outA = a.apply(testCard()).image.data
  const outB = b.apply(testCard()).image.data
  // Pixel (100): a = gamma(200) = 149, b = 2×gamma(100) = 66. Order matters.
  return outA[4] === 149 && outB[4] === 66 && outA[4] !== outB[4]
})())

check('duplicate stage names are refused', (() => {
  const p = createPipeline({})
  p.addStage(exposureGainStage(1))
  const again = p.addStage(exposureGainStage(2))
  return again.available === false && /duplicate/.test(again.detail)
})())

check('a GL-ONLY stage in CPU mode is REFUSED with NO_WEBGL2 — never silently skipped', (() => {
  const p = createPipeline({})
  const refused = p.addStage({ name: 'gl-only', glsl: { fragment: 'void main(){}', uniforms: () => ({}) } })
  return refused.available === false && refused.reason === CAMERA_UNAVAILABLE.NO_WEBGL2 &&
    p.stageCount() === 0
})())

check('runGl in CPU mode refuses instead of pretending', (() => {
  const p = createPipeline({})
  const r = p.runGl({})
  return r.available === false && r.reason === CAMERA_UNAVAILABLE.NO_WEBGL2
})())

check('removeStage removes; removing a stranger is a named failure', (() => {
  const p = createPipeline({})
  p.addStage(exposureGainStage(1))
  const gone = p.removeStage('exposure-gain')
  const stranger = p.removeStage('nope')
  return gone.available && p.stageCount() === 0 && stranger.available === false
})())

check('apply with a clock reports per-stage cost', (() => {
  const p = createPipeline({})
  p.addStage(exposureGainStage(1))
  const out = p.apply(testCard(), {}, manualClock())
  return out.stageCosts.length === 1 && out.stageCosts[0].name === 'exposure-gain' &&
    typeof out.stageCosts[0].ms === 'number'
})())

check('per-apply overrides change params for ONE frame only', (() => {
  const p = createPipeline({})
  p.addStage(exposureGainStage(0))
  const boosted = p.apply(testCard(), { 'exposure-gain': { ev: 1 } }).image.data
  const normal = p.apply(testCard()).image.data
  return boosted[4] === 200 && normal[4] === 100
})())

/* ------------------------------------------- 2. exposure gain vectors ----- */

check('EV 0 is the identity', (() => {
  const image = testCard()
  const out = exposureGainStage(0).cpu(image, { ev: 0 })
  return [...out.data].join(',') === [...image.data].join(',')
})())

check('EV +1 doubles and CLAMPS: 0→0, 100→200, 200→255, 255→255; alpha untouched', (() => {
  const out = exposureGainStage(1).cpu(testCard(), { ev: 1 })
  const d = out.data
  return d[0] === 0 && d[4] === 200 && d[8] === 255 && d[12] === 255 &&
    d[7] === 200 && d[15] === 255
})())

check('EV -1 halves with round-to-even byte clamp: 100→50, 255→128', (() => {
  const out = exposureGainStage(-1).cpu(testCard(), { ev: -1 })
  return out.data[4] === 50 && out.data[12] === 128
})())

check('the stage is PURE: input bytes untouched, fresh output buffer', (() => {
  const image = testCard()
  const before = [...image.data]
  const out = exposureGainStage(1).cpu(image, { ev: 1 })
  return out.data !== image.data && [...image.data].join(',') === before.join(',')
})())

/* ---------------------------------------------------- 3. LUT vectors ------ */

check('identity LUT is the identity', (() => {
  const image = testCard()
  const out = lutStage(identityLut()).cpu(image, { lut: identityLut() })
  return [...out.data].join(',') === [...image.data].join(',')
})())

check('gamma 2.2 LUT: 0→0, 100→33, 200→149, 255→255 (precomputed vectors)', (() => {
  const lut = gammaLut(2.2)
  const out = lutStage(lut).cpu(testCard(), { lut })
  const d = out.data
  return d[0] === 0 && d[4] === 33 && d[8] === 149 && d[12] === 255
})())

check('per-channel LUTs are per-channel: a red-only inversion leaves G/B alone', (() => {
  const lut = identityLut()
  for (let i = 0; i < 256; i++) lut.r[i] = 255 - i
  const out = lutStage(lut).cpu(testCard(), { lut })
  const d = out.data
  return d[8] === 55 && d[9] === 0 && d[10] === 0 &&        // red 200→55
    d[4] === 155 && d[5] === 100 && d[6] === 100             // grey: R inverted, G/B untouched
})())

check('a malformed LUT throws at construction, not silently at frame time', (() => {
  try { lutStage({ r: new Uint8Array(4), g: new Uint8Array(256), b: new Uint8Array(256) }); return false } catch { return true }
})())

check('packLutTexture packs r,g,b into 256×1 RGBA with opaque alpha', (() => {
  const packed = packLutTexture(gammaLut(2.2))
  return packed.length === 1024 && packed[100 * 4] === 33 && packed[3] === 255 && packed[1023] === 255
})())

check('both reference stages carry a GLSL twin for the WebGL2 executor', (() => {
  const gain = exposureGainStage(0)
  const lut = lutStage(identityLut())
  return /#version 300 es/.test(gain.glsl.fragment) && /u_gain/.test(gain.glsl.fragment) &&
    /#version 300 es/.test(lut.glsl.fragment) && /u_lut/.test(lut.glsl.fragment) &&
    typeof gain.glsl.uniforms({ ev: 1 }).u_gain === 'number' &&
    lut.glsl.uniforms({ lut: identityLut() }).u_lut instanceof Uint8Array
})())

check('cloneImage copies bytes and geometry, not references', (() => {
  const image = testCard()
  const copy = cloneImage(image)
  copy.data[0] = 42
  return image.data[0] === 0 && copy.width === 2 && copy.data !== image.data
})())

console.log('\n========================================')
console.log('  camera pipeline — ordered pure stages, honest executors')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
