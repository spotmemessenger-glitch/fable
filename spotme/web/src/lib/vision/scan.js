/**
 * Spot Me vision — the multi-format scan engine over the camera
 * FrameSource.
 *
 * TWO DECODERS, AND THE NATIVE ONE IS PREFERRED — the qr-scan.js posture,
 * extended to every format `BarcodeDetector` really supports. On Chromium
 * (which includes the packaged Android WebView) the native detector reads
 * EAN/UPC/Code128/DataMatrix/PDF417/Aztec and more with no third-party
 * code; jsQR (already a dependency, imported LAZILY) is the fallback and
 * it reads exactly ONE format: qr_code. Nothing here relabels the
 * fallback as a multi-format scanner — asking for ean_13 on Safari is an
 * honest NO_DETECTOR, not a scanner that never beeps.
 *
 * The result contract every decode path lands on:
 *
 *   { format, value, corners, engine }
 *     format   'qr_code' | 'ean_13' | …   (BarcodeDetector vocabulary)
 *     value    the decoded string
 *     corners  [{x,y} ×4] in SOURCE pixel coordinates (TL,TR,BR,BL), or
 *              null when the decoder gave none
 *     engine   SCAN_ENGINE.* — which decoder actually read it, always
 *
 * NOTHING HAPPENS ON IMPORT: no feature test, no camera, no module load —
 * the jsQR import lives inside the function that needs it.
 */

import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'
import { realClock } from '../camera/clock.js'
import { PUMP } from '../camera/frame-source.js'

export const SCAN_ENGINE = Object.freeze({
  BARCODE_DETECTOR: 'barcode-detector',
  JSQR: 'jsqr',
})

/** The formats this engine will request from BarcodeDetector. The closed
 *  list keeps a typo'd format an error instead of a scanner that silently
 *  never matches. */
export const SCAN_FORMATS = Object.freeze([
  'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39',
  'code_93', 'itf', 'codabar', 'data_matrix', 'pdf417', 'aztec',
])

/** The one format the pure-JS fallback can read. */
export const JSQR_FORMATS = Object.freeze(['qr_code'])

/**
 * What can decode HERE. Feature detection only — no camera, no prompt.
 * `native.formats` is the browser's own answer where it gives one;
 * `verified:false` marks the (old-Chromium) case where BarcodeDetector
 * exists but cannot enumerate, so support is claimed, not proven.
 */
export async function scannerSupport (env = globalThis) {
  const support = { native: { present: false, formats: null, verified: false }, fallback: { formats: [...JSQR_FORMATS] } }
  if (typeof env.BarcodeDetector === 'function') {
    support.native.present = true
    if (typeof env.BarcodeDetector.getSupportedFormats === 'function') {
      try {
        support.native.formats = [...await env.BarcodeDetector.getSupportedFormats()]
        support.native.verified = true
      } catch { support.native.formats = null }
    }
  }
  return Object.freeze(support)
}

/**
 * Build a reader for a set of formats, choosing the decoder honestly.
 *
 * Native covers the request (fully or partly) → BarcodeDetector, with the
 * unsupported remainder NAMED in the facts. No native, request is QR-only →
 * jsQR. No native, request needs more than QR → NO_DETECTOR with the exact
 * formats that cannot be read. `deps` injects both decoders for tests.
 */
export async function createBarcodeReader ({ formats = ['qr_code'], env = globalThis, deps = {} } = {}) {
  if (!Array.isArray(formats) || formats.length === 0) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'formats must be a non-empty array')
  }
  const unknown = formats.filter((f) => !SCAN_FORMATS.includes(f))
  if (unknown.length) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, `unknown formats: ${unknown.join(', ')}`)
  }

  const support = deps.support || await scannerSupport(env)
  if (support.native.present) {
    const claimed = support.native.formats
    const usable = claimed ? formats.filter((f) => claimed.includes(f)) : [...formats]
    const unsupported = formats.filter((f) => !usable.includes(f))
    if (usable.length) {
      const Detector = deps.BarcodeDetector || env.BarcodeDetector
      const detector = deps.detector || new Detector({ formats: usable })
      return available({
        engine: SCAN_ENGINE.BARCODE_DETECTOR,
        formats: usable,
        unsupported,
        verified: support.native.verified,
        needsPixels: false,
        async detect (source) {
          const found = await detector.detect(source)
          return (found || []).map((r) => normalizeNativeResult(r)).filter(Boolean)
        },
      })
    }
    // Native exists but supports none of the request — fall through to the
    // QR-only question below rather than pretending.
  }

  const qrOnly = formats.every((f) => f === 'qr_code')
  if (qrOnly) {
    return available({
      engine: SCAN_ENGINE.JSQR,
      formats: [...JSQR_FORMATS],
      unsupported: [],
      verified: true,
      needsPixels: true,
      async detect (image) {
        if (!image?.data || !image.width || !image.height) return []
        // Lazily imported so browsers with a native detector never fetch it.
        const jsQR = deps.jsQR || (await import('jsqr')).default
        const hit = jsQR(image.data, image.width, image.height)
        const one = normalizeJsqrResult(hit)
        return one ? [one] : []
      },
    })
  }
  const beyond = formats.filter((f) => f !== 'qr_code')
  return unavailable(VISION_UNAVAILABLE.NO_DETECTOR,
    `no BarcodeDetector here and the jsQR fallback reads only qr_code — cannot read: ${beyond.join(', ')}`)
}

