/**
 * Spot Me — Creative Studio image I/O.
 *
 * Boundary between browser image objects (Blob, ImageBitmap, canvas) and the
 * plain pixel buffers every algorithm in this module operates on. The pixel
 * type is deliberately NOT the DOM's ImageData class but its shape:
 *
 *     { width, height, data: Uint8ClampedArray }   // RGBA, row-major
 *
 * so the whole CPU pipeline runs identically in Node tests and in the
 * browser. Anything that needs a real DOM object is confined to the clearly
 * marked browser-only section and guarded, never assumed.
 *
 * EXIF handling is READ-ONLY and orientation-only: we parse the orientation
 * tag so a portrait photo edits upright, and we never copy EXIF forward.
 * Exports go through canvas re-encode, which produces a fresh file with no
 * metadata block at all — that is the GPS-stripping property the threat model
 * relies on (docs/ai-camera/studio-threat-model.md), achieved by never
 * carrying metadata rather than by trying to scrub it.
 */

/* ------------------------------------------------------------ pixel type */

/** Allocate a zeroed RGBA image. Throws on non-positive or absurd sizes. */
export function makeImage (width, height) {
  const w = Math.trunc(width)
  const h = Math.trunc(height)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1) {
    throw new RangeError(`bad image size ${width}x${height}`)
  }
  if (w * h > MAX_PIXELS) throw new RangeError(`image ${w}x${h} exceeds ${MAX_PIXELS} px budget`)
  return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }
}

export function cloneImage (img) {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
}

export function isImage (img) {
  return Boolean(img) && Number.isInteger(img.width) && Number.isInteger(img.height) &&
    img.width > 0 && img.height > 0 &&
    (img.data instanceof Uint8ClampedArray) && img.data.length === img.width * img.height * 4
}

/**
 * Memory budget: the largest image the studio will hold decoded at once.
 * 48 MP RGBA is 192 MB — already generous for a WebView; anything larger must
 * come through the tiling contract below rather than one allocation.
 */
export const MAX_PIXELS = 48_000_000

/* --------------------------------------------------- EXIF orientation read */

/**
 * Parse the EXIF orientation (1..8) out of JPEG bytes. Returns 1 (upright)
 * when there is no EXIF, no orientation tag, or the file is not a JPEG —
 * "no correction needed" is the only safe default.
 *
 * First principles, not a library: walk JPEG markers to APP1, check the
 * "Exif\0\0" signature, read TIFF byte order, walk IFD0 entries for tag
 * 0x0112. Every read is bounds-checked; a truncated or hostile file answers 1
 * rather than throwing, because decode-time robustness is a boundary duty.
 */
export function parseExifOrientation (bytes) {
  const b = toU8(bytes)
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1   // not a JPEG
  let off = 2
  while (off + 4 <= b.length) {
    if (b[off] !== 0xff) return 1                    // marker desync — stop guessing
    const marker = b[off + 1]
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue }
    if (marker === 0xda || marker === 0xd9) return 1 // scan data / EOI: no EXIF ahead
    const size = (b[off + 2] << 8) | b[off + 3]
    if (size < 2 || off + 2 + size > b.length) return 1
    if (marker === 0xe1 && size >= 10 &&
        b[off + 4] === 0x45 && b[off + 5] === 0x78 && b[off + 6] === 0x69 &&
        b[off + 7] === 0x66 && b[off + 8] === 0x00 && b[off + 9] === 0x00) {
      return orientationFromTiff(b, off + 10, off + 2 + size)
    }
    off += 2 + size
  }
  return 1
}

function orientationFromTiff (b, start, end) {
  if (start + 8 > end) return 1
  const little = b[start] === 0x49 && b[start + 1] === 0x49
  const big = b[start] === 0x4d && b[start + 1] === 0x4d
  if (!little && !big) return 1
  const u16 = (o) => (o + 2 <= end ? (little ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]) : null)
  const u32 = (o) => (o + 4 <= end
    ? (little
        ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000
        : ((b[o] << 16 | b[o + 1] << 8 | b[o + 2]) * 0x100) + b[o + 3])
    : null)
  if (u16(start + 2) !== 42) return 1
  const ifd = u32(start + 4)
  if (ifd === null) return 1
  const dir = start + ifd
  const count = u16(dir)
  if (count === null) return 1
  for (let i = 0; i < count; i++) {
    const entry = dir + 2 + i * 12
    if (entry + 12 > end) return 1
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8)
      return value >= 1 && value <= 8 ? value : 1
    }
  }
  return 1
}

