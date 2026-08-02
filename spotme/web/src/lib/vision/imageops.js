/**
 * Spot Me vision — pure plane/pixel operations under the document scanner.
 *
 * Same shapes as the camera engine's imagemath (which this file builds on
 * rather than re-implementing):
 *
 *   image  { data: Uint8ClampedArray, width, height }   — RGBA bytes
 *   plane  { data: Float32Array, width, height }        — one channel, 0..1
 *
 * Everything is PURE (fresh buffers, inputs untouched) and dependency-free
 * — that is what lets the golden tests pin numbers in Node. The one
 * numerically load-bearing choice: integral images accumulate in Float64,
 * because a 2000×2600 page summed in Float32 loses ~3 decimal digits by
 * the bottom-right corner and the adaptive threshold visibly banded.
 */

/** Sobel gradients over a luma plane → { gx, gy, mag } planes. Edge pixels
 *  use clamped neighbours (no wraparound: wrapped gradients are lies from
 *  the far side of the frame). */
export function sobel (plane) {
  const { data, width, height } = plane
  const gx = new Float32Array(width * height)
  const gy = new Float32Array(width * height)
  const mag = new Float32Array(width * height)
  const at = (x, y) => data[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = at(x - 1, y - 1); const t = at(x, y - 1); const tr = at(x + 1, y - 1)
      const l = at(x - 1, y); const r = at(x + 1, y)
      const bl = at(x - 1, y + 1); const b = at(x, y + 1); const br = at(x + 1, y + 1)
      const sx = (tr + 2 * r + br) - (tl + 2 * l + bl)
      const sy = (bl + 2 * b + br) - (tl + 2 * t + tr)
      const i = y * width + x
      gx[i] = sx
      gy[i] = sy
      mag[i] = Math.hypot(sx, sy)
    }
  }
  return {
    gx: { data: gx, width, height },
    gy: { data: gy, width, height },
    mag: { data: mag, width, height },
  }
}

/** The value below which `p` percent of the plane lies. Exact (typed-array
 *  sort of a copy) — these planes are small downscales, so exactness costs
 *  nothing and the tests can pin it. */
export function planePercentile (plane, p) {
  const sorted = Float32Array.from(plane.data).sort()
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))))
  return sorted[idx]
}

/** Summed-area table with one row/column of zero padding, in Float64 (see
 *  header). integral[(y+1)*(w+1)+(x+1)] = Σ plane[0..y][0..x]. */
export function integralPlane (plane) {
  const { data, width, height } = plane
  const W = width + 1
  const out = new Float64Array(W * (height + 1))
  for (let y = 0; y < height; y++) {
    let rowSum = 0
    for (let x = 0; x < width; x++) {
      rowSum += data[y * width + x]
      out[(y + 1) * W + (x + 1)] = out[y * W + (x + 1)] + rowSum
    }
  }
  return { data: out, width: W, height: height + 1 }
}

/** Mean of the plane over the clamped square window [x±r, y±r], O(1) per
 *  query via the integral table. */
export function localMean (integral, width, height, x, y, r) {
  const W = width + 1
  const x0 = Math.max(0, x - r)
  const y0 = Math.max(0, y - r)
  const x1 = Math.min(width - 1, x + r)
  const y1 = Math.min(height - 1, y + r)
  const sum = integral.data[(y1 + 1) * W + (x1 + 1)] - integral.data[y0 * W + (x1 + 1)] -
    integral.data[(y1 + 1) * W + x0] + integral.data[y0 * W + x0]
  return sum / ((x1 - x0 + 1) * (y1 - y0 + 1))
}

/** One channel of an RGBA image as a 0..1 plane (r=0, g=1, b=2). */
export function channelPlane (image, channel) {
  const { data, width, height } = image
  const out = new Float32Array(width * height)
  for (let i = channel, p = 0; p < out.length; i += 4, p++) out[p] = data[i] / 255
  return { data: out, width, height }
}

/** Bilinear sample of an RGBA image at a fractional point, edge-clamped.
 *  Writes the 4 channels into out[o..o+3]. */
export function sampleBilinear (image, sx, sy, out, o) {
  const { data, width, height } = image
  const x = Math.min(width - 1, Math.max(0, sx))
  const y = Math.min(height - 1, Math.max(0, sy))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(width - 1, x0 + 1)
  const y1 = Math.min(height - 1, y0 + 1)
  const fx = x - x0
  const fy = y - y0
  const i00 = (y0 * width + x0) * 4
  const i10 = (y0 * width + x1) * 4
  const i01 = (y1 * width + x0) * 4
  const i11 = (y1 * width + x1) * 4
  for (let c = 0; c < 4; c++) {
    const top = data[i00 + c] * (1 - fx) + data[i10 + c] * fx
    const bottom = data[i01 + c] * (1 - fx) + data[i11 + c] * fx
    out[o + c] = top * (1 - fy) + bottom * fy
  }
}

/* --------------------------------------------------------- geometry ------ */

/**
 * Order 4 points TL, TR, BR, BL. Sum x+y is smallest at top-left and
 * largest at bottom-right; the difference x−y separates the other two.
 * This is the ordering every homography in this module assumes.
 */
export function orderCorners (points) {
  if (!Array.isArray(points) || points.length !== 4) throw new Error('orderCorners needs exactly 4 points')
  const bySum = [...points].sort((a, b) => (a.x + a.y) - (b.x + b.y))
  const tl = bySum[0]
  const br = bySum[3]
  const rest = points.filter((p) => p !== tl && p !== br)
  const [tr, bl] = rest[0].x - rest[0].y > rest[1].x - rest[1].y ? [rest[0], rest[1]] : [rest[1], rest[0]]
  return [tl, tr, br, bl]
}

/** Signed area ×2 of a polygon (positive = counter-clockwise in y-down
 *  screen coordinates it is clockwise — callers use |area|). */
export function polygonArea (points) {
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** Convexity: every consecutive cross product has the same sign. */
export function isConvex (points) {
  let sign = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const c = points[(i + 2) % points.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) continue
    const s = Math.sign(cross)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return sign !== 0
}

/** Interior angles of a quad, degrees, in corner order. */
export function quadAngles (points) {
  const angles = []
  for (let i = 0; i < 4; i++) {
    const prev = points[(i + 3) % 4]
    const here = points[i]
    const next = points[(i + 1) % 4]
    const v1 = { x: prev.x - here.x, y: prev.y - here.y }
    const v2 = { x: next.x - here.x, y: next.y - here.y }
    const dot = v1.x * v2.x + v1.y * v2.y
    const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y)
    angles.push(mag < 1e-9 ? 0 : Math.acos(Math.min(1, Math.max(-1, dot / mag))) * 180 / Math.PI)
  }
  return angles
}
