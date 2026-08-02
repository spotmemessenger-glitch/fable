/**
 * Proves the document scanner on DETERMINISTIC synthetic pages: the DLT
 * homography against known matrices (1e-6), the Hough detector against
 * straight / rotated / perspective / noisy pages with known corners, the
 * honest NO_QUAD_FOUND refusal on featureless frames, enhancement that
 * survives an illumination gradient, and multi-page assembly to REAL PNG
 * blobs (inflated back with node:zlib and compared byte-for-byte).
 *
 *   node test/vision-docscan.test.js
 */
import { inflateSync } from 'node:zlib'
import {
  sobel, planePercentile, integralPlane, localMean, orderCorners, polygonArea,
  isConvex, quadAngles,
} from '../src/lib/vision/imageops.js'
import {
  homographyFromPoints, applyHomography, invertHomography, mul3, warpPerspective,
} from '../src/lib/vision/homography.js'
import { houghLines, intersectLines, detectDocumentQuad } from '../src/lib/vision/quad.js'
import { enhancePage, adaptiveThreshold } from '../src/lib/vision/enhance.js'
import {
  rectifyDocument, rectifiedSize, scanDocumentPage, createDocumentAssembler,
} from '../src/lib/vision/docscan.js'
import { encodePng, encodePngBlob, readPngHeader } from '../src/lib/vision/png.js'
import { lumaPlane } from '../src/lib/camera/imagemath.js'
import { VISION_UNAVAILABLE } from '../src/lib/vision/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* ------------------------------------------------------------ fixtures ---- */

function mulberry32 (seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const inQuad = (corners, x, y) => {
  let sign = 0
  for (let i = 0; i < 4; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % 4]
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)
    if (Math.abs(cross) < 1e-9) continue
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

/** A photographed page: dark desk, light page inside `corners`, optional
 *  text stripes, illumination gradient, seeded noise. */
function syntheticPage ({
  width = 320, height = 240, corners, bg = 25, fg = 235,
  noise = 0, seed = 7, gradient = 0, textRows = 0,
} = {}) {
  const rand = mulberry32(seed)
  const data = new Uint8ClampedArray(width * height * 4)
  const ordered = orderCorners(corners)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = inQuad(ordered, x, y) ? fg : bg
      if (gradient) v -= (x / width) * gradient          // light falls off →
      if (noise) v += (rand() - 0.5) * 2 * noise
      const i = (y * width + x) * 4
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
    }
  }
  // "Text": dark horizontal stripes fully inside the quad's bounding box.
  if (textRows) {
    const xs = ordered.map((p) => p.x)
    const ys = ordered.map((p) => p.y)
    const x0 = Math.round(Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * 0.2)
    const x1 = Math.round(Math.max(...xs) - (Math.max(...xs) - Math.min(...xs)) * 0.2)
    const y0 = Math.min(...ys)
    const y1 = Math.max(...ys)
    for (let r = 0; r < textRows; r++) {
      const y = Math.round(y0 + ((r + 1) / (textRows + 1)) * (y1 - y0))
      for (let x = x0; x < x1; x++) {
        if (!inQuad(ordered, x, y)) continue
        const i = (y * width + x) * 4
        data[i] = 40; data[i + 1] = 40; data[i + 2] = 40
      }
    }
  }
  return { data, width, height }
}

const rotatedCorners = (cx, cy, w, h, deg) => {
  const a = (deg * Math.PI) / 180
  const rot = (x, y) => ({ x: cx + x * Math.cos(a) - y * Math.sin(a), y: cy + x * Math.sin(a) + y * Math.cos(a) })
  return [rot(-w / 2, -h / 2), rot(w / 2, -h / 2), rot(w / 2, h / 2), rot(-w / 2, h / 2)]
}

const cornerError = (got, truth) => Math.max(...orderCorners(truth).map((t, i) =>
  Math.hypot(got[i].x - t.x, got[i].y - t.y)))

/* ----------------------------------------------- 1. geometry helpers ------ */

check('orderCorners sorts a shuffled quad into TL,TR,BR,BL', (() => {
  const [tl, tr, br, bl] = orderCorners([{ x: 9, y: 9 }, { x: 0, y: 0 }, { x: 9, y: 0 }, { x: 0, y: 9 }])
  return tl.x === 0 && tl.y === 0 && tr.x === 9 && tr.y === 0 && br.x === 9 && br.y === 9 && bl.x === 0 && bl.y === 9
})())

