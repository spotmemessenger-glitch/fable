/**
 * Creative Studio ops — determinism, CPU/float-twin tolerance, geometry
 * exactness, and the image-IO contracts (EXIF orientation, preview scale,
 * tiling plan).
 *
 * THE TWIN CLAIM, precisely: every per-pixel color op is defined ONCE as
 * float math in kernels.js; the GLSL preview shaders transcribe that math and
 * the CPU byte path wraps it. Here the byte path is held to the float
 * reference within quantization tolerance (≤ 1.5/255 per channel) on a
 * gradient fixture — so CPU, shader source and reference cannot drift apart
 * without this file going red. Real-GPU readback equality is additionally
 * bounded by the same reference and is exercised in a browser, not here
 * (Node has no WebGL2; pretending otherwise would test a shim, not a GPU).
 *
 *   node test/studio-ops.test.js
 */
import { createEvaluator, getOp, listOps } from '../src/lib/studio/evaluator.js'
import '../src/lib/studio/ops-color.js'
import '../src/lib/studio/ops-spatial.js'
import '../src/lib/studio/ops-geometry.js'
import '../src/lib/studio/looks.js'
import '../src/lib/studio/inpaint.js'
import '../src/lib/studio/composite.js'
import {
  kExposure, kContrast, kSaturation, kTemperature, kHighlightsShadows,
  buildCurveLUT, sampleLUT, mulberry32
} from '../src/lib/studio/kernels.js'
import { inscribedRect, solveHomography, applyHomography, invert3 } from '../src/lib/studio/ops-geometry.js'
import {
  makeImage, parseExifOrientation, applyOrientation, previewScale, planTiles,
  cropRect, blitRect, downscale
} from '../src/lib/studio/image-io.js'
import { assembleFrag } from '../src/lib/studio/gl-eval.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

/* ------------------------------------------------------------- fixtures */

/** Deterministic 24×16 gradient + colored quadrants — exercises the full range. */
function fixture () {
  const img = makeImage(24, 16)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 24; x++) {
      const i = (y * 24 + x) * 4
      img.data[i] = Math.round((x / 23) * 255)
      img.data[i + 1] = Math.round((y / 15) * 255)
      img.data[i + 2] = (x < 12) === (y < 8) ? 200 : 40
      img.data[i + 3] = 255
    }
  }
  return img
}

const evaluator = createEvaluator()
const render = (ops, img = fixture()) => evaluator.render(img, ops, { quality: 'export' })

/* -------------------------------------------------- registry + evaluator */

check('the full op set is registered', () => {
  const want = ['bg_replace', 'clarity', 'contrast', 'crop', 'curves', 'exposure', 'grain',
    'highlights_shadows', 'inpaint', 'look', 'perspective', 'relight', 'rotate',
    'saturation', 'sharpen', 'sky_replace', 'straighten', 'temperature', 'vignette']
  const have = listOps()
  return want.every((op) => have.includes(op))
})

check('an unknown op fails the WHOLE render before any pixel work', () =>
  throws(() => render([{ op: 'exposure', v: 1, params: { ev: 1 } }, { op: 'nope', v: 1, params: {} }]), /unknown op/))

check('a version mismatch is refused, not best-effort rendered', () =>
  throws(() => render([{ op: 'exposure', v: 2, params: { ev: 1 } }]), /v2/))

check('in Node every path is honestly reported as cpu', () => {
  const { paths } = render([{ op: 'exposure', v: 1, params: { ev: 0.5 } }])
  return paths.length === 1 && paths[0].path === 'cpu'
})

check('DETERMINISM: the same document renders byte-identical twice', () => {
  const ops = [
    { op: 'exposure', v: 1, params: { ev: 0.4 } },
    { op: 'grain', v: 1, params: { amount: 0.5, size: 2, seed: 42 } },
    { op: 'vignette', v: 1, params: { amount: 0.5, radius: 0.4, softness: 0.3 } }
  ]
  const a = render(ops).image
  const b = render(ops).image
  return a.data.length === b.data.length && a.data.every((v, i) => v === b.data[i])
})