function toU8 (bytes) {
  if (bytes instanceof Uint8Array) return bytes
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return null
}

/**
 * Undo an EXIF orientation on plain pixels. Pure and Node-testable — this is
 * the fallback for browsers whose createImageBitmap ignores
 * `imageOrientation: 'from-image'`; browsers that honor it never reach this.
 *
 * Orientation semantics (EXIF 2.3 §4.6.4): 2=flip-H, 3=rotate 180, 4=flip-V,
 * 5=transpose, 6=rotate 90 CW, 7=transverse, 8=rotate 270 CW.
 */
export function applyOrientation (img, orientation) {
  const o = Number(orientation)
  if (!isImage(img)) throw new TypeError('applyOrientation: not an image')
  if (!(o >= 2 && o <= 8)) return img
  const swap = o >= 5
  const out = makeImage(swap ? img.height : img.width, swap ? img.width : img.height)
  const { width: w, height: h, data: src } = img
  const dst = out.data
  const ow = out.width
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let tx, ty
      switch (o) {
        case 2: tx = w - 1 - x; ty = y; break
        case 3: tx = w - 1 - x; ty = h - 1 - y; break
        case 4: tx = x; ty = h - 1 - y; break
        case 5: tx = y; ty = x; break
        case 6: tx = h - 1 - y; ty = x; break
        case 7: tx = h - 1 - y; ty = w - 1 - x; break
        default: tx = y; ty = w - 1 - x; break        // 8
      }
      const si = (y * w + x) * 4
      const di = (ty * ow + tx) * 4
      dst[di] = src[si]
      dst[di + 1] = src[si + 1]
      dst[di + 2] = src[si + 2]
      dst[di + 3] = src[si + 3]
    }
  }
  return out
}

/* ------------------------------------------------ preview + tiling contracts */

/**
 * Downscale-for-preview strategy: the editor evaluates the op graph against a
 * bounded preview and only renders full-resolution on export. This returns the
 * scale to use — never upscales, snaps near-1 to 1 so a phone photo that
 * already fits is not resampled for nothing.
 */
export function previewScale (width, height, { maxEdge = 1600, maxPixels = 2_600_000 } = {}) {
  const edge = Math.max(width, height)
  const byEdge = edge > maxEdge ? maxEdge / edge : 1
  const byArea = width * height * byEdge * byEdge > maxPixels
    ? Math.sqrt(maxPixels / (width * height))
    : byEdge
  const s = Math.min(byEdge, byArea)
  return s > 0.98 ? 1 : s
}

/** Box-downscale by integer-ish factor via area averaging. Pure CPU. */
export function downscale (img, scale) {
  if (!isImage(img)) throw new TypeError('downscale: not an image')
  const s = Number(scale)
  if (!(s > 0 && s <= 1)) throw new RangeError('downscale: scale must be in (0,1]')
  if (s === 1) return cloneImage(img)
  const ow = Math.max(1, Math.round(img.width * s))
  const oh = Math.max(1, Math.round(img.height * s))
  const out = makeImage(ow, oh)
  const { width: w, height: h, data: src } = img
  const dst = out.data
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor(oy * h / oh)
    const y1 = Math.max(y0 + 1, Math.floor((oy + 1) * h / oh))
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor(ox * w / ow)
      const x1 = Math.max(x0 + 1, Math.floor((ox + 1) * w / ow))
      let r = 0; let g = 0; let bl = 0; let a = 0; let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4
          r += src[i]; g += src[i + 1]; bl += src[i + 2]; a += src[i + 3]; n++
        }
      }
      const o = (oy * ow + ox) * 4
      dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = bl / n; dst[o + 3] = a / n
    }
  }
  return out
}

/**
 * Memory-bounded tiling contract for large images.
 *
 * An op that is purely per-pixel can run tile-by-tile with zero overlap; a
 * spatial op (blur, sharpen, clarity, inpaint) needs `overlap` pixels of
 * context on every interior edge, rendered and then cropped away, or tile
 * seams show. This returns the plan — `{ rect, src }` pairs where `src` is
 * the padded read rect and `rect` the write-back rect — and the evaluator is
 * responsible for honoring the op's declared `pad` (see evaluator.js).
 * Deterministic and pure so the plan itself is testable.
 */