check('polygonArea and convexity: square vs bowtie', (() => {
  const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
  const bowtie = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 10, y: 0 }, { x: 0, y: 10 }]
  return Math.abs(polygonArea(square)) === 100 && isConvex(square) === true && isConvex(bowtie) === false
})())

check('a rectangle has four 90° interior angles',
  quadAngles([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }])
    .every((a) => Math.abs(a - 90) < 1e-9))

check('sobel sees a vertical step as horizontal gradient, not vertical', (() => {
  const data = new Float32Array(16 * 16)
  for (let y = 0; y < 16; y++) for (let x = 8; x < 16; x++) data[y * 16 + x] = 1
  const { gx, gy } = sobel({ data, width: 16, height: 16 })
  const mid = 8 * 16 + 8
  return Math.abs(gx.data[mid - 1]) > 1 && Math.abs(gy.data[mid - 1]) < 1e-6
})())

check('integral image gives exact local means', (() => {
  const plane = { data: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]), width: 3, height: 3 }
  const integral = integralPlane(plane)
  return localMean(integral, 3, 3, 1, 1, 1) === 5 &&      // whole 3×3 mean
    localMean(integral, 3, 3, 0, 0, 0) === 1 &&           // single pixel
    localMean(integral, 3, 3, 2, 2, 1) === (5 + 6 + 8 + 9) / 4  // clamped corner
})())

check('planePercentile is exact on a known ramp', (() => {
  const plane = { data: Float32Array.from({ length: 101 }, (_, i) => i / 100), width: 101, height: 1 }
  return planePercentile(plane, 0) === 0 && planePercentile(plane, 50) === 0.5 && planePercentile(plane, 100) === 1
})())

/* ------------------------------------------------------ 2. Hough lines ---- */

check('a horizontal edge row votes into θ≈90°, ρ≈y', (() => {
  const data = new Float32Array(64 * 64)
  for (let x = 4; x < 60; x++) data[20 * 64 + x] = 1
  const [line] = houghLines({ data, width: 64, height: 64 }, { maxLines: 1 })
  return Math.abs(line.theta - Math.PI / 2) < 0.02 && Math.abs(line.rho - 20) <= 1
})())

check('a vertical edge column votes into θ≈0°, ρ≈x', (() => {
  const data = new Float32Array(64 * 64)
  for (let y = 4; y < 60; y++) data[y * 64 + 31] = 1
  const [line] = houghLines({ data, width: 64, height: 64 }, { maxLines: 1 })
  return Math.abs(line.theta) < 0.02 && Math.abs(line.rho - 31) <= 1
})())

check('intersectLines crosses a horizontal and a vertical where expected', (() => {
  const p = intersectLines({ theta: 0, rho: 31 }, { theta: Math.PI / 2, rho: 20 })
  return Math.abs(p.x - 31) < 1e-9 && Math.abs(p.y - 20) < 1e-9 &&
    intersectLines({ theta: 0.5, rho: 1 }, { theta: 0.5, rho: 9 }) === null
})())

/* --------------------------------------------- 3. homography (DLT) golden - */

const H0 = [1.1, 0.2, 5, -0.1, 0.9, 10, 0.0005, -0.0003, 1]
const SRC = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 140 }, { x: 0, y: 140 }]

check('DLT recovers a known homography to 1e-6', (() => {
  const dst = SRC.map((p) => applyHomography(H0, p))
  const H = homographyFromPoints(SRC, dst)
  return H0.every((v, i) => Math.abs(H[i] - v) < 1e-6)
})())

check('…and maps a FIFTH point projectively (not just the four it saw)', (() => {
  const dst = SRC.map((p) => applyHomography(H0, p))
  const H = homographyFromPoints(SRC, dst)
  const probe = { x: 37, y: 91 }
  const want = applyHomography(H0, probe)
  const got = applyHomography(H, probe)
  return Math.hypot(got.x - want.x, got.y - want.y) < 1e-6
})())

check('identity correspondence yields the identity matrix', (() => {
  const H = homographyFromPoints(SRC, SRC)
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1]
  return I.every((v, i) => Math.abs(H[i] - v) < 1e-9)
})())