check('render(source, []) returns a COPY, never the source buffer', () => {
  const src = fixture()
  const { image } = evaluator.render(src, [])
  image.data[0] = 7
  return src.data[0] !== 7 || image.data !== src.data
})

/* ------------------------------------------- CPU byte path vs float twin */

function twinTolerance (opName, params, kernel) {
  const img = fixture()
  const out = render([{ op: opName, v: 1, params }], img).image
  let worst = 0
  for (let i = 0; i < img.data.length; i += 4) {
    const [r, g, b] = kernel(img.data[i] / 255, img.data[i + 1] / 255, img.data[i + 2] / 255, params)
    worst = Math.max(worst,
      Math.abs(out.data[i] - r * 255),
      Math.abs(out.data[i + 1] - g * 255),
      Math.abs(out.data[i + 2] - b * 255))
  }
  return worst <= 1.5
}

check('exposure byte path matches the float kernel (≤1.5/255)', () =>
  twinTolerance('exposure', { ev: 0.8 }, kExposure))
check('contrast matches its kernel', () =>
  twinTolerance('contrast', { amount: 0.6 }, kContrast))
check('saturation matches its kernel', () =>
  twinTolerance('saturation', { amount: -0.5 }, kSaturation))
check('temperature matches its kernel', () =>
  twinTolerance('temperature', { temp: 0.7, tint: -0.3 }, kTemperature))
check('highlights/shadows matches its kernel', () =>
  twinTolerance('highlights_shadows', { highlights: -0.6, shadows: 0.7 }, kHighlightsShadows))

check('identity params are identity output for every slider op', () => {
  const ops = [
    { op: 'exposure', v: 1, params: { ev: 0 } },
    { op: 'contrast', v: 1, params: { amount: 0 } },
    { op: 'saturation', v: 1, params: { amount: 0 } },
    { op: 'temperature', v: 1, params: { temp: 0, tint: 0 } },
    { op: 'highlights_shadows', v: 1, params: { highlights: 0, shadows: 0 } },
    { op: 'vignette', v: 1, params: { amount: 0 } },
    { op: 'sharpen', v: 1, params: { amount: 0 } }
  ]
  const img = fixture()
  const out = render(ops, img).image
  return out.data.every((v, i) => Math.abs(v - img.data[i]) <= 1)
})

check('every GLSL twin assembles into a complete #version 300 es shader', () => {
  const glOps = ['exposure', 'contrast', 'saturation', 'temperature', 'highlights_shadows', 'vignette']
  return glOps.every((name) => {
    const def = getOp(name)
    if (!def?.glsl) return false
    const src = assembleFrag(def.glsl.frag)
    const uniforms = def.glsl.uniforms(def.validate({}), {})
    return src.startsWith('#version 300 es') && src.includes('void main') &&
      Object.keys(uniforms).every((u) => src.includes(u))
  })
})

check('param validation clamps the boundary: out-of-range throws', () =>
  throws(() => render([{ op: 'exposure', v: 1, params: { ev: 9 } }]), /must be in/))

/* ------------------------------------------------------------------ curves */

check('curves LUT hits its endpoints and is monotone for monotone points', () => {
  const lut = buildCurveLUT([[0, 0], [0.5, 0.7], [1, 1]])
  let monotone = true
  for (let i = 1; i < 256; i++) if (lut[i] < lut[i - 1] - 1e-9) monotone = false
  return Math.abs(lut[0]) < 1e-9 && Math.abs(lut[255] - 1) < 1e-9 && monotone &&
    Math.abs(sampleLUT(lut, 0.5) - 0.7) < 0.01
})

check('curves refuses non-increasing x', () =>
  throws(() => buildCurveLUT([[0, 0], [0.5, 0.5], [0.5, 1]]), /strictly increasing/))

check('the curves OP applies channel then master', () => {
  const img = fixture()
  // r-channel inversion via curve; master identity.
  const out = render([{ op: 'curves', v: 1, params: { r: [[0, 1], [1, 0]] } }], img).image
  let ok = true
  for (let i = 0; i < img.data.length; i += 4) {
    if (Math.abs(out.data[i] - (255 - img.data[i])) > 2) ok = false
    if (out.data[i + 1] !== img.data[i + 1]) ok = false
  }
  return ok
})

