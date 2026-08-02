/**
 * Spot Me — Creative Studio object removal, LOCAL tier: Telea-style
 * fast-marching inpainting with diffusion refinement. Implemented from first
 * principles (Telea 2004, "An Image Inpainting Technique Based on the Fast
 * Marching Method"), no dependencies.
 *
 * QUALITY ENVELOPE, stated honestly (and repeated in docs/ai-camera/
 * studio.md): this fills SMALL regions over LOW-TEXTURE surroundings —
 * a wire against sky, a lens dust spot, a small sign on a wall. It
 * propagates smooth color, not structure: large holes, faces, or textured
 * backgrounds come out blurry. That is intrinsic to the method, so the local
 * tier enforces a hard region cap and the UI is expected to route bigger
 * jobs to the cloud leg (STUDIO_CLOUD_AI, dark, owner-gated) rather than
 * pretending this algorithm does generative fill.
 */

import { registerOp } from './evaluator.js'
import { decodeMaskRLE, isMask, makeMask } from './masks.js'

/** Local-tier hard caps: pixels actually being filled, and frame fraction. */
export const MAX_INPAINT_PIXELS = 60_000
export const MAX_INPAINT_COVERAGE = 0.25

const KNOWN = 0
const BAND = 1
const UNKNOWN = 2
const INF = 1e6

/* ---------------------------------------------------------------- min-heap */

function makeHeap () {
  const t = []      // priorities
  const idx = []    // pixel indices
  const less = (a, b) => t[a] < t[b]
  const swap = (a, b) => {
    const tt = t[a]; t[a] = t[b]; t[b] = tt
    const ii = idx[a]; idx[a] = idx[b]; idx[b] = ii
  }
  return {
    size: () => t.length,
    push (priority, pixel) {
      t.push(priority)
      idx.push(pixel)
      let i = t.length - 1
      while (i > 0) {
        const parent = (i - 1) >> 1
        if (!less(i, parent)) break
        swap(i, parent)
        i = parent
      }
    },
    pop () {
      const top = idx[0]
      const last = t.length - 1
      swap(0, last)
      t.pop()
      idx.pop()
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < t.length && less(l, m)) m = l
        if (r < t.length && less(r, m)) m = r
        if (m === i) break
        swap(i, m)
        i = m
      }
      return top
    }
  }
}

/* -------------------------------------------------------------- the method */

/** Eikonal update |∇T| = 1 from the best axis neighbors. */
function solveT (T, flags, w, h, x, y) {
  const tAt = (xx, yy) =>
    (xx >= 0 && xx < w && yy >= 0 && yy < h && flags[yy * w + xx] !== UNKNOWN) ? T[yy * w + xx] : INF
  const tx = Math.min(tAt(x - 1, y), tAt(x + 1, y))
  const ty = Math.min(tAt(x, y - 1), tAt(x, y + 1))
  if (tx >= INF && ty >= INF) return INF
  if (tx >= INF) return ty + 1
  if (ty >= INF) return tx + 1
  const d = 2 - (tx - ty) * (tx - ty)
  if (d > 0 && Math.abs(tx - ty) < 1) return (tx + ty + Math.sqrt(d)) / 2
  return Math.min(tx, ty) + 1
}

/**
 * Inpaint the masked region of `img` in place on a copy. `mask` values
 * >= 128 are removed. Deterministic: same image + mask → same bytes.
 */
