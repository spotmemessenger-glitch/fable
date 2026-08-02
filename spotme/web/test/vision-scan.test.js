/**
 * Proves the scan engine: honest decoder choice per environment, the
 * {format, value, corners, engine} contract, a REAL jsQR round-trip on
 * REAL QR pixels (qrcode-generator draws, jsQR reads — no mocked decode
 * pretending), ROI cropping with corner mapping, dedup of repeated reads,
 * and continuous scanning over the camera FrameSource with its
 * backpressure intact.
 *
 *   node test/vision-scan.test.js
 */
import qrcode from 'qrcode-generator'
import {
  SCAN_ENGINE, SCAN_FORMATS, JSQR_FORMATS, scannerSupport, createBarcodeReader,
  normalizeNativeResult, normalizeJsqrResult, roiToRect, cropImage,
  defaultToImageData, readImage, createDedup, scanFrames,
} from '../src/lib/vision/scan.js'
import { VISION_UNAVAILABLE } from '../src/lib/vision/availability.js'
import { openSession } from '../src/lib/camera/session.js'
import { createFrameSource } from '../src/lib/camera/frame-source.js'
import { manualClock } from '../src/lib/camera/clock.js'
import { androidChromeLike, FakeVideoFrame } from './helpers/fake-media.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

/* ------------------------------------------------------------ fixtures ---- */

/** REAL QR pixels: qrcode-generator paints the modules into RGBA. */
function qrImage (payload, { scale = 8, margin = 4, offsetX = 0, offsetY = 0, width = null, height = null } = {}) {
  const qr = qrcode(0, 'M')
  qr.addData(payload)
  qr.make()
  const n = qr.getModuleCount()
  const size = (n + margin * 2) * scale
  const W = width || size
  const H = height || size
  const data = new Uint8ClampedArray(W * H * 4).fill(255)   // white, opaque
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = offsetX + (margin + c) * scale + dx
          const py = offsetY + (margin + r) * scale + dy
          if (px < 0 || py < 0 || px >= W || py >= H) continue
          const i = (py * W + px) * 4
          data[i] = 0; data[i + 1] = 0; data[i + 2] = 0
        }
      }
    }
  }
  return { data, width: W, height: H }
}

const nativeEnv = (formats) => ({
  BarcodeDetector: Object.assign(function BarcodeDetector () {}, {
    getSupportedFormats: async () => formats,
  }),
})

/* ------------------------------------------------ 1. support probing ------ */

await checkAsync('a Chromium-like env reports native support, VERIFIED via getSupportedFormats', async () => {
  const s = await scannerSupport(nativeEnv(['qr_code', 'ean_13']))
  return s.native.present === true && s.native.verified === true &&
    s.native.formats.join(',') === 'qr_code,ean_13' && s.fallback.formats.join(',') === 'qr_code'
})

await checkAsync('BarcodeDetector without enumeration is present but UNVERIFIED — labeled, not assumed', async () => {
  const s = await scannerSupport({ BarcodeDetector: function () {} })
  return s.native.present === true && s.native.verified === false && s.native.formats === null
})

await checkAsync('bare Node has no native detector and the fallback still names its one format', async () => {
  const s = await scannerSupport({})
  return s.native.present === false && s.fallback.formats.join(',') === 'qr_code'
})

check('the format list is closed and jsQR claims exactly qr_code',
  SCAN_FORMATS.includes('qr_code') && SCAN_FORMATS.includes('ean_13') &&
  JSQR_FORMATS.length === 1 && JSQR_FORMATS[0] === 'qr_code')

/* ------------------------------------------- 2. honest reader creation ---- */

await checkAsync('native covering the request → barcode-detector engine, no pixel need', async () => {
  const r = await createBarcodeReader({ formats: ['qr_code', 'ean_13'], env: nativeEnv(['qr_code', 'ean_13', 'aztec']) })
  return r.available === true && r.engine === SCAN_ENGINE.BARCODE_DETECTOR &&
    r.formats.join(',') === 'qr_code,ean_13' && r.unsupported.length === 0 && r.needsPixels === false
})

await checkAsync('native covering PART of the request names the unsupported remainder', async () => {
  const r = await createBarcodeReader({ formats: ['qr_code', 'pdf417'], env: nativeEnv(['qr_code']) })
  return r.available === true && r.formats.join(',') === 'qr_code' && r.unsupported.join(',') === 'pdf417'
})

await checkAsync('no native + QR-only request → the jsQR fallback, which NEEDS pixels', async () => {
  const r = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  return r.available === true && r.engine === SCAN_ENGINE.JSQR && r.needsPixels === true
})

await checkAsync('no native + multi-format request is an HONEST NO_DETECTOR naming what cannot be read', async () => {
  const r = await createBarcodeReader({ formats: ['qr_code', 'ean_13', 'code_128'], env: {} })
  return r.available === false && r.reason === VISION_UNAVAILABLE.NO_DETECTOR &&
    /ean_13, code_128/.test(r.detail)
})