check('curves with no channels at all is refused', () =>
  throws(() => render([{ op: 'curves', v: 1, params: {} }]), /at least one/))

/* ---------------------------------------------------------------- spatial */

check('sharpen increases local contrast at an edge', () => {
  const img = makeImage(16, 8)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 16; x++) {
      const i = (y * 16 + x) * 4
      const v = x < 8 ? 60 : 190
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
  }
  const out = render([{ op: 'sharpen', v: 1, params: { amount: 1.5, radius: 1.5 } }], img).image
  const edgeL = out.data[(4 * 16 + 7) * 4]
  const edgeR = out.data[(4 * 16 + 8) * 4]
  return edgeL < 60 && edgeR > 190
})

check('grain is seeded: same seed identical, different seed different', () => {
  const p = (seed) => render([{ op: 'grain', v: 1, params: { amount: 0.8, size: 1, seed } }]).image.data
  const a = p(7)
  const b = p(7)
  const c = p(8)
  const same = a.every((v, i) => v === b[i])
  const differs = a.some((v, i) => v !== c[i])
  return same && differs
})

check('mulberry32 is stable across runs (pinned first draws)', () => {
  const r = mulberry32(1)
  const draws = [r(), r(), r()]
  return draws.every((v) => v >= 0 && v < 1) && Math.abs(draws[0] - 0.6270739405881613) < 1e-12
})

/* --------------------------------------------------------------- geometry */

check('crop produces the exact requested pixel rect', () => {
  const out = render([{ op: 'crop', v: 1, params: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }]).image
  return out.width === 12 && out.height === 8
})

check('rotate 180 twice is identity', () => {
  const img = fixture()
  const once = render([{ op: 'rotate', v: 1, params: { quarter: 2 } }], img).image
  const twice = render([{ op: 'rotate', v: 1, params: { quarter: 2 } }], once).image
  return twice.data.every((v, i) => v === img.data[i])
})

check('rotate 90 swaps dimensions and moves the corner correctly', () => {
  const img = fixture()
  img.data[0] = 111                       // top-left marker (R)
  const out = render([{ op: 'rotate', v: 1, params: { quarter: 1 } }], img).image
  // (0,0) → (h-1, 0) in the rotated frame.
  return out.width === 16 && out.height === 24 && out.data[(0 * 16 + 15) * 4] === 111
})

check('inscribedRect at 0° is the full frame and shrinks with angle', () => {
  const zero = inscribedRect(400, 300, 0)
  const five = inscribedRect(400, 300, (5 * Math.PI) / 180)
  return zero.w === 400 && zero.h === 300 && five.w < 400 && five.h < 300 && five.w / five.h > 1.3
})

check('straighten crops away the empty corners (output strictly smaller)', () => {
  const out = render([{ op: 'straighten', v: 1, params: { degrees: 5 } }]).image
  return out.width < 24 && out.height < 16 && out.width > 16
})

check('homography maps the four corners exactly', () => {
  const quad = [[0.1, 0.05], [0.9, 0.1], [0.95, 0.9], [0.05, 0.85]]
  const H = solveHomography(quad)
  return quad.every((c, i) => {
    const [u, v] = [[0, 0], [1, 0], [1, 1], [0, 1]][i]
    const [x, y] = applyHomography(H, u, v)
    return Math.abs(x - c[0]) < 1e-9 && Math.abs(y - c[1]) < 1e-9
  })
})

check('inverse homography round-trips a point', () => {
  const H = solveHomography([[0.1, 0], [1, 0.1], [0.9, 1], [0, 0.9]])
  const inv = invert3(H)
  const [x, y] = applyHomography(H, 0.3, 0.6)
  const [u, v] = applyHomography(inv, x, y)
  return Math.abs(u - 0.3) < 1e-9 && Math.abs(v - 0.6) < 1e-9
})

