/**
 * Spot Me AR/beauty — shared pure math: boxes, points, sampling, easing.
 *
 * Two shapes flow through lib/ar/ (deliberately the camera module's):
 *   image  { data: Uint8ClampedArray, width, height }   — RGBA bytes
 *   plane  { data: Float32Array, width, height }        — one channel, 0..1
 * plus AR's own:
 *   box    { x, y, width, height }                      — pixels, top-left
 *   point  { x, y }                                     — pixels
 *
 * Everything is PURE and dependency-free so the golden tests pin exact
 * numbers in Node.
 */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)

export const lerp = (a, b, t) => a + (b - a) * t

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

/** Hermite smoothstep — 0 below e0, 1 above e1, smooth between. */
export function smoothstep (e0, e1, x) {
  if (e1 === e0) return x < e0 ? 0 : 1
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

export const boxCenter = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 })

/** Intersection-over-union of two boxes — the identity-matching score. */
export function iou (a, b) {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.width, b.x + b.width)
  const y2 = Math.min(a.y + a.height, b.y + b.height)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  if (inter <= 0) return 0
  const union = a.width * a.height + b.width * b.height - inter
  return union > 0 ? inter / union : 0
}

/** Rotate a point around (cx, cy) by `angle` radians (screen coords:
 *  positive = clockwise, because y grows downward). */
export function rotatePoint (p, cx, cy, angle) {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  const dx = p.x - cx
  const dy = p.y - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

/** True when a box is a finite, positively-sized rectangle. */
export function isValidBox (box) {
  return Boolean(box) &&
    Number.isFinite(box.x) && Number.isFinite(box.y) &&
    Number.isFinite(box.width) && Number.isFinite(box.height) &&
    box.width > 0 && box.height > 0
}

/** True when a point is finite. */
export function isValidPoint (p) {
  return Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y)
}

/**
 * Bilinear RGBA sample at a fractional coordinate, edge-clamped. Writes the
 * four channels into `out` (a length-4 array) to avoid per-pixel garbage in
 * the warp inner loop.
 */
export function bilinearSampleRgba (image, x, y, out) {
  const { data, width, height } = image
  const cx = x < 0 ? 0 : x > width - 1 ? width - 1 : x
  const cy = y < 0 ? 0 : y > height - 1 ? height - 1 : y
  const x0 = Math.floor(cx)
  const y0 = Math.floor(cy)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = cx - x0
  const fy = cy - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4
  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c] + (data[i10 + c] - data[i00 + c]) * fx
    const bot = data[i01 + c] + (data[i11 + c] - data[i01 + c]) * fx
    out[c] = top + (bot - top) * fy
  }
  return out
}

/** Rec.709 luma of one RGBA pixel, 0..255. Matches ../camera/imagemath.js
 *  weights so beauty masks and camera planes agree about brightness. */
export function pixelLuma (data, i) {
  return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
}
