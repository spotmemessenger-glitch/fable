/**
 * Creative Studio masks — RLE serialization bounds, the brush, chroma-key
 * and sky-heuristic golden checks, and the ISegmenter contract's honesty
 * (no engine ⇒ loud refusal, never a fake mask).
 *
 *   node test/studio-masks.test.js
 */
import {
  makeMask, maskCoverage, encodeMaskRLE, decodeMaskRLE,
  stampBrush, strokeBrush, chromaKeyMask, skyHeuristicMask, createSegmenterSlot
} from '../src/lib/studio/masks.js'
import { makeImage } from '../src/lib/studio/image-io.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

/* ------------------------------------------------------------------- RLE */

check('RLE round-trips a structured mask exactly', () => {
  const mask = makeMask(37, 23)
  for (let y = 5; y < 18; y++) for (let x = 7; x < 30; x++) mask.data[y * 37 + x] = 200
  for (let i = 0; i < mask.data.length; i += 91) mask.data[i] = 55
  const back = decodeMaskRLE(encodeMaskRLE(mask))
  return back.w === 37 && back.h === 23 && back.data.every((v, i) => v === mask.data[i])
})

check('runs that do not cover the mask are refused', () =>
  throws(() => decodeMaskRLE({ w: 4, h: 4, rle: [15, 0] }), /cover/))

check('runs that overflow the mask are refused', () =>
  throws(() => decodeMaskRLE({ w: 4, h: 4, rle: [17, 0] }), /exceed/))

check('a bad run value is refused', () =>
  throws(() => decodeMaskRLE({ w: 2, h: 2, rle: [4, 300] }), /bad run/))

check('coverage math is soft-weighted', () => {
  const mask = makeMask(10, 10)
  mask.data.fill(255, 0, 50)
  return Math.abs(maskCoverage(mask) - 0.5) < 1e-9
})

/* ----------------------------------------------------------------- brush */

check('a brush stamp covers its center fully and falls off at the rim', () => {
  const mask = makeMask(21, 21)
  stampBrush(mask, 10.5, 10.5, 8, { hardness: 0.3 })
  const center = mask.data[10 * 21 + 10]
  const rim = mask.data[10 * 21 + 17]
  const outside = mask.data[10 * 21 + 20]
  return center === 255 && rim > 0 && rim < 255 && outside === 0
})

check('erase subtracts what painting added', () => {
  const mask = makeMask(15, 15)
  stampBrush(mask, 7, 7, 5, { hardness: 1 })
  stampBrush(mask, 7, 7, 5, { hardness: 1, erase: true })
  return mask.data.every((v) => v === 0)
})

check('a stroke connects distant points without gaps', () => {
  const mask = makeMask(40, 9)
  strokeBrush(mask, [{ x: 4, y: 4 }, { x: 35, y: 4 }], 3, { hardness: 1 })
  for (let x = 4; x <= 35; x++) if (mask.data[4 * 40 + x] !== 255) return false
  return true
})

/* ------------------------------------------------------------ chroma key */

check('GOLDEN: green screen keys, red subject does not', () => {
  const img = makeImage(8, 4)
  for (let i = 0; i < img.data.length; i += 4) {
    const x = (i / 4) % 8
    if (x < 4) { img.data[i] = 30; img.data[i + 1] = 200; img.data[i + 2] = 40 } else { img.data[i] = 200; img.data[i + 1] = 40; img.data[i + 2] = 30 }
    img.data[i + 3] = 255
  }
  const mask = chromaKeyMask(img, { color: [30, 200, 40], tolerance: 0.15, softness: 0.1 })
  return mask.data[0] > 240 && mask.data[6] < 15
})

check('chroma key is luma-invariant: a darker green still keys', () => {
  const img = makeImage(2, 1)
  img.data.set([15, 100, 20, 255, 200, 40, 30, 255])
  const mask = chromaKeyMask(img, { color: [30, 200, 40], tolerance: 0.15, softness: 0.1 })
  return mask.data[0] > 200 && mask.data[1] < 30
})

check('chroma key validates its color', () =>
  throws(() => chromaKeyMask(makeImage(2, 2), { color: [0, 999, 0] }), /out of range/))

/* --------------------------------------------------------- sky heuristic */

function outdoorFixture () {
  const img = makeImage(20, 20)
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const i = (y * 20 + x) * 4
      if (y < 8) { img.data[i] = 90; img.data[i + 1] = 150; img.data[i + 2] = 235 } else { img.data[i] = 110; img.data[i + 1] = 80; img.data[i + 2] = 50 }
      img.data[i + 3] = 255
    }
  }
  return img
}

check('GOLDEN: blue top is sky, brown ground is not', () => {
  const mask = skyHeuristicMask(outdoorFixture())
  const top = mask.data[2 * 20 + 10]
  const ground = mask.data[15 * 20 + 10]
  return top > 128 && ground === 0
})

check('a blue region NOT connected to the top is not called sky (column scan)', () => {
  const img = outdoorFixture()
  // A "blue car" at rows 14..16 — below the ground break.
  for (let y = 14; y < 17; y++) {
    for (let x = 5; x < 15; x++) {
      const i = (y * 20 + x) * 4
      img.data[i] = 90; img.data[i + 1] = 150; img.data[i + 2] = 235
    }
  }
  const mask = skyHeuristicMask(img)
  return mask.data[15 * 20 + 10] === 0
})

check('a night frame yields almost no sky (brightness term)', () => {
  const img = makeImage(10, 10)
  for (let i = 0; i < img.data.length; i += 4) {
    img.data[i] = 10; img.data[i + 1] = 12; img.data[i + 2] = 22; img.data[i + 3] = 255
  }
  const mask = skyHeuristicMask(img)
  return maskCoverage(mask) < 0.05
})

/* ------------------------------------------------------------ ISegmenter */

await checkAsync('an empty slot REFUSES to segment, naming the missing engine decision', async () => {
  const slot = createSegmenterSlot()
  if (slot.available() !== false) return false
  try {
    await slot.segment(makeImage(4, 4), { kind: 'person' })
    return false
  } catch (e) {
    return /no segmentation engine installed/.test(e.message)
  }
})

check('a malformed engine is refused at registration', () => {
  const slot = createSegmenterSlot()
  return throws(() => slot.register({ id: 'x', kinds: [], segment: () => {} }), /ISegmenter/)
})

await checkAsync('a registered engine serves masks; a second registration is refused', async () => {
  const slot = createSegmenterSlot()
  slot.register({
    id: 'fake-engine',
    kinds: ['person'],
    segment: async (img) => {
      const m = makeMask(img.width, img.height)
      m.data.fill(255)
      return m
    }
  })
  const mask = await slot.segment(makeImage(6, 5), { kind: 'person' })
  const dup = (() => { try { slot.register({ id: 'two', kinds: ['sky'], segment: () => {} }); return false } catch { return true } })()
  return slot.available() && mask.w === 6 && mask.h === 5 && dup
})

await checkAsync('an engine returning a wrong-sized mask is caught, not passed through', async () => {
  const slot = createSegmenterSlot()
  slot.register({ id: 'bad', kinds: ['person'], segment: async () => makeMask(2, 2) })
  try {
    await slot.segment(makeImage(6, 5), { kind: 'person' })
    return false
  } catch (e) {
    return /bad mask/.test(e.message)
  }
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio masks — RLE, brush, chroma, sky')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
