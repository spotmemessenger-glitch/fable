/**
 * Spot Me camera — global alignment by phase correlation.
 *
 * The one estimator night stacking and EIS both stand on. Translation-only
 * on purpose: rotation/perspective belong to feature trackers this engine
 * does not pretend to have, and hand-shake between frames milliseconds
 * apart IS overwhelmingly translation.
 *
 * HOW. Both frames' luma is box-downsampled to a power-of-two tile
 * (default 64×64 — sub-pixel precision at full res is then refined by the
 * parabolic peak fit), Hann-windowed to soften the non-circular edges,
 * FFT'd; the normalized cross-power spectrum's inverse transform is a
 * correlation surface whose peak sits at the shift. Peaks past the halfway
 * line are negative shifts (circular unwrap). `confidence` is the peak
 * height against the surface mean — a flat surface means "do not trust
 * this", and callers (motion rejection, EIS) treat low confidence as
 * "assume zero shift" rather than applying a hallucinated one.
 *
 * CONVENTION, pinned by test: estimateShift(reference, moved) returns
 * {dx, dy} such that moved ≈ content of reference translated by (dx, dy);
 * aligning `moved` back onto `reference` therefore applies (-dx, -dy).
 */

import { fft2d } from './fft.js'
import { downscalePlane } from './imagemath.js'

/** Hann window in place — tapers the tile so frame edges (which are not
 *  circular) stop imprinting a false zero-shift peak. */
function hannWindow (plane) {
  const { data, width, height } = plane
  for (let y = 0; y < height; y++) {
    const wy = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (height - 1)))
    for (let x = 0; x < width; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (width - 1)))
      data[y * width + x] *= wx * wy
    }
  }
}

/** Parabolic 3-point refinement around the integer peak, one axis. */
function refine (left, peak, right) {
  const denominator = left - 2 * peak + right
  if (Math.abs(denominator) < 1e-12) return 0
  const offset = 0.5 * (left - right) / denominator
  return Math.max(-0.5, Math.min(0.5, offset))
}

/**
 * @param reference luma plane {data: Float32Array, width, height}
 * @param moved     luma plane, same source geometry
 * @param size      pow-2 correlation tile edge (default 64)
 * @returns {dx, dy, confidence} in FULL-RESOLUTION pixels
 */
export function estimateShift (reference, moved, { size = 64, window = true } = {}) {
  const a = downscalePlane(reference, size, size)
  const b = downscalePlane(moved, size, size)
  if (window) { hannWindow(a); hannWindow(b) }

  const aRe = new Float32Array(a.data)
  const aIm = new Float32Array(size * size)
  const bRe = new Float32Array(b.data)
  const bIm = new Float32Array(size * size)
  fft2d(aRe, aIm, size, size)
  fft2d(bRe, bIm, size, size)

  // Normalized cross-power spectrum: (B × conj(A)) / |B × conj(A)|.
  // With moved = reference shifted by +d, B(k) = A(k)·e^{-i2πkd/N}, so
  // B·conj(A) = |A|²·e^{-i2πkd/N}, whose inverse transform peaks at +d —
  // the sign the convention above promises.
  const crossRe = new Float32Array(size * size)
  const crossIm = new Float32Array(size * size)
  for (let i = 0; i < size * size; i++) {
    const re = bRe[i] * aRe[i] + bIm[i] * aIm[i]
    const im = bIm[i] * aRe[i] - bRe[i] * aIm[i]
    const mag = Math.hypot(re, im) || 1e-12
    crossRe[i] = re / mag
    crossIm[i] = im / mag
  }
  fft2d(crossRe, crossIm, size, size, true)

  // The correlation surface peak (magnitude of the inverse transform).
  let peak = -Infinity
  let px = 0
  let py = 0
  let sum = 0
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = crossRe[y * size + x]
      sum += Math.abs(v)
      if (v > peak) { peak = v; px = x; py = y }
    }
  }
  const mean = sum / (size * size)
  const confidence = mean > 0 ? peak / (mean * size) : 0

  const at = (x, y) => crossRe[((y + size) % size) * size + ((x + size) % size)]
  const subX = refine(at(px - 1, py), peak, at(px + 1, py))
  const subY = refine(at(px, py - 1), peak, at(px, py + 1))

  // Circular unwrap, then scale tile shift back to full resolution. The
  // peak convention (pinned by test): moved = reference shifted by (dx,dy)
  // puts the peak at (dx,dy) in tile space.
  let dx = px + subX
  let dy = py + subY
  if (dx > size / 2) dx -= size
  if (dy > size / 2) dy -= size
  return {
    dx: dx * (reference.width / size),
    dy: dy * (reference.height / size),
    confidence: Math.min(1, Math.max(0, confidence)),
  }
}

/** Confidence under which a shift estimate should be treated as noise.
 *  MEASURED against the synthetic suite (64×64 tile): 40 unrelated
 *  noise-field pairs peak at 0.131; genuine shifts score 0.62 at σ=6 noise
 *  and 0.28 even at σ=15. 0.2 sits mid-corridor with margin both ways. */
export const MIN_SHIFT_CONFIDENCE = 0.2