export function inpaintTelea (img, mask, { radius = 4, refine = 6 } = {}) {
  if (!isMask(mask)) throw new TypeError('inpaintTelea: bad mask')
  const { width: w, height: h } = img
  const use = (mask.w === w && mask.h === h) ? mask : resampleMaskNearest(mask, w, h)

  const flags = new Uint8Array(w * h)
  const T = new Float32Array(w * h)
  let unknown = 0
  for (let i = 0; i < flags.length; i++) {
    if (use.data[i] >= 128) {
      flags[i] = UNKNOWN
      T[i] = INF
      unknown++
    }
  }
  if (unknown === 0) return { width: w, height: h, data: new Uint8ClampedArray(img.data) }
  if (unknown > MAX_INPAINT_PIXELS || unknown / (w * h) > MAX_INPAINT_COVERAGE) {
    throw new RangeError(
      `inpaint: region of ${unknown}px exceeds the local tier ` +
      `(max ${MAX_INPAINT_PIXELS}px, ${MAX_INPAINT_COVERAGE * 100}% of frame) — large/semantic removal is a cloud-leg feature`)
  }

  const out = { width: w, height: h, data: new Uint8ClampedArray(img.data) }
  const heap = makeHeap()

  // Seed the narrow band: unknown pixels touching a known one.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (flags[i] !== UNKNOWN) continue
      const touchesKnown =
        (x > 0 && flags[i - 1] === KNOWN) || (x < w - 1 && flags[i + 1] === KNOWN) ||
        (y > 0 && flags[i - w] === KNOWN) || (y < h - 1 && flags[i + w] === KNOWN)
      if (touchesKnown) {
        flags[i] = BAND
        T[i] = solveT(T, flags, w, h, x, y)
        heap.push(T[i], i)
      }
    }
  }
  // A masked region with no known border at all (mask covers the frame edge
  // fully) still terminates: caps above bound it, and the heap drains.

  const gradT = (x, y) => {
    const at = (xx, yy) =>
      (xx >= 0 && xx < w && yy >= 0 && yy < h && flags[yy * w + xx] !== UNKNOWN) ? T[yy * w + xx] : null
    const l = at(x - 1, y)
    const r = at(x + 1, y)
    const u = at(x, y - 1)
    const d = at(x, y + 1)
    const gx = l !== null && r !== null ? (r - l) / 2 : l !== null ? T[y * w + x] - l : r !== null ? r - T[y * w + x] : 0
    const gy = u !== null && d !== null ? (d - u) / 2 : u !== null ? T[y * w + x] - u : d !== null ? d - T[y * w + x] : 0
    return [gx, gy]
  }

  const paint = (x, y) => {
    const p = y * w + x
    const [gx, gy] = gradT(x, y)
    let wr = 0; let ar = 0; let ag = 0; let ab = 0
    const r0 = Math.max(0, x - radius)
    const r1 = Math.min(w - 1, x + radius)
    const c0 = Math.max(0, y - radius)
    const c1 = Math.min(h - 1, y + radius)
    for (let yy = c0; yy <= c1; yy++) {
      for (let xx = r0; xx <= r1; xx++) {
        const q = yy * w + xx
        if (flags[q] !== KNOWN) continue
        const rx = x - xx
        const ry = y - yy
        const len2 = rx * rx + ry * ry
        if (len2 === 0 || len2 > radius * radius) continue
        const len = Math.sqrt(len2)
        const dir = Math.max(1e-6, Math.abs(rx * gx + ry * gy) / len)
        const dst = 1 / len2
        const lev = 1 / (1 + Math.abs(T[q] - T[p]))
        const wgt = dir * dst * lev
        const qi = q * 4
        wr += wgt
        ar += out.data[qi] * wgt
        ag += out.data[qi + 1] * wgt
        ab += out.data[qi + 2] * wgt
      }
    }
    const pi = p * 4
    if (wr > 0) {
      out.data[pi] = ar / wr + 0.5
      out.data[pi + 1] = ag / wr + 0.5
      out.data[pi + 2] = ab / wr + 0.5
    }
    out.data[pi + 3] = 255
  }

  // March: closest band pixel becomes known, gets painted, wakes neighbors.
  while (heap.size() > 0) {
    const p = heap.pop()
    if (flags[p] === KNOWN) continue          // stale heap entry
    const x = p % w
    const y = (p - x) / w
    paint(x, y)
    flags[p] = KNOWN
    const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
    for (const [nx, ny] of neighbors) {
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue
      const q = ny * w + nx
      if (flags[q] !== UNKNOWN) continue
      flags[q] = BAND
      T[q] = solveT(T, flags, w, h, nx, ny)
      heap.push(T[q], q)
    }
  }

  // Diffusion refinement: Jacobi-average the filled region a few times to
  // erase marching artifacts. Double-buffered — deterministic.
  if (refine > 0) {
    const filled = []
    for (let i = 0; i < flags.length; i++) if (use.data[i] >= 128) filled.push(i)
    let cur = out.data
    let next = new Uint8ClampedArray(cur)
    for (let iter = 0; iter < refine; iter++) {
      for (const p of filled) {
        const x = p % w
        const y = (p - x) / w
        let n = 0; let r = 0; let g = 0; let b = 0
        if (x > 0) { const i = (p - 1) * 4; r += cur[i]; g += cur[i + 1]; b += cur[i + 2]; n++ }
        if (x < w - 1) { const i = (p + 1) * 4; r += cur[i]; g += cur[i + 1]; b += cur[i + 2]; n++ }
        if (y > 0) { const i = (p - w) * 4; r += cur[i]; g += cur[i + 1]; b += cur[i + 2]; n++ }
        if (y < h - 1) { const i = (p + w) * 4; r += cur[i]; g += cur[i + 1]; b += cur[i + 2]; n++ }
        const pi = p * 4
        if (n > 0) {
          next[pi] = r / n + 0.5
          next[pi + 1] = g / n + 0.5
          next[pi + 2] = b / n + 0.5
          next[pi + 3] = 255
        }
      }
      const t = cur; cur = next; next = t
      next.set(cur)
    }
    out.data = cur
  }
  return out
}

/** Nearest-neighbor mask resample — preview renders at a smaller scale than
 *  the source-resolution mask stored in the document. */
export function resampleMaskNearest (mask, w, h) {
  const out = makeMask(w, h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(mask.h - 1, Math.floor((y * mask.h) / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(mask.w - 1, Math.floor((x * mask.w) / w))
      out.data[y * w + x] = mask.data[sy * mask.w + sx]
    }
  }
  return out
}

/* ------------------------------------------------------------------ the op */

registerOp({
  name: 'inpaint',
  version: 1,
  tileable: false,               // the march needs the whole neighborhood ring
  validate: (p) => {
    const mask = decodeMaskRLE(p.mask)        // throws on malformed RLE
    let unknown = 0
    for (let i = 0; i < mask.data.length; i++) if (mask.data[i] >= 128) unknown++
    if (unknown === 0) throw new RangeError('inpaint: mask selects nothing')
    if (unknown > MAX_INPAINT_PIXELS || unknown / (mask.w * mask.h) > MAX_INPAINT_COVERAGE) {
      throw new RangeError('inpaint: selection too large for the local tier — cloud leg required')
    }
    const radius = p.radius === undefined ? 4 : p.radius
    const refine = p.refine === undefined ? 6 : p.refine
    if (!Number.isInteger(radius) || radius < 2 || radius > 12) throw new RangeError('inpaint.radius must be 2..12')
    if (!Number.isInteger(refine) || refine < 0 || refine > 32) throw new RangeError('inpaint.refine must be 0..32')
    return { mask: p.mask, radius, refine }
  },
  cpu: (img, p) => inpaintTelea(img, decodeMaskRLE(p.mask), { radius: p.radius, refine: p.refine })
})