/** BarcodeDetector result → the contract. cornerPoints is already TL,TR,BR,BL. */
export function normalizeNativeResult (r) {
  if (!r || typeof r.rawValue !== 'string' || !r.rawValue) return null
  const corners = Array.isArray(r.cornerPoints) && r.cornerPoints.length === 4
    ? r.cornerPoints.map((p) => ({ x: p.x, y: p.y }))
    : null
  return { format: r.format || 'unknown', value: r.rawValue, corners, engine: SCAN_ENGINE.BARCODE_DETECTOR }
}

/** jsQR result → the contract. Its location object becomes TL,TR,BR,BL. */
export function normalizeJsqrResult (hit) {
  if (!hit || typeof hit.data !== 'string' || !hit.data) return null
  const loc = hit.location
  const corners = loc
    ? [loc.topLeftCorner, loc.topRightCorner, loc.bottomRightCorner, loc.bottomLeftCorner]
        .map((p) => (p ? { x: p.x, y: p.y } : null))
    : null
  return {
    format: 'qr_code',
    value: hit.data,
    corners: corners && corners.every(Boolean) ? corners : null,
    engine: SCAN_ENGINE.JSQR,
  }
}

/* ------------------------------------------------------------- pixels ---- */

/**
 * A fractional ROI {x,y,width,height} in 0..1 of the frame → integer pixel
 * rect, clamped inside. Fractions because the caller usually means "the
 * middle two-thirds of the viewfinder" regardless of stream resolution.
 */
export function roiToRect (roi, width, height) {
  const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0))
  const x = Math.round(clamp01(roi.x) * width)
  const y = Math.round(clamp01(roi.y) * height)
  const w = Math.min(width - x, Math.max(1, Math.round(clamp01(roi.width) * width)))
  const h = Math.min(height - y, Math.max(1, Math.round(clamp01(roi.height) * height)))
  return { x, y, width: w, height: h }
}

/** Crop an ImageData-like image to a pixel rect. Fresh buffer, input untouched. */
export function cropImage (image, rect) {
  const { data, width } = image
  const out = new Uint8ClampedArray(rect.width * rect.height * 4)
  for (let y = 0; y < rect.height; y++) {
    const srcStart = ((rect.y + y) * width + rect.x) * 4
    out.set(data.subarray(srcStart, srcStart + rect.width * 4), y * rect.width * 4)
  }
  return { data: out, width: rect.width, height: rect.height }
}

/**
 * The default frame→pixels path, feature-detected once per scanner:
 * frames that already carry bytes (interval-canvas pump, test fakes) pass
 * through; GPU-side frames (VideoFrame/ImageBitmap) are drawn through an
 * OffscreenCanvas. Returns null when NO path exists — the caller turns
 * that into an honest NO_PIXEL_ACCESS instead of a scanner that never
 * fires.
 */
export function defaultToImageData (env = globalThis) {
  let canvas = null
  let ctx = null
  return (frame, width, height) => {
    if (frame && frame.data && (frame.width || width) && (frame.height || height)) {
      return { data: frame.data, width: frame.width || width, height: frame.height || height }
    }
    if (typeof env.OffscreenCanvas !== 'function') return null
    const w = width || frame?.codedWidth || frame?.width || 0
    const h = height || frame?.codedHeight || frame?.height || 0
    if (!w || !h) return null
    try {
      if (!canvas || canvas.width !== w || canvas.height !== h) {
        canvas = new env.OffscreenCanvas(w, h)
        ctx = canvas.getContext('2d', { willReadFrequently: true })
      }
      ctx.drawImage(frame, 0, 0)
      return ctx.getImageData(0, 0, w, h)
    } catch { return null }
  }
}

/* -------------------------------------------------------- one-shot ------- */