check('three collinear points are a DEGENERATE null, not garbage numbers', (() => {
  const bad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 10 }]
  return homographyFromPoints(bad, SRC) === null
})())

check('invertHomography: H·H⁻¹ = I to 1e-9', (() => {
  const inv = invertHomography(H0)
  const I = mul3(H0, inv)
  const scaled = I.map((v) => v / I[8])
  return [1, 0, 0, 0, 1, 0, 0, 0, 1].every((v, i) => Math.abs(scaled[i] - v) < 1e-9)
})())

check('warp through a pure translation equals the crop it should be', (() => {
  const rand = mulberry32(3)
  const src = { data: new Uint8ClampedArray(32 * 32 * 4).map(() => Math.floor(rand() * 256)), width: 32, height: 32 }
  const H = [1, 0, 5, 0, 1, 7, 0, 0, 1]      // output (x,y) samples source (x+5, y+7)
  const out = warpPerspective(src, H, 10, 10)
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      for (let c = 0; c < 4; c++) {
        if (out.data[(y * 10 + x) * 4 + c] !== src.data[((y + 7) * 32 + (x + 5)) * 4 + c]) return false
      }
    }
  }
  return true
})())

/* ---------------------------------------- 4. quad detection golden pages -- */

const straightTruth = [{ x: 40, y: 30 }, { x: 280, y: 30 }, { x: 280, y: 210 }, { x: 40, y: 210 }]

check('GOLDEN straight page: corners found within 6px of truth', (() => {
  const found = detectDocumentQuad(syntheticPage({ corners: straightTruth }))
  return found.available === true && cornerError(found.corners, straightTruth) < 6 && found.score > 0.3
})())

check('GOLDEN rotated page (12°): corners found within 8px', (() => {
  const truth = rotatedCorners(160, 120, 220, 150, 12)
  const found = detectDocumentQuad(syntheticPage({ corners: truth }))
  return found.available === true && cornerError(found.corners, truth) < 8
})())

check('GOLDEN perspective page (trapezoid): corners found within 8px', (() => {
  const truth = [{ x: 70, y: 40 }, { x: 250, y: 55 }, { x: 275, y: 205 }, { x: 45, y: 190 }]
  const found = detectDocumentQuad(syntheticPage({ corners: truth }))
  return found.available === true && cornerError(found.corners, truth) < 8
})())

check('GOLDEN noisy rotated page (σ=12): still found within 10px', (() => {
  const truth = rotatedCorners(160, 120, 210, 140, -9)
  const found = detectDocumentQuad(syntheticPage({ corners: truth, noise: 12, seed: 21 }))
  return found.available === true && cornerError(found.corners, truth) < 10
})())

check('a FEATURELESS frame refuses NO_QUAD_FOUND — never a guessed centre crop', (() => {
  const rand = mulberry32(5)
  const flat = { data: new Uint8ClampedArray(320 * 240 * 4), width: 320, height: 240 }
  for (let i = 0; i < flat.data.length; i += 4) {
    const v = 128 + (rand() - 0.5) * 10
    flat.data[i] = v; flat.data[i + 1] = v; flat.data[i + 2] = v; flat.data[i + 3] = 255
  }
  const found = detectDocumentQuad(flat)
  return found.available === false && found.reason === VISION_UNAVAILABLE.NO_QUAD_FOUND
})())

check('a single edge is not a page: refusal names the missing evidence', (() => {
  const img = { data: new Uint8ClampedArray(320 * 240 * 4), width: 320, height: 240 }
  for (let y = 0; y < 240; y++) {
    for (let x = 0; x < 320; x++) {
      const v = x < 160 ? 30 : 220
      const i = (y * 320 + x) * 4
      img.data[i] = v; img.data[i + 1] = v; img.data[i + 2] = v; img.data[i + 3] = 255
    }
  }
  const found = detectDocumentQuad(img)
  return found.available === false && found.reason === VISION_UNAVAILABLE.NO_QUAD_FOUND
})())

/* -------------------------------------------------- 5. rectification ------ */