await checkAsync('an unknown format is BAD_INPUT, not a scanner that never matches', async () => {
  const r = await createBarcodeReader({ formats: ['qr'], env: nativeEnv(['qr_code']) })
  return r.available === false && r.reason === VISION_UNAVAILABLE.BAD_INPUT && /qr/.test(r.detail)
})

await checkAsync('an empty format list is BAD_INPUT', async () => {
  const r = await createBarcodeReader({ formats: [], env: {} })
  return r.available === false && r.reason === VISION_UNAVAILABLE.BAD_INPUT
})

/* ------------------------------------------------- 3. result contract ----- */

check('a native result normalizes to {format, value, corners, engine}', (() => {
  const r = normalizeNativeResult({
    rawValue: 'v', format: 'ean_13',
    cornerPoints: [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }],
  })
  return r.format === 'ean_13' && r.value === 'v' && r.engine === SCAN_ENGINE.BARCODE_DETECTOR &&
    r.corners.length === 4 && r.corners[2].x === 3 && r.corners[2].y === 4
})())

check('a native result with no corner points carries corners:null, never fake corners',
  normalizeNativeResult({ rawValue: 'v', format: 'qr_code' }).corners === null)

check('an empty native value is dropped (a detector that "found" nothing is not a hit)',
  normalizeNativeResult({ rawValue: '', format: 'qr_code' }) === null &&
  normalizeNativeResult(null) === null)

check('a jsQR result normalizes with TL,TR,BR,BL corner order', (() => {
  const r = normalizeJsqrResult({
    data: 'v',
    location: {
      topLeftCorner: { x: 0, y: 0 }, topRightCorner: { x: 9, y: 0 },
      bottomRightCorner: { x: 9, y: 9 }, bottomLeftCorner: { x: 0, y: 9 },
    },
  })
  return r.format === 'qr_code' && r.engine === SCAN_ENGINE.JSQR &&
    r.corners[1].x === 9 && r.corners[3].y === 9
})())

/* ------------------------------------ 4. REAL decode: jsQR reads real QR -- */

await checkAsync('THE ROUND TRIP: qrcode-generator paints, the real jsQR decodes, contract holds', async () => {
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const image = qrImage('spotme://verify/12345')
  const hits = await readImage(reader, image)
  return hits.length === 1 && hits[0].value === 'spotme://verify/12345' &&
    hits[0].format === 'qr_code' && hits[0].engine === SCAN_ENGINE.JSQR &&
    Array.isArray(hits[0].corners) && hits[0].corners.length === 4
})

await checkAsync('a blank frame decodes to NO results, not a crash', async () => {
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 }
  return (await readImage(reader, blank)).length === 0
})

/* --------------------------------------------------------------- 5. ROI --- */

