/**
 * Creative Studio looks — LUT machinery + the starter set.
 *
 * Pins: an identity function bakes to an identity LUT and applies as a
 * near-no-op (trilinear interpolation held to ≤1.5/255 — that bound IS the
 * LUT-resolution error budget); every shipped look builds, stays in range,
 * actually changes pixels, and renders deterministically; strength 0 is the
 * original; mono looks are actually monochrome.
 *
 *   node test/studio-looks.test.js
 */
import { createEvaluator } from '../src/lib/studio/evaluator.js'
import {
  LOOKS, lookIds, buildLookLUT, generateLUT, applyLUT3D, lookPipeline, LUT_SIZE
} from '../src/lib/studio/looks.js'
import { makeImage } from '../src/lib/studio/image-io.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

function fixture () {
  const img = makeImage(16, 12)
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4
      img.data[i] = Math.round((x / 15) * 255)
      img.data[i + 1] = Math.round((y / 11) * 255)
      img.data[i + 2] = ((x + y) % 2) ? 180 : 70
      img.data[i + 3] = 255
    }
  }
  return img
}

const evaluator = createEvaluator()

check('an identity LUT applies as a near-no-op (≤1.5/255)', () => {
  const lut = generateLUT((r, g, b) => [r, g, b], LUT_SIZE)
  const img = fixture()
  const out = applyLUT3D(img, lut, 1)
  let worst = 0
  for (let i = 0; i < img.data.length; i++) worst = Math.max(worst, Math.abs(out.data[i] - img.data[i]))
  return worst <= 1.5
})

check('strength 0 returns the original bytes', () => {
  const img = fixture()
  const out = applyLUT3D(img, buildLookLUT('punch'), 0)
  return out.data.every((v, i) => v === img.data[i])
})

check('every shipped look builds a LUT of the right size and stays in [0,1]', () =>
  lookIds().every((id) => {
    const { size, data } = buildLookLUT(id)
    return size === LUT_SIZE && data.length === size * size * size * 3 &&
      data.every((v) => v >= 0 && v <= 1)
  }))

check('every look actually changes the fixture (no placebo looks)', () => {
  const img = fixture()
  return lookIds().every((id) => {
    const out = evaluator.render(img, [{ op: 'look', v: 1, params: { id, strength: 1 } }]).image
    return out.data.some((v, i) => v !== img.data[i])
  })
})

check('a look renders deterministically (cache and no-cache agree)', () => {
  const img = fixture()
  const ops = [{ op: 'look', v: 1, params: { id: 'film_fade', strength: 0.8 } }]
  const a = evaluator.render(img, ops).image
  const b = evaluator.render(img, ops).image
  return a.data.every((v, i) => v === b.data[i])
})

check('mono looks are actually monochrome (r=g=b everywhere)', () => {
  const img = fixture()
  return ['mono_classic', 'mono_drama'].every((id) => {
    const out = evaluator.render(img, [{ op: 'look', v: 1, params: { id, strength: 1 } }]).image
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i] !== out.data[i + 1] || out.data[i + 1] !== out.data[i + 2]) return false
    }
    return true
  })
})

check('film_fade lifts the blacks (its defining property)', () => {
  const [r] = lookPipeline(0, 0, 0, LOOKS.film_fade.params)
  return r > 0.05
})

check('golden_hour warms: red gains on a neutral gray', () => {
  const [r, , b] = lookPipeline(0.5, 0.5, 0.5, LOOKS.golden_hour.params)
  return r > b
})

check('an unknown look id is refused at validate time', () =>
  throws(() => evaluator.render(fixture(), [{ op: 'look', v: 1, params: { id: 'vaporwave' } }]), /look.id/))

check('LOOKS is frozen — a look cannot be edited in place under a draft', () => {
  try { LOOKS.punch = { params: {} } } catch { /* ok */ }
  return typeof LOOKS.punch.name === 'string'
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio looks — procedural 3D LUTs')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