export function planTiles (width, height, { maxPixels = 4_000_000, overlap = 0 } = {}) {
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new RangeError('planTiles: bad dimensions')
  }
  if (width * height <= maxPixels) {
    return [{ rect: { x: 0, y: 0, w: width, h: height }, src: { x: 0, y: 0, w: width, h: height } }]
  }
  const tiles = []
  // Near-square tiles that respect the pixel budget including their overlap.
  const target = Math.max(1, Math.floor(Math.sqrt(maxPixels)) - 2 * overlap)
  const cols = Math.ceil(width / target)
  const rows = Math.ceil(height / target)
  const tw = Math.ceil(width / cols)
  const th = Math.ceil(height / rows)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * tw
      const y = r * th
      const w = Math.min(tw, width - x)
      const h = Math.min(th, height - y)
      if (w <= 0 || h <= 0) continue
      const sx = Math.max(0, x - overlap)
      const sy = Math.max(0, y - overlap)
      tiles.push({
        rect: { x, y, w, h },
        src: {
          x: sx,
          y: sy,
          w: Math.min(width, x + w + overlap) - sx,
          h: Math.min(height, y + h + overlap) - sy
        }
      })
    }
  }
  return tiles
}

/** Copy a sub-rect out of an image. */
export function cropRect (img, { x, y, w, h }) {
  if (!isImage(img)) throw new TypeError('cropRect: not an image')
  if (!(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(w) && Number.isInteger(h)) ||
      x < 0 || y < 0 || w < 1 || h < 1 || x + w > img.width || y + h > img.height) {
    throw new RangeError('cropRect: rect out of bounds')
  }
  const out = makeImage(w, h)
  for (let row = 0; row < h; row++) {
    const src = (y + row) * img.width * 4 + x * 4
    out.data.set(img.data.subarray(src, src + w * 4), row * w * 4)
  }
  return out
}

/** Paste `tile` into `img` at (x, y) — the tiling write-back. Mutates img. */
export function blitRect (img, tile, x, y) {
  if (!isImage(img) || !isImage(tile)) throw new TypeError('blitRect: not an image')
  if (x < 0 || y < 0 || x + tile.width > img.width || y + tile.height > img.height) {
    throw new RangeError('blitRect: tile out of bounds')
  }
  for (let row = 0; row < tile.height; row++) {
    img.data.set(
      tile.data.subarray(row * tile.width * 4, (row + 1) * tile.width * 4),
      ((y + row) * img.width + x) * 4
    )
  }
  return img
}

/* ------------------------------------------------------ browser-only edge */
/* Everything below touches DOM/Web APIs and is exercised in the browser, not
 * in the Node suite. Each probes for what it needs and fails as a rejected
 * promise, never a ReferenceError. */

/** Decode a Blob to pixels, honoring EXIF orientation exactly once. */
export async function blobToImage (blob) {
  if (typeof createImageBitmap !== 'function') throw new Error('no createImageBitmap in this environment')
  let bitmap = null
  let oriented = true
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    // Older engines reject the options bag; decode plain and correct manually.
    bitmap = await createImageBitmap(blob)
    oriented = false
  }
  try {
    const img = bitmapToImage(bitmap)
    if (oriented) return img
    const bytes = new Uint8Array(await blob.arrayBuffer())
    return applyOrientation(img, parseExifOrientation(bytes))
  } finally {
    bitmap.close?.()
  }
}

/** ImageBitmap → plain pixels via an offscreen 2D canvas. */
export function bitmapToImage (bitmap) {
  const canvas = makeCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(bitmap, 0, 0)
  const d = ctx.getImageData(0, 0, bitmap.width, bitmap.height)
  return { width: d.width, height: d.height, data: d.data }
}

/**
 * Encode pixels to a Blob. Canvas re-encode: the output carries NO metadata
 * (no EXIF, no GPS) by construction. `type` falls back to JPEG; alpha is
 * flattened onto white for formats without it, matching crop.js.
 */
export async function imageToBlob (img, { type = 'image/jpeg', quality = 0.9 } = {}) {
  if (!isImage(img)) throw new TypeError('imageToBlob: not an image')
  const canvas = makeCanvas(img.width, img.height)
  const ctx = canvas.getContext('2d')
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, img.width, img.height)
  }
  const pixels = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height)
  if (type === 'image/jpeg') {
    // drawImage-over-white needs a bitmap; putImageData would drop the flatten.
    const bmp = await createImageBitmap(pixels)
    ctx.drawImage(bmp, 0, 0)
    bmp.close?.()
  } else {
    ctx.putImageData(pixels, 0, 0)
  }
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality)
  })
}

function makeCanvas (w, h) {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h)
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    return c
  }
  throw new Error('no canvas in this environment')
}