/**
 * Decode one image (ImageData-like, or a native-detectable source when the
 * reader does not need pixels). ROI is cropped BEFORE decode and corners
 * are mapped back to full-frame coordinates, so a caller can trust corners
 * regardless of the roi option.
 */
export async function readImage (reader, input, { roi = null } = {}) {
  if (!reader?.available) return []
  let source = input
  let offsetX = 0
  let offsetY = 0
  if (roi && input?.data && input.width && input.height) {
    const rect = roiToRect(roi, input.width, input.height)
    source = cropImage(input, rect)
    offsetX = rect.x
    offsetY = rect.y
  }
  const results = await reader.detect(source)
  if (!offsetX && !offsetY) return results
  return results.map((r) => ({
    ...r,
    corners: r.corners ? r.corners.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })) : null,
  }))
}

/* ------------------------------------------------- continuous scanning --- */

/**
 * Re-detection suppression for a live viewfinder. A code sitting in frame
 * decodes on every pump tick; without this the caller beeps 8×/second at
 * the same tin of beans. A (format,value) pair fires once, then again only
 * after it has been OUT of sight for `windowMs` — every sighting refreshes
 * the clock, so "still in frame" never re-fires.
 */
export function createDedup ({ windowMs = 1500, clock = null } = {}) {
  const clk = clock || realClock()
  const lastSeen = new Map()
  return {
    /** true → this sighting is NEW and should be reported. */
    offer (format, value) {
      const key = `${format} ${value}`
      const now = clk.now()
      const prev = lastSeen.get(key)
      lastSeen.set(key, now)
      if (lastSeen.size > 256) {
        for (const [k, ts] of lastSeen) { if (now - ts > windowMs) lastSeen.delete(k) }
      }
      return prev === undefined || now - prev >= windowMs
    },
    reset () { lastSeen.clear() },
  }
}

/**
 * Continuous scan over a camera FrameSource (SEAM #1).
 *
 * Frames arrive throttled to `fps` with the seam's own drop-oldest
 * backpressure, so a slow decode can never stall the camera — it just sees
 * fewer, fresher frames. The delivered frame is only borrowed (valid until
 * the callback resolves), which the decode path respects by never
 * retaining it: pixels are read synchronously, native detect() is awaited
 * inside the callback.
 *
 * Returns { available:true, stop(), stats() } or an honest refusal:
 * NO_PIXEL_ACCESS when the reader needs bytes and no conversion path
 * exists, or FAILED naming the frame source's own reason.
 */
export function scanFrames (source, reader, {
  fps = 8, roi = null, dedupMs = 1500, toImageData = null, env = globalThis, clock = null,
  onResult, onError,
} = {}) {
  if (!reader?.available) {
    return unavailable(VISION_UNAVAILABLE.NO_DETECTOR, 'create a reader first — its refusal says why')
  }
  const needsPixels = reader.needsPixels || Boolean(roi)
  if (needsPixels && !toImageData) {
    // Static honesty: a software decoder over a GPU-frame pump with no
    // readback path would subscribe forever and never decode a thing.
    const pump = source.pumpKind?.()
    if (pump !== PUMP.INTERVAL_CANVAS && typeof env.OffscreenCanvas !== 'function') {
      return unavailable(VISION_UNAVAILABLE.NO_PIXEL_ACCESS,
        `the '${pump}' pump delivers GPU-side frames and no OffscreenCanvas exists to read pixels back`)
    }
  }
  const convert = toImageData || defaultToImageData(env)
  const dedup = createDedup({ windowMs: dedupMs, clock })
  const stats = { framesSeen: 0, framesDecoded: 0, framesUnreadable: 0, hits: 0, suppressed: 0 }

  const sub = source.subscribeFrames(async ({ frame, width, height, ts, seq }) => {
    stats.framesSeen++
    try {
      let input = frame
      if (needsPixels) {
        input = convert(frame, width, height)
        if (!input) { stats.framesUnreadable++; return }
      }
      const results = await readImage(reader, input, { roi })
      stats.framesDecoded++
      for (const result of results) {
        if (dedup.offer(result.format, result.value)) {
          stats.hits++
          onResult?.({ ...result, ts, seq })
        } else {
          stats.suppressed++
        }
      }
    } catch (e) {
      // One bad frame is ordinary; the loop keeps looking. The error is
      // still surfaced so a systematically broken decoder is visible.
      onError?.(e)
    }
  }, { fps })

  if (!sub.available) {
    return unavailable(VISION_UNAVAILABLE.FAILED, `frame source refused: ${sub.reason}`)
  }
  return available({
    stop: () => sub.unsubscribe(),
    stats: () => ({ ...stats }),
    engine: reader.engine,
  })
}
