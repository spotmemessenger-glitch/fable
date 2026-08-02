/**
 * Spot Me — Creative Studio geometry ops: crop, rotate, straighten,
 * perspective. All are `geometry: true` (output dimensions differ or pixels
 * move globally), CPU-only, and sampled by INVERSE mapping — for each output
 * pixel, find where it came from and bilinearly interpolate — which is the
 * correct direction for resampling (forward mapping leaves holes).
 *
 * Coordinates in params are NORMALIZED [0,1] relative to the incoming image,
 * so an op-doc is resolution-independent: the same document renders the same
 * framing on the preview and the full-resolution export.
 */

import { registerOp } from './evaluator.js'
import { makeImage } from './image-io.js'
import { num } from './ops-color.js'

/** Bilinear sample with clamp-to-edge; returns into out[0..3]. */
function sampleBilinear (img, fx, fy, out) {
  const { width: w, height: h, data: s } = img
  const x = Math.min(w - 1.001, Math.max(0, fx))
  const y = Math.min(h - 1.001, Math.max(0, fy))
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const dx = x - x0
  const dy = y - y0
  const i00 = (y0 * w + x0) * 4
  const i10 = i00 + 4
  const i01 = i00 + w * 4
  const i11 = i01 + 4
  for (let c = 0; c < 4; c++) {
    out[c] = (s[i00 + c] * (1 - dx) + s[i10 + c] * dx) * (1 - dy) +
      (s[i01 + c] * (1 - dx) + s[i11 + c] * dx) * dy
  }
}

/* -------------------------------------------------------------------- crop */

registerOp({
  name: 'crop',
  version: 1,
  geometry: true,
  validate: (p) => {
    const x = num(p.x, 'crop.x', 0, 1)
    const y = num(p.y, 'crop.y', 0, 1)
    const w = num(p.w, 'crop.w', 0.01, 1, 1)
    const h = num(p.h, 'crop.h', 0.01, 1, 1)
    if (x + w > 1.0001 || y + h > 1.0001) throw new RangeError('crop: rect exceeds the frame')
    return { x, y, w, h }
  },
  cpu: (img, p) => {
    const x0 = Math.round(p.x * img.width)
    const y0 = Math.round(p.y * img.height)
    const w = Math.max(1, Math.min(img.width - x0, Math.round(p.w * img.width)))
    const h = Math.max(1, Math.min(img.height - y0, Math.round(p.h * img.height)))
    const out = makeImage(w, h)
    for (let row = 0; row < h; row++) {
      const src = ((y0 + row) * img.width + x0) * 4
      out.data.set(img.data.subarray(src, src + w * 4), row * w * 4)
    }
    return out
  }
})

/* ------------------------------------------------------------------ rotate */

/** Lossless 90°-step rotation. quarter: 1=90° CW, 2=180°, 3=270° CW. */
registerOp({
  name: 'rotate',
  version: 1,
  geometry: true,
  validate: (p) => {
    const q = p.quarter
    if (![1, 2, 3].includes(q)) throw new RangeError('rotate.quarter must be 1, 2 or 3')
    return { quarter: q }
  },
  cpu: (img, p) => {
    const { width: w, height: h, data: s } = img
    const swap = p.quarter !== 2
    const out = makeImage(swap ? h : w, swap ? w : h)
    const d = out.data
    const ow = out.width
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let tx, ty
        if (p.quarter === 1) { tx = h - 1 - y; ty = x } else if (p.quarter === 2) { tx = w - 1 - x; ty = h - 1 - y } else { tx = y; ty = w - 1 - x }
        const si = (y * w + x) * 4
        const di = (ty * ow + tx) * 4
        d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = s[si + 3]
      }
    }
    return out
  }
})

/* -------------------------------------------------------------- straighten */

/**
 * Largest axis-aligned rectangle of the ORIGINAL aspect ratio that fits
 * inside a w×h frame rotated by |angle| — the standard auto-crop, so a
 * straightened horizon never shows empty corners.
 */
export function inscribedRect (w, h, radians) {
  const a = Math.abs(radians) % Math.PI
  const ang = a > Math.PI / 2 ? Math.PI - a : a
  if (ang < 1e-9) return { w, h }
  const sinA = Math.sin(ang)
  const cosA = Math.cos(ang)
  const long = Math.max(w, h)
  const short = Math.min(w, h)
  const isHalfSquare = short <= 2 * sinA * cosA * long
  if (isHalfSquare) {
    const x = short / 2
    return w >= h ? { w: x / sinA, h: x / cosA } : { w: x / cosA, h: x / sinA }
  }
  const cos2 = cosA * cosA - sinA * sinA
  return {
    w: (w * cosA - h * sinA) / cos2,
    h: (h * cosA - w * sinA) / cos2
  }
}