check('roiToRect maps fractions to clamped integer pixels', (() => {
  const r = roiToRect({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, 400, 200)
  return r.x === 100 && r.y === 50 && r.width === 200 && r.height === 100
})())

check('roiToRect clamps an out-of-range roi inside the frame', (() => {
  const r = roiToRect({ x: 0.9, y: 0.9, width: 0.5, height: 0.5 }, 100, 100)
  return r.x === 90 && r.y === 90 && r.width === 10 && r.height === 10
})())

check('cropImage is pixel-exact and leaves the input untouched', (() => {
  const src = { data: new Uint8ClampedArray(4 * 4 * 4).map((_, i) => i % 256), width: 4, height: 4 }
  const before = [...src.data]
  const out = cropImage(src, { x: 1, y: 1, width: 2, height: 2 })
  const at = (img, x, y) => img.data[(y * img.width + x) * 4]
  return out.width === 2 && out.height === 2 &&
    at(out, 0, 0) === at(src, 1, 1) && at(out, 1, 1) === at(src, 2, 2) &&
    src.data.every((v, i) => v === before[i])
})())

await checkAsync('a QR inside the ROI decodes with corners mapped BACK to full-frame coordinates', async () => {
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  // 500×500 white frame, QR drawn in the top-left quadrant at (10,10).
  const image = qrImage('roi-hit', { offsetX: 10, offsetY: 10, width: 500, height: 500 })
  const inRoi = await readImage(reader, image, { roi: { x: 0, y: 0, width: 0.5, height: 0.5 } })
  const full = await readImage(reader, image)
  if (inRoi.length !== 1 || full.length !== 1) return false
  const drift = Math.max(...inRoi[0].corners.map((p, i) =>
    Math.abs(p.x - full[0].corners[i].x) + Math.abs(p.y - full[0].corners[i].y)))
  return inRoi[0].value === 'roi-hit' && drift < 2
})

await checkAsync('a ROI that excludes the code finds nothing — the crop is real', async () => {
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const image = qrImage('roi-miss', { offsetX: 10, offsetY: 10, width: 500, height: 500 })
  const hits = await readImage(reader, image, { roi: { x: 0.55, y: 0.55, width: 0.45, height: 0.45 } })
  return hits.length === 0
})

/* ------------------------------------------------------------- 6. dedup --- */

check('the same code fires once and is suppressed while it stays in frame', (() => {
  const clock = manualClock()
  const d = createDedup({ windowMs: 1500, clock })
  const first = d.offer('qr_code', 'A')
  clock.advance(200)
  const second = d.offer('qr_code', 'A')
  clock.advance(200)
  const third = d.offer('qr_code', 'A')
  return first === true && second === false && third === false
})())

check('…and fires again only after it has been OUT of frame for the window', (() => {
  const clock = manualClock()
  const d = createDedup({ windowMs: 1500, clock })
  d.offer('qr_code', 'A')
  clock.advance(1000)
  const still = d.offer('qr_code', 'A')     // sighting refreshes the clock
  clock.advance(1400)
  const tooSoon = d.offer('qr_code', 'A')   // only 1400ms since last sighting
  clock.advance(1600)
  const again = d.offer('qr_code', 'A')
  return still === false && tooSoon === false && again === true
})())

check('different values are independent, and format is part of the identity', (() => {
  const clock = manualClock()
  const d = createDedup({ windowMs: 1500, clock })
  return d.offer('qr_code', 'A') === true && d.offer('qr_code', 'B') === true &&
    d.offer('ean_13', 'A') === true && d.offer('qr_code', 'A') === false
})())

/* -------------------------------------- 7. continuous scan over the seam -- */

async function liveSource () {
  const env = androidChromeLike()
  const clock = manualClock(1000)
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  return { env, clock, session, source }
}
const frameOf = (image, ts) => new FakeVideoFrame({ timestamp: ts * 1000, width: image.width, height: image.height, data: image.data })
const passPixels = (frame, w, h) => ({ data: frame.data, width: w, height: h })

await checkAsync('a live scan decodes REAL QR frames off the FrameSource and dedups repeats', async () => {
  const { clock, session, source } = await liveSource()
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const image = qrImage('live-code')
  const hits = []
  const scan = scanFrames(source, reader, {
    fps: 8, dedupMs: 1500, toImageData: passPixels, clock,
    onResult: (r) => hits.push(r),
  })
  if (!scan.available) return false
  await settle()
  for (let i = 0; i < 3; i++) {           // same code, three pump ticks
    session.track().emitFrame(frameOf(image, i))
    await settle()                        // deliver at the CURRENT clock time
    await clock.advance(200)              // then step past the fps throttle
  }
  const onceWhileVisible = hits.length === 1 && hits[0].value === 'live-code' &&
    hits[0].engine === SCAN_ENGINE.JSQR && typeof hits[0].ts === 'number'
  await clock.advance(2000)               // out of frame long enough
  session.track().emitFrame(frameOf(image, 9))
  await settle()
  const stats = scan.stats()
  scan.stop()
  return onceWhileVisible && hits.length === 2 && stats.suppressed >= 1 && stats.framesDecoded >= 3
})

await checkAsync('a different code in frame fires immediately — dedup is per value', async () => {
  const { clock, session, source } = await liveSource()
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const hits = []
  const scan = scanFrames(source, reader, { fps: 8, toImageData: passPixels, clock, onResult: (r) => hits.push(r) })
  await settle()
  session.track().emitFrame(frameOf(qrImage('code-one'), 0))
  await settle()                          // deliver at the CURRENT clock time
  await clock.advance(200)                // then step past the fps throttle
  session.track().emitFrame(frameOf(qrImage('code-two'), 1))
  await settle()
  scan.stop()
  return hits.map((h) => h.value).join(',') === 'code-one,code-two'
})

await checkAsync('stop() unsubscribes: later frames are neither seen nor decoded', async () => {
  const { clock, session, source } = await liveSource()
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const scan = scanFrames(source, reader, { fps: 8, toImageData: passPixels, clock, onResult: () => {} })
  await settle()
  session.track().emitFrame(frameOf(qrImage('x'), 0))
  await settle()
  const seenBefore = scan.stats().framesSeen
  scan.stop()
  await clock.advance(200)
  session.track().emitFrame(frameOf(qrImage('x'), 1))
  await settle()
  return seenBefore === 1 && scan.stats().framesSeen === 1
})

await checkAsync('a software decoder over a GPU pump with NO readback path refuses: NO_PIXEL_ACCESS', async () => {
  const { source } = await liveSource()   // android env has no OffscreenCanvas
  const reader = await createBarcodeReader({ formats: ['qr_code'], env: {} })
  const scan = scanFrames(source, reader, { fps: 8, env: {}, onResult: () => {} })
  return scan.available === false && scan.reason === VISION_UNAVAILABLE.NO_PIXEL_ACCESS &&
    /track-processor/.test(scan.detail)
})

await checkAsync('a refused reader passed to scanFrames is a named refusal, not a crash', async () => {
  const { source } = await liveSource()
  const refused = await createBarcodeReader({ formats: ['ean_13'], env: {} })
  const scan = scanFrames(source, refused, { onResult: () => {} })
  return scan.available === false && scan.reason === VISION_UNAVAILABLE.NO_DETECTOR
})

await checkAsync('defaultToImageData passes byte-carrying frames through untouched', async () => {
  const convert = defaultToImageData({})
  const image = qrImage('bytes')
  const out = convert({ data: image.data, width: image.width, height: image.height })
  return out.data === image.data && out.width === image.width
})

console.log('\n========================================')
console.log('  vision scan — honest engines, real decodes, dedup, seam')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
