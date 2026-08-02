/**
 * Proves portrait mode: the ISegmenter contract is enforced, NOTHING fakes
 * a segmenter (no engine → named refusal), and the blur consumer does real
 * masked compositing with golden numbers.
 *
 *   node test/camera-portrait.test.js
 */
import {
  createSegmenterRegistry, validateSegmenter, resizeMask, applyPortrait, renderPortrait,
  portraitBlurStageGl,
} from '../src/lib/camera/portrait.js'
import { boxBlurImage } from '../src/lib/camera/imagemath.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/** 8×8: left half bright checker (the "person"), right half dark checker. */
function portraitScene () {
  const width = 8; const height = 8
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const checker = (x + y) % 2 ? 255 : 0
      const v = x < 4 ? checker : checker / 2
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  return { data, width, height }
}

/** Mask: left half person (1), right half background (0). */
function halfMask (width = 8, height = 8) {
  const data = new Float32Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = x < width / 2 ? 1 : 0
  return { data, width, height }
}

/* ------------------------------------------------ 1. the honest refusal --- */

check('no engine registered → NO_SEGMENTER_REGISTERED, with the two real futures named', (() => {
  const registry = createSegmenterRegistry()
  const a = registry.availability()
  return a.available === false && a.reason === CAMERA_UNAVAILABLE.NO_SEGMENTER_REGISTERED &&
    /MediaPipe/.test(a.detail) && /P10/.test(a.detail)
})())

await checkAsync('renderPortrait with no engine refuses the same way — it never invents a mask', async () => {
  const registry = createSegmenterRegistry()
  const out = await renderPortrait(registry, portraitScene())
  return out.available === false && out.reason === CAMERA_UNAVAILABLE.NO_SEGMENTER_REGISTERED
})

check('validateSegmenter names each defect', (() => {
  return validateSegmenter(null) !== null &&
    validateSegmenter({ name: 'x' }) !== null &&
    validateSegmenter({ name: 'x', kind: 'magic', segment () {} }) !== null &&
    validateSegmenter({ name: 'x', kind: 'ml', segment () {} }) === null &&
    validateSegmenter({ name: 'x', kind: 'depth', segment () {} }) === null
})())

check('registering an invalid segmenter is refused and the registry stays empty', (() => {
  const registry = createSegmenterRegistry()
  const r = registry.register({ name: 'bad' })
  return r.available === false && registry.current() === null
})())

check('register → available with engine name; unregister → refusal again + release() called', (() => {
  const registry = createSegmenterRegistry()
  let released = false
  registry.register({ name: 'test-seg', kind: 'ml', segment: async () => ({}), release () { released = true } })
  const during = registry.availability()
  registry.unregister()
  const after = registry.availability()
  return during.available === true && during.engine === 'test-seg' &&
    after.available === false && released === true
})())

/* -------------------------------------------------- 2. the blur consumer -- */

check('masked blur: person half BIT-IDENTICAL to input, background half equals the blurred image', (() => {
  const image = portraitScene()
  const out = applyPortrait(image, halfMask(), { blurRadius: 2, passes: 1, feather: 0 })
  const blurred = boxBlurImage(image, 2, 1)
  if (!out.available) return false
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const i = (y * 8 + x) * 4
      if (x < 4 && out.image.data[i] !== image.data[i]) return false
      if (x >= 4 && out.image.data[i] !== blurred.data[i]) return false
    }
  }
  return true
})())

check('feathering makes the boundary a BLEND, not a cliff', (() => {
  const image = portraitScene()
  const hard = applyPortrait(image, halfMask(), { blurRadius: 2, passes: 1, feather: 0 }).image
  const soft = applyPortrait(image, halfMask(), { blurRadius: 2, passes: 1, feather: 1 }).image
  // At the seam column (x=4) the feathered result must sit BETWEEN sharp
  // and blurred for at least one pixel where the hard result was pure blur.
  let blended = false
  const blurred = boxBlurImage(image, 2, 1)
  for (let y = 0; y < 8; y++) {
    const i = (y * 8 + 4) * 4
    const lo = Math.min(image.data[i], blurred.data[i])
    const hi = Math.max(image.data[i], blurred.data[i])
    if (hi - lo > 4 && soft.data[i] > lo + 1 && soft.data[i] < hi - 1 && hard.data[i] === blurred.data[i]) blended = true
  }
  return blended
})())

check('alpha is preserved everywhere', (() => {
  const image = portraitScene()
  image.data[3] = 200
  const out = applyPortrait(image, halfMask(), { feather: 0 }).image
  return out.data[3] === 200 && out.data[7] === 255
})())

check('a small mask is upsampled to image geometry (model-sized masks work)', (() => {
  const small = halfMask(4, 4)
  const resized = resizeMask(small, 8, 8)
  // 8→4 halving: x∈0..3 read source cols 0..1 (person), x∈4..7 read 2..3.
  return resized.width === 8 && resized.data[0] === 1 && resized.data[3] === 1 &&
    resized.data[4] === 0 && resized.data[8 * 7 + 1] === 1 && resized.data[8 * 7 + 6] === 0
})())

check('a non-Float32Array mask is a named refusal', (() => {
  const out = applyPortrait(portraitScene(), { data: [1, 0], width: 2, height: 1 })
  return out.available === false && /Float32Array/.test(out.detail)
})())

/* ----------------------------------------- 3. renderPortrait end-to-end --- */

await checkAsync('a REGISTERED engine drives the full path and is credited by name', async () => {
  const registry = createSegmenterRegistry()
  registry.register({ name: 'test-seg', kind: 'ml', segment: async () => ({ mask: halfMask() }) })
  const image = portraitScene()
  const out = await renderPortrait(registry, image, { blurRadius: 2, passes: 1, feather: 0 })
  return out.available && out.engine === 'test-seg' && out.image.data[0] === image.data[0]
})

await checkAsync('an engine that THROWS becomes FAILED with the engine named — capture never crashes', async () => {
  const registry = createSegmenterRegistry()
  registry.register({ name: 'flaky', kind: 'ml', segment: async () => { throw new Error('model exploded') } })
  const out = await renderPortrait(registry, portraitScene())
  return out.available === false && out.reason === CAMERA_UNAVAILABLE.FAILED && /flaky.*model exploded/.test(out.detail)
})

await checkAsync('an engine returning a MALFORMED mask is refused, defect named', async () => {
  const registry = createSegmenterRegistry()
  registry.register({ name: 'liar', kind: 'ml', segment: async () => ({ mask: { data: new Float32Array(3), width: 8, height: 8 } }) })
  const out = await renderPortrait(registry, portraitScene())
  return out.available === false && /malformed mask/.test(out.detail)
})

check('the GL twin exists for the preview path and declares its mask uniform', (() => {
  const stage = portraitBlurStageGl()
  return stage.name === 'portrait-blur' && /u_mask/.test(stage.glsl.fragment) &&
    typeof stage.glsl.uniforms({ radiusPx: 6 }).u_radius === 'number'
})())

console.log('\n========================================')
console.log('  portrait — ISegmenter seam, honest absence, real blur')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