registerOp({
  name: 'straighten',
  version: 1,
  geometry: true,
  validate: (p) => ({ degrees: num(p.degrees, 'straighten.degrees', -15, 15) }),
  cpu: (img, p) => {
    const rad = (p.degrees * Math.PI) / 180
    if (Math.abs(rad) < 1e-6) return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
    const fit = inscribedRect(img.width, img.height, rad)
    const ow = Math.max(1, Math.floor(fit.w))
    const oh = Math.max(1, Math.floor(fit.h))
    const out = makeImage(ow, oh)
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    const cx = img.width / 2
    const cy = img.height / 2
    const px = [0, 0, 0, 0]
    for (let y = 0; y < oh; y++) {
      for (let x = 0; x < ow; x++) {
        // Output pixel relative to its center, rotated BACK into source space.
        const rx = x + 0.5 - ow / 2
        const ry = y + 0.5 - oh / 2
        const sx = cx + rx * cos - ry * sin - 0.5
        const sy = cy + rx * sin + ry * cos - 0.5
        sampleBilinear(img, sx, sy, px)
        const i = (y * ow + x) * 4
        out.data[i] = px[0] + 0.5
        out.data[i + 1] = px[1] + 0.5
        out.data[i + 2] = px[2] + 0.5
        out.data[i + 3] = px[3] + 0.5
      }
    }
    return out
  }
})

/* ------------------------------------------------------------- perspective */

/**
 * Solve the homography H mapping unit square corners → quad (normalized),
 * by direct linear transform on the 8 unknowns (h33 = 1): an 8×8 system
 * solved with partial-pivot Gaussian elimination. First principles, exact
 * for 4 point pairs.
 */
export function solveHomography (quad) {
  const src = [[0, 0], [1, 0], [1, 1], [0, 1]]
  const A = []
  const bvec = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i]
    const [X, Y] = quad[i]
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); bvec.push(X)
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); bvec.push(Y)
  }
  const n = 8
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(A[r][col]) > Math.abs(A[pivot][col])) pivot = r
    if (Math.abs(A[pivot][col]) < 1e-12) throw new RangeError('perspective: degenerate quad')
    ;[A[col], A[pivot]] = [A[pivot], A[col]]
    ;[bvec[col], bvec[pivot]] = [bvec[pivot], bvec[col]]
    for (let r = col + 1; r < n; r++) {
      const f = A[r][col] / A[col][col]
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c]
      bvec[r] -= f * bvec[col]
    }
  }
  const hv = new Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let acc = bvec[r]
    for (let c = r + 1; c < n; c++) acc -= A[r][c] * hv[c]
    hv[r] = acc / A[r][r]
  }
  return [hv[0], hv[1], hv[2], hv[3], hv[4], hv[5], hv[6], hv[7], 1]
}

/** Apply H to (u, v). */
export function applyHomography (H, u, v) {
  const wq = H[6] * u + H[7] * v + H[8]
  return [(H[0] * u + H[1] * v + H[2]) / wq, (H[3] * u + H[4] * v + H[5]) / wq]
}

registerOp({
  name: 'perspective',
  version: 1,
  geometry: true,
  /**
   * quad: where the four SOURCE corners [tl, tr, br, bl] should land in the
   * OUTPUT frame, normalized. Keystone correction = pulling two corners in.
   * The op samples output→source through the inverse mapping (which is the
   * forward homography output→unit-square, then scaled to source pixels).
   */
  validate: (p) => {
    const q = p.quad
    if (!Array.isArray(q) || q.length !== 4) throw new TypeError('perspective.quad must be 4 corners')
    const quad = q.map((c, i) => {
      if (!Array.isArray(c) || c.length !== 2) throw new TypeError(`perspective.quad[${i}] must be [x,y]`)
      return [num(c[0], `quad[${i}].x`, -0.5, 1.5), num(c[1], `quad[${i}].y`, -0.5, 1.5)]
    })
    solveHomography(quad)          // rejects degenerate quads at validate time
    return { quad }
  },
  cpu: (img, p) => {
    // Inverse: for output (u,v) find source (s,t) — that is the homography
    // sending the QUAD back to the unit square, i.e. the inverse of corner→quad.
    const H = solveHomography(p.quad)
    const inv = invert3 (H)
    const out = makeImage(img.width, img.height)
    const px = [0, 0, 0, 0]
    for (let y = 0; y < out.height; y++) {
      const v = (y + 0.5) / out.height
      for (let x = 0; x < out.width; x++) {
        const u = (x + 0.5) / out.width
        const [su, sv] = applyHomography(inv, u, v)
        const i = (y * out.width + x) * 4
        if (su < 0 || su > 1 || sv < 0 || sv > 1) {
          out.data[i + 3] = 0                      // outside the source: transparent
          continue
        }
        sampleBilinear(img, su * img.width - 0.5, sv * img.height - 0.5, px)
        out.data[i] = px[0] + 0.5
        out.data[i + 1] = px[1] + 0.5
        out.data[i + 2] = px[2] + 0.5
        out.data[i + 3] = px[3] + 0.5
      }
    }
    return out
  }
})

/** 3×3 inverse via adjugate. */
export function invert3 (m) {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) throw new RangeError('perspective: singular homography')
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det
  ]
}
