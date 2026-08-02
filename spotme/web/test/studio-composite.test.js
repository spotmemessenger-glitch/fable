/**
 * Creative Studio compositing — bg/sky replace and relight goldens.
 *
 *   node test/studio-composite.test.js
 */
import { createEvaluator } from '../src/lib/studio/evaluator.js'
import '../src/lib/studio/composite.js'
import { resizeBilinear, coverResize, generateSky, SKY_PRESETS } from '../src/lib/studio/composite.js'
import { makeMask, encodeMaskRLE } from '../src/lib/studio/masks.js'
import { makeImage } from '../src/lib/studio/image-io.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

const evaluator = createEvaluator()

function solid (w, h, r, g, b) {
  const img = makeImage(w, h)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255
  }
  return img
}

/* -------------------------------------------------------------- resizing */

check('resizeBilinear hits requested dims; constant stays constant', () => {
  const out = resizeBilinear(solid(10, 6, 77, 88, 99), 25, 13)
  return out.width === 25 && out.height === 13 &&
    out.data.every((v, i) => [77, 88, 99, 255][i % 4] === v)
})

check('coverResize fills the frame exactly (no letterbox)', () => {
  const out = coverResize(solid(100, 50, 5, 5, 5), 40, 40)
  return out.width === 40 && out.height === 40
})

/* ------------------------------------------------------------ bg_replace */

check('mask path: fg kept where mask=255, bg where 0', () => {
  const img = solid(10, 10, 200, 10, 10)              // red foreground
  const mask = makeMask(10, 10)
  for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) mask.data[y * 10 + x] = 255
  const assets = new Map([['bg1', solid(10, 10, 10, 10, 200)]])   // blue bg
  const out = evaluator.render(img, [{
    op: 'bg_replace', v: 1, params: { mask: encodeMaskRLE(mask), bg: 'bg1', feather: 0 }
  }], { assets }).image
  const left = out.data[(5 * 10 + 1) * 4]
  const rightB = out.data[(5 * 10 + 8) * 4 + 2]
  return left === 200 && rightB === 200
})

check('chroma path: green screen replaced, subject kept, spill suppressed', () => {
  const img = makeImage(10, 10)
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const i = (y * 10 + x) * 4
      if (x < 6) { img.data[i] = 30; img.data[i + 1] = 200; img.data[i + 2] = 40 } else { img.data[i] = 210; img.data[i + 1] = 60; img.data[i + 2] = 50 }
      img.data[i + 3] = 255
    }
  }
  const assets = new Map([['bg1', solid(10, 10, 10, 10, 220)]])
  const out = evaluator.render(img, [{
    op: 'bg_replace',
    v: 1,
    params: { chroma: { color: [30, 200, 40], tolerance: 0.15, softness: 0.08 }, bg: 'bg1', feather: 0 }
  }], { assets }).image
  const keyedBlue = out.data[(5 * 10 + 1) * 4 + 2]
  const subjectRed = out.data[(5 * 10 + 8) * 4]
  return keyedBlue > 180 && subjectRed > 180
})

check('a missing background asset fails the render loudly', () =>
  throws(() => evaluator.render(solid(4, 4, 0, 0, 0), [{
    op: 'bg_replace', v: 1, params: { mask: encodeMaskRLE(makeMask(4, 4)), bg: 'ghost' }
  }]), /asset ghost/))

check('mask and chroma together are refused (exactly one selector)', () =>
  throws(() => evaluator.render(solid(4, 4, 0, 0, 0), [{
    op: 'bg_replace',
    v: 1,
    params: { mask: encodeMaskRLE(makeMask(4, 4)), chroma: { color: [0, 255, 0] }, bg: 'b' }
  }]), /exactly one/))

/* ----------------------------------------------------------- sky replace */

check('generateSky: clear_noon is a top-dark-blue → bottom-light gradient', () => {
  const sky = generateSky('clear_noon', 8, 32)
  const topB = sky.data[2]
  const botB = sky.data[(31 * 8) * 4 + 2]
  const topLuma = sky.data[0] + sky.data[1] + sky.data[2]
  const botLuma = sky.data[(31 * 8) * 4] + sky.data[(31 * 8) * 4 + 1] + sky.data[(31 * 8) * 4 + 2]
  return topB > 150 && botLuma > topLuma && botB > 200
})

check('sunset_glow has a sun glow near its configured position', () => {
  const sky = generateSky('sunset_glow', 21, 21)
  const at = (x, y) => sky.data[(y * 21 + x) * 4]
  return at(10, 19) > at(2, 19)
})

check('every preset generates in-range pixels', () =>
  Object.keys(SKY_PRESETS).every((id) => {
    const sky = generateSky(id, 6, 6)
    return sky.data.every((v) => v >= 0 && v <= 255)
  }))

check('sky_replace with an explicit mask composites the preset in', () => {
  const img = solid(10, 10, 100, 100, 100)
  const mask = makeMask(10, 10)
  for (let x = 0; x < 10; x++) mask.data[x] = 255       // top row = sky
  const out = evaluator.render(img, [{
    op: 'sky_replace', v: 1, params: { preset: 'clear_noon', mask: encodeMaskRLE(mask), feather: 0, tintFg: 0 }
  }]).image
  return out.data[2] > 150 && out.data[(5 * 10) * 4] === 100
})

check('sky_replace auto path runs the heuristic end to end', () => {
  const img = makeImage(16, 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4
      if (y < 6) { img.data[i] = 90; img.data[i + 1] = 150; img.data[i + 2] = 235 } else { img.data[i] = 110; img.data[i + 1] = 80; img.data[i + 2] = 50 }
      img.data[i + 3] = 255
    }
  }
  const out = evaluator.render(img, [{
    op: 'sky_replace', v: 1, params: { preset: 'sunset_glow', feather: 1 }
  }]).image
  // The top became sunset-ish (red channel up from the blue sky's 90).
  return out.data[(2 * 16 + 8) * 4] > 90
})

/* --------------------------------------------------------------- relight */

check('relight brightens near the light more than far, and never clips white', () => {
  const img = solid(20, 20, 120, 120, 120)
  img.data[(1 * 20 + 1) * 4] = 250
  img.data[(1 * 20 + 1) * 4 + 1] = 250
  img.data[(1 * 20 + 1) * 4 + 2] = 250
  const out = evaluator.render(img, [{
    op: 'relight', v: 1, params: { x: 0.1, y: 0.1, intensity: 0.8, radius: 0.5, warmth: 0 }
  }]).image
  const near = out.data[(2 * 20 + 2) * 4]
  const far = out.data[(18 * 20 + 18) * 4]
  const white = out.data[(1 * 20 + 1) * 4]
  return near > far && far >= 120 && white <= 255 && white >= 250
})

check('negative intensity dims with shadow headroom', () => {
  const img = solid(20, 20, 120, 120, 120)
  const out = evaluator.render(img, [{
    op: 'relight', v: 1, params: { x: 0.5, y: 0.5, intensity: -0.8, radius: 0.4, warmth: 0 }
  }]).image
  return out.data[(10 * 20 + 10) * 4] < 120 && out.data[0] >= 115
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio composite — bg, sky, relight')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