check('rectifying an axis-aligned page equals its crop (interior is pure page)', (() => {
  const image = syntheticPage({ corners: straightTruth })
  const r = rectifyDocument(image, straightTruth)
  if (!r.available) return false
  const luma = lumaPlane(r.image)
  let min = 1
  for (let y = 2; y < r.height - 2; y++) {
    for (let x = 2; x < r.width - 2; x++) min = Math.min(min, luma.data[y * luma.width + x])
  }
  return r.width === 241 && r.height === 181 && min > 0.85       // fg 235/255 ≈ 0.92
})())

check('rectifying a rotated page yields a front-on page of the right shape', (() => {
  const truth = rotatedCorners(160, 120, 200, 140, 15)
  const image = syntheticPage({ corners: truth })
  const r = rectifyDocument(image, truth)
  if (!r.available) return false
  const aspect = r.width / r.height
  const luma = lumaPlane(r.image)
  let sum = 0
  let n = 0
  for (let y = 4; y < r.height - 4; y++) {
    for (let x = 4; x < r.width - 4; x++) { sum += luma.data[y * luma.width + x]; n++ }
  }
  return Math.abs(aspect - 200 / 140) < 0.05 && sum / n > 0.85
})())

check('corners are accepted in ANY order — ordering is the module’s job', (() => {
  const image = syntheticPage({ corners: straightTruth })
  const shuffled = [straightTruth[2], straightTruth[0], straightTruth[3], straightTruth[1]]
  const r = rectifyDocument(image, shuffled)
  return r.available === true && r.width === 241 && r.height === 181
})())

check('a sliver quad is refused, not "rectified" into confetti', (() => {
  const image = syntheticPage({ corners: straightTruth })
  const sliver = [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 10 }, { x: 0, y: 10 }]
  const r = rectifyDocument(image, sliver)
  return r.available === false && r.reason === VISION_UNAVAILABLE.NO_QUAD_FOUND
})())

check('rectifiedSize caps the long side and keeps aspect', (() => {
  const big = [{ x: 0, y: 0 }, { x: 4800, y: 0 }, { x: 4800, y: 2400 }, { x: 0, y: 2400 }]
  const s = rectifiedSize(big, { maxOutputSize: 2400 })
  return s.width === 2400 && s.height === 1200
})())

/* ----------------------------------------------------- 6. enhancement ----- */

check('B/W adaptive threshold survives an illumination gradient a global cutoff cannot', (() => {
  const image = syntheticPage({ corners: straightTruth, gradient: 120, textRows: 3 })
  const bw = adaptiveThreshold(image)
  const at = (x, y) => bw.data[(y * bw.width + x) * 4]
  const binary = (() => {
    for (let i = 0; i < bw.data.length; i += 4) { if (bw.data[i] !== 0 && bw.data[i] !== 255) return false }
    return true
  })()
  // Text row 2 of 3 sits at y = 30 + (2/4)·180 = 120; paper right above it.
  // x=250 is deep in the darkened (gradient) side of the page.
  return binary && at(250, 120) === 0 && at(250, 110) === 255 && at(70, 120) === 0 && at(70, 110) === 255
})())

check('color mode flattens the gradient: dark-side paper turns white, ink stays ink', (() => {
  const image = syntheticPage({ corners: straightTruth, gradient: 120, textRows: 3 })
  const out = enhancePage(image, 'color')
  if (!out.available) return false
  const at = (x, y) => out.image.data[(y * out.image.width + x) * 4]
  const before = image.data[(110 * 320 + 250) * 4]
  return before < 160 && at(250, 110) >= 200 && at(250, 120) <= 130
})())

check('original mode is a COPY, not a reference', (() => {
  const image = syntheticPage({ corners: straightTruth })
  const out = enhancePage(image, 'original')
  const same = out.image.data.every((v, i) => v === image.data[i])
  image.data[0] = 1
  return out.available === true && same && out.image.data[0] !== 1
})())

check('an unknown enhance mode is BAD_INPUT naming the real modes', (() => {
  const out = enhancePage(syntheticPage({ corners: straightTruth }), 'sepia')
  return out.available === false && out.reason === VISION_UNAVAILABLE.BAD_INPUT && /color/.test(out.detail)
})())

/* ------------------------------------------ 7. one-shot page + assembly --- */

check('scanDocumentPage: detect → rectify → enhance in one honest chain', (() => {
  const truth = rotatedCorners(160, 120, 220, 150, 10)
  const out = scanDocumentPage(syntheticPage({ corners: truth, textRows: 2 }), { mode: 'bw' })
  return out.available === true && out.mode === 'bw' && out.page.width > 100 &&
    typeof out.score === 'number' && out.corners.length === 4
})())

