/**
 * Spot Me vision — plane projective mapping from first principles.
 *
 * A document photographed at an angle is the page's plane under a
 * projective transform; rectifying it means recovering the 3×3 homography
 * H from 4 corner correspondences and resampling through it. Implemented
 * here as the normalized Direct Linear Transform:
 *
 *   1. Hartley-normalize both point sets (centroid → origin, mean distance
 *      → √2). Without this the 8×8 system mixes coordinates ~1 with
 *      coordinates ~10⁶ and the solve loses digits exactly where corners
 *      matter.
 *   2. Each correspondence contributes two DLT rows; fixing h₃₃ = 1 turns
 *      Ah = 0 into an 8×8 linear system solved by Gaussian elimination
 *      with partial pivoting. (h₃₃ = 0 only when the origin maps to the
 *      line at infinity — impossible for the normalized, finite quads the
 *      scanner feeds this — and a genuinely degenerate input surfaces as
 *      a vanishing pivot, reported honestly.)
 *   3. Denormalize: H = T_dst⁻¹ · Ĥ · T_src.
 *
 * H is stored row-major [h00..h22], mapping (x,y) → (u/w, v/w) with
 * [u,v,w]ᵀ = H·[x,y,1]ᵀ. Everything is pure math on plain arrays — no
 * canvas, no DOM — so the golden tests pin it to 1e-6 in Node.
 */

import { sampleBilinear } from './imageops.js'

/** Normalizing transform for a point set (translate centroid to origin,
 *  scale mean distance to √2), plus its inverse. */
function normalization (points) {
  let cx = 0
  let cy = 0
  for (const p of points) { cx += p.x; cy += p.y }
  cx /= points.length
  cy /= points.length
  let meanDist = 0
  for (const p of points) meanDist += Math.hypot(p.x - cx, p.y - cy)
  meanDist /= points.length
  const s = meanDist > 1e-12 ? Math.SQRT2 / meanDist : 1
  return {
    // T · p = (s(x−cx), s(y−cy))
    T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    Tinv: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1],
  }
}

/** 3×3 row-major multiply. */
export function mul3 (a, b) {
  const out = new Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
  return out
}

/** Apply H to a point. Throws on a point mapped to infinity (w ≈ 0) —
 *  callers never feed one; a throw here is a solver bug, not user input. */
export function applyHomography (H, p) {
  const w = H[6] * p.x + H[7] * p.y + H[8]
  if (Math.abs(w) < 1e-12) throw new Error('homography maps point to infinity')
  return {
    x: (H[0] * p.x + H[1] * p.y + H[2]) / w,
    y: (H[3] * p.x + H[4] * p.y + H[5]) / w,
  }
}

/** 3×3 inverse via the adjugate. Null for a singular matrix. */
export function invertHomography (H) {
  const [a, b, c, d, e, f, g, h, i] = H
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ]
}

/** Solve M·x = v for an n×n system, Gaussian elimination with partial
 *  pivoting. M and v are mutated (callers pass fresh copies). Null when a
 *  pivot vanishes — the degenerate-correspondence signal. */
function solveLinear (M, v, n) {
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) { if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r }
    if (Math.abs(M[pivot][col]) < 1e-12) return null
    if (pivot !== col) {
      const tr = M[pivot]; M[pivot] = M[col]; M[col] = tr
      const tv = v[pivot]; v[pivot] = v[col]; v[col] = tv
    }
    for (let r = col + 1; r < n; r++) {
      const factor = M[r][col] / M[col][col]
      if (factor === 0) continue
      for (let c = col; c < n; c++) M[r][c] -= factor * M[col][c]
      v[r] -= factor * v[col]
    }
  }
  const x = new Array(n)
  for (let r = n - 1; r >= 0; r--) {
    let sum = v[r]
    for (let c = r + 1; c < n; c++) sum -= M[r][c] * x[c]
    x[r] = sum / M[r][r]
  }
  return x
}

/**
 * The homography carrying src[i] → dst[i] for 4 point pairs, or null when
 * the correspondence is degenerate (three collinear points, coincident
 * points). Result is scaled so h₂₂ = 1.
 */
export function homographyFromPoints (src, dst) {
  if (src?.length !== 4 || dst?.length !== 4) throw new Error('homographyFromPoints needs 4 point pairs')
  const ns = normalization(src)
  const nd = normalization(dst)
  const s = src.map((p) => applyHomography(ns.T, p))
  const d = dst.map((p) => applyHomography(nd.T, p))

  // Two rows per pair, unknowns h00..h21 with h22 fixed at 1:
  //   x·h00 + y·h01 + h02 − x'·x·h20 − x'·y·h21 = x'
  //   x·h10 + y·h11 + h12 − y'·x·h20 − y'·y·h21 = y'
  const M = []
  const v = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = s[i]
    const { x: u, y: w } = d[i]
    M.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); v.push(u)
    M.push([0, 0, 0, x, y, 1, -w * x, -w * y]); v.push(w)
  }
  const h = solveLinear(M, v, 8)
  if (!h) return null
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1]
  const H = mul3(mul3(nd.Tinv, Hn), ns.T)
  // Scale to h22 = 1 so tests (and humans) can compare matrices directly.
  const scale = H[8]
  return Math.abs(scale) < 1e-12 ? H : H.map((x) => x / scale)
}

/**
 * Resample `image` through H, where H maps OUTPUT pixel → SOURCE pixel
 * (the inverse mapping — every output pixel gets exactly one bilinear
 * sample, no holes). Edge-clamped like every sampler in the platform.
 */
export function warpPerspective (image, H, outWidth, outHeight) {
  const out = new Uint8ClampedArray(outWidth * outHeight * 4)
  const px = new Float32Array(4)
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const w = H[6] * x + H[7] * y + H[8]
      const sx = (H[0] * x + H[1] * y + H[2]) / w
      const sy = (H[3] * x + H[4] * y + H[5]) / w
      sampleBilinear(image, sx, sy, px, 0)
      const o = (y * outWidth + x) * 4
      out[o] = px[0]; out[o + 1] = px[1]; out[o + 2] = px[2]; out[o + 3] = px[3]
    }
  }
  return { data: out, width: outWidth, height: outHeight }
}
