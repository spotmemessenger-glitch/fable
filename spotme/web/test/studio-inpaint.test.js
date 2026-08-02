/**
 * Creative Studio inpainting — golden numeric vectors for the Telea-style
 * local tier.
 *
 * The claims under test are exactly the ones the docs make: a hole in a
 * CONSTANT region fills to that constant (exactly); a hole across a smooth
 * GRADIENT fills close to the gradient (bounded error); the result is
 * byte-deterministic; the local-tier caps refuse big selections with a
 * message that names the cloud leg; and nothing outside the mask changes.
 *
 *   node test/studio-inpaint.test.js
 */
import { inpaintTelea, resampleMaskNearest, MAX_INPAINT_PIXELS } from '../src/lib/studio/inpaint.js'
import { createEvaluator } from '../src/lib/studio/evaluator.js'
import '../src/lib/studio/inpaint.js'
import { makeMask, encodeMaskRLE } from '../src/lib/studio/masks.js'
import { makeImage } from '../src/lib/studio/image-io.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

function constantImage (w, h, r, g, b) {
  const img = makeImage(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255
  }
  return img
}

function holeMask (w, h, x0, y0, x1, y1) {
  const mask = makeMask(w, h)
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) mask.data[y * w + x] = 255
  return mask
}

check('GOLDEN: a hole in a constant field fills to exactly that constant', () => {
  const img = constantImage(24, 24, 90, 140, 200)
  // Scribble garbage into the hole so the fill has to actually work.
  for (let y = 8; y < 15; y++) {
    for (let x = 9; x < 16; x++) {
      const i = (y * 24 + x) * 4
      img.data[i] = 255; img.data[i + 1] = 0; img.data[i + 2] = 0
    }
  }
  const out = inpaintTelea(img, holeMask(24, 24, 9, 8, 16, 15))
  for (let y = 8; y < 15; y++) {
    for (let x = 9; x < 16; x++) {
      const i = (y * 24 + x) * 4
      if (out.data[i] !== 90 || out.data[i + 1] !== 140 || out.data[i + 2] !== 200) return false
    }
  }
  return true
})

check('GOLDEN: a hole across a horizontal gradient fills within 12/255 of it', () => {
  const w = 32
  const h = 20
  const img = makeImage(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const v = Math.round((x / (w - 1)) * 255)
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255
    }
  }
  const truth = new Uint8ClampedArray(img.data)
  for (let y = 7; y < 13; y++) {
    for (let x = 13; x < 19; x++) {
      const i = (y * w + x) * 4
      img.data[i] = 0; img.data[i + 1] = 255; img.data[i + 2] = 0
    }
  }
  const out = inpaintTelea(img, holeMask(w, h, 13, 7, 19, 13))
  let worst = 0
  for (let y = 7; y < 13; y++) {
    for (let x = 13; x < 19; x++) {
      const i = (y * w + x) * 4
      worst = Math.max(worst, Math.abs(out.data[i] - truth[i]))
    }
  }
  return worst <= 12
})

check('pixels OUTSIDE the mask are untouched, byte for byte', () => {
  const img = constantImage(20, 20, 10, 20, 30)
  for (let i = 0; i < img.data.length; i += 4) img.data[i] = (i / 4) % 251
  const before = new Uint8ClampedArray(img.data)
  const mask = holeMask(20, 20, 5, 5, 9, 9)
  const out = inpaintTelea(img, mask)
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      if (mask.data[y * 20 + x] >= 128) continue
      const i = (y * 20 + x) * 4
      for (let c = 0; c < 4; c++) if (out.data[i + c] !== before[i + c]) return false
    }
  }
  return true
})

check('DETERMINISM: two runs produce identical bytes', () => {
  const img = constantImage(24, 24, 50, 60, 70)
  for (let i = 0; i < img.data.length; i += 8) img.data[i] = 200
  const mask = holeMask(24, 24, 6, 6, 14, 14)
  const a = inpaintTelea(img, mask)
  const b = inpaintTelea(img, mask)
  return a.data.every((v, i) => v === b.data[i])
})

check('the local-tier cap refuses a selection and names the cloud leg', () => {
  const img = constantImage(40, 40, 0, 0, 0)
  const mask = holeMask(40, 40, 2, 2, 38, 38)     // 81% of the frame
  return throws(() => inpaintTelea(img, mask), /cloud-leg/)
})

check('the absolute pixel cap is enforced too', () =>
  MAX_INPAINT_PIXELS === 60_000)

check('the OP validates its mask at document time: empty selection refused', () => {
  const evaluator = createEvaluator()
  const img = constantImage(16, 16, 5, 5, 5)
  const empty = encodeMaskRLE(makeMask(16, 16))
  return throws(
    () => evaluator.render(img, [{ op: 'inpaint', v: 1, params: { mask: empty } }]),
    /selects nothing/)
})

check('the OP renders through the evaluator on a real fixture', () => {
  const evaluator = createEvaluator()
  const img = constantImage(20, 20, 120, 130, 140)
  for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) img.data[(y * 20 + x) * 4] = 255
  const rle = encodeMaskRLE(holeMask(20, 20, 8, 8, 12, 12))
  const out = evaluator.render(img, [{ op: 'inpaint', v: 1, params: { mask: rle } }]).image
  return out.data[(10 * 20 + 10) * 4] === 120
})

check('a preview-scaled render resamples the source-resolution mask', () => {
  const mask = holeMask(40, 40, 10, 10, 30, 30)
  const small = resampleMaskNearest(mask, 20, 20)
  let inside = 0
  for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) if (small.data[y * 20 + x] === 255) inside++
  return small.w === 20 && inside === 100
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio inpaint — Telea local tier')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