check('…and passes a caller-supplied quad through, skipping detection', (() => {
  const out = scanDocumentPage(syntheticPage({ corners: straightTruth }), { mode: 'original', quad: straightTruth })
  return out.available === true && out.score === null && out.width === 241
})())

check('…and a pageless frame propagates the detector’s refusal unchanged', (() => {
  const flat = { data: new Uint8ClampedArray(320 * 240 * 4).fill(128), width: 320, height: 240 }
  for (let i = 3; i < flat.data.length; i += 4) flat.data[i] = 255
  const out = scanDocumentPage(flat, { mode: 'bw' })
  return out.available === false && out.reason === VISION_UNAVAILABLE.NO_QUAD_FOUND
})())

await checkAsync('the assembler copies pages in, caps the count, and encodes REAL PNGs', async () => {
  const assembler = createDocumentAssembler({ maxPages: 2 })
  const page = syntheticPage({ corners: straightTruth, width: 40, height: 30 })
  const added = assembler.addPage(page, { mode: 'color' })
  page.data[0] = 9                                     // caller mutates AFTER add
  assembler.addPage(page, { name: 'receipt' })
  const third = assembler.addPage(page)
  const blobs = await assembler.toBlobs()
  const bytes = new Uint8Array(await blobs.pages[0].blob.arrayBuffer())
  const header = readPngHeader(bytes)
  return added.available === true && third.reason === VISION_UNAVAILABLE.INPUT_TOO_LARGE &&
    blobs.count === 2 && blobs.pages[1].name === 'receipt' && blobs.pages[0].type === 'image/png' &&
    header !== null && header.width === 40 && header.height === 30 && header.bitDepth === 8 && header.colorType === 6 &&
    bytes[0] !== 9 /* the mutation did not reach the stored page */
})

await checkAsync('an injected encoder wins; a THROWING one falls back to the PNG floor', async () => {
  const assembler = createDocumentAssembler({
    encode: async () => new Blob([new Uint8Array([1])], { type: 'image/jpeg' }),
  })
  assembler.addPage(syntheticPage({ corners: straightTruth, width: 16, height: 16 }))
  const jpeg = await assembler.toBlobs()
  const broken = createDocumentAssembler({ encode: async () => { throw new Error('no canvas') } })
  broken.addPage(syntheticPage({ corners: straightTruth, width: 16, height: 16 }))
  const fallback = await broken.toBlobs()
  const header = readPngHeader(new Uint8Array(await fallback.pages[0].blob.arrayBuffer()))
  return jpeg.pages[0].type === 'image/jpeg' && fallback.pages[0].type === 'image/png' && header?.width === 16
})

await checkAsync('THE PNG IS REAL: node:zlib inflates the IDAT back to the exact scanlines', async () => {
  const rand = mulberry32(11)
  const image = { data: new Uint8ClampedArray(9 * 5 * 4).map(() => Math.floor(rand() * 256)), width: 9, height: 5 }
  const png = encodePng(image)
  // Walk chunks to the IDAT payload.
  let o = 8
  let idat = null
  while (o < png.length) {
    const view = new DataView(png.buffer, png.byteOffset)
    const len = view.getUint32(o)
    const type = String.fromCharCode(png[o + 4], png[o + 5], png[o + 6], png[o + 7])
    if (type === 'IDAT') idat = png.subarray(o + 8, o + 8 + len)
    o += 12 + len
  }
  const raw = inflateSync(idat)
  if (raw.length !== 5 * (1 + 9 * 4)) return false
  for (let y = 0; y < 5; y++) {
    const row = y * (1 + 9 * 4)
    if (raw[row] !== 0) return false                    // filter byte: None
    for (let i = 0; i < 9 * 4; i++) { if (raw[row + 1 + i] !== image.data[y * 9 * 4 + i]) return false }
  }
  const twice = encodePng(image)
  return png.length === twice.length && png.every((v, i) => v === twice[i]) &&
    encodePngBlob(image).type === 'image/png'
})

console.log('\n========================================')
console.log('  vision docscan — DLT golden, Hough pages, honest refusals, real PNGs')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