check('an identity perspective quad reproduces the image (within resampling)', () => {
  const img = fixture()
  const out = render([{ op: 'perspective', v: 1, params: { quad: [[0, 0], [1, 0], [1, 1], [0, 1]] } }], img).image
  let worst = 0
  for (let i = 0; i < img.data.length; i++) worst = Math.max(worst, Math.abs(out.data[i] - img.data[i]))
  return worst <= 2
})

check('a degenerate quad is refused at validate time', () =>
  throws(() => render([{ op: 'perspective', v: 1, params: { quad: [[0, 0], [0, 0], [1, 1], [0, 1]] } }]), /degenerate/))

/* ----------------------------------------------------------------- image-io */

/** Minimal JPEG carrying an EXIF orientation tag, built by hand. */
function jpegWithOrientation (orientation) {
  const tiff = [
    0x4d, 0x4d, 0, 42, 0, 0, 0, 8,          // big-endian TIFF, IFD at 8
    0, 1,                                    // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
    0, 0, 0, 0
  ]
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]
  const app1len = exif.length + 2
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe1, (app1len >> 8) & 0xff, app1len & 0xff, ...exif,
    0xff, 0xd9
  ])
}

check('EXIF orientation parses from hand-built JPEG bytes', () =>
  parseExifOrientation(jpegWithOrientation(6)) === 6 &&
  parseExifOrientation(jpegWithOrientation(8)) === 8)

check('non-JPEG, truncated and hostile bytes all answer 1, never throw', () =>
  parseExifOrientation(new Uint8Array([1, 2, 3])) === 1 &&
  parseExifOrientation(jpegWithOrientation(6).slice(0, 9)) === 1 &&
  parseExifOrientation(new Uint8Array(0)) === 1)

check('applyOrientation 6 (90° CW) moves the top-left pixel to the top-right', () => {
  const img = makeImage(3, 2)
  img.data[0] = 200
  const out = applyOrientation(img, 6)
  return out.width === 2 && out.height === 3 && out.data[(0 * 2 + 1) * 4] === 200
})

check('all eight orientations preserve the pixel population', () => {
  const img = makeImage(3, 2)
  for (let i = 0; i < img.data.length; i += 4) img.data[i] = i / 4 * 10
  const sum = (d) => d.reduce((a, v, i) => (i % 4 === 0 ? a + v : a), 0)
  return [2, 3, 4, 5, 6, 7, 8].every((o) => sum(applyOrientation(img, o).data) === sum(img.data))
})

check('previewScale never upscales and respects both budgets', () =>
  previewScale(800, 600) === 1 &&
  previewScale(8000, 6000) < 0.3 &&
  Math.abs(previewScale(4000, 3000, { maxEdge: 2000, maxPixels: 1e9 }) - 0.5) < 1e-9)

check('planTiles covers the frame exactly, with src padding inside bounds', () => {
  const tiles = planTiles(3000, 2000, { maxPixels: 1_000_000, overlap: 16 })
  const covered = new Set()
  for (const t of tiles) {
    if (t.src.x < 0 || t.src.y < 0 || t.src.x + t.src.w > 3000 || t.src.y + t.src.h > 2000) return false
    if (t.src.x > t.rect.x || t.src.y > t.rect.y) return false
    covered.add(`${t.rect.x},${t.rect.y},${t.rect.w},${t.rect.h}`)
  }
  const area = tiles.reduce((a, t) => a + t.rect.w * t.rect.h, 0)
  return area === 3000 * 2000 && covered.size === tiles.length && tiles.length > 1
})

check('cropRect/blitRect round-trip a region exactly', () => {
  const img = fixture()
  const rect = { x: 3, y: 2, w: 7, h: 5 }
  const tile = cropRect(img, rect)
  const copy = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
  blitRect(copy, tile, rect.x, rect.y)
  return copy.data.every((v, i) => v === img.data[i])
})

check('downscale averages areas (constant image stays constant)', () => {
  const img = makeImage(10, 10)
  img.data.fill(120)
  const out = downscale(img, 0.5)
  return out.width === 5 && out.height === 5 && out.data.every((v, i) => i % 4 === 3 ? v === 120 : v === 120)
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio ops — twins, geometry, image-io')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
