/**
 * Global alignment by phase correlation — TypeScript port of the CAM-1
 * `align.js` (#56, read-only source), including the measured texture gate
 * and trust floor. Translation-only on purpose: hand-shake between frames
 * milliseconds apart IS overwhelmingly translation.
 *
 * CONVENTION, pinned by test: estimateShift(reference, moved) returns
 * {dx, dy} such that moved ≈ content of reference translated by (dx, dy);
 * aligning `moved` back onto `reference` therefore applies (-dx, -dy).
 */

import { fft2d } from './fft';
import { downscalePlane } from './imagemath';
import type { LumaPlane, ShiftEstimate } from './types';

/** Confidence under which a shift estimate should be treated as noise.
 *  MEASURED on the source branch against the synthetic suite (64×64 tile):
 *  unrelated noise pairs peak at 0.131; genuine shifts score 0.62 at σ=6
 *  and 0.28 at σ=15. 0.2 sits mid-corridor with margin both ways. */
export const MIN_SHIFT_CONFIDENCE = 0.2;

/** Texture floor for the gate (variance of the 0..1 luma tile). Measured:
 *  textured tiles ~1.8e-2, dim σ=4 sensor noise ~2.5e-4, true flat 0. */
export const MIN_TILE_VARIANCE = 1e-5;

function hannWindow(plane: LumaPlane): void {
  const { data, width, height } = plane;
  for (let y = 0; y < height; y++) {
    const wy = 0.5 * (1 - Math.cos((2 * Math.PI * y) / (height - 1)));
    for (let x = 0; x < width; x++) {
      const wx = 0.5 * (1 - Math.cos((2 * Math.PI * x) / (width - 1)));
      data[y * width + x] *= wx * wy;
    }
  }
}

function refine(left: number, peak: number, right: number): number {
  const denominator = left - 2 * peak + right;
  if (Math.abs(denominator) < 1e-12) return 0;
  const offset = (0.5 * (left - right)) / denominator;
  return Math.max(-0.5, Math.min(0.5, offset));
}

function tileVariance(plane: LumaPlane): number {
  const n = plane.data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += plane.data[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) { const d = plane.data[i] - mean; variance += d * d; }
  return variance / n;
}

export function estimateShift(
  reference: LumaPlane,
  moved: LumaPlane,
  { size = 64, window = true }: { size?: number; window?: boolean } = {},
): ShiftEstimate {
  const a = downscalePlane(reference, size, size);
  const b = downscalePlane(moved, size, size);
  // TEXTURE GATE: a near-flat tile has no spectral energy outside DC — the
  // normalized cross-power is numerical dust that can land a CONFIDENT
  // garbage peak. No texture ⇒ no alignment claim.
  if (tileVariance(a) < MIN_TILE_VARIANCE || tileVariance(b) < MIN_TILE_VARIANCE) {
    return { dx: 0, dy: 0, confidence: 0, flat: true };
  }
  if (window) { hannWindow(a); hannWindow(b); }

  const aRe = new Float32Array(a.data);
  const aIm = new Float32Array(size * size);
  const bRe = new Float32Array(b.data);
  const bIm = new Float32Array(size * size);
  fft2d(aRe, aIm, size, size);
  fft2d(bRe, bIm, size, size);

  // Normalized cross-power spectrum: (B × conj(A)) / |B × conj(A)|.
  const crossRe = new Float32Array(size * size);
  const crossIm = new Float32Array(size * size);
  for (let i = 0; i < size * size; i++) {
    const re = bRe[i] * aRe[i] + bIm[i] * aIm[i];
    const im = bIm[i] * aRe[i] - bRe[i] * aIm[i];
    const mag = Math.hypot(re, im) || 1e-12;
    crossRe[i] = re / mag;
    crossIm[i] = im / mag;
  }
  fft2d(crossRe, crossIm, size, size, true);

  let peak = -Infinity;
  let px = 0;
  let py = 0;
  let sum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = crossRe[y * size + x];
      sum += Math.abs(v);
      if (v > peak) { peak = v; px = x; py = y; }
    }
  }
  const mean = sum / (size * size);
  const confidence = mean > 0 ? peak / (mean * size) : 0;

  const at = (x: number, y: number) => crossRe[((y + size) % size) * size + ((x + size) % size)];
  const subX = refine(at(px - 1, py), peak, at(px + 1, py));
  const subY = refine(at(px, py - 1), peak, at(px, py + 1));

  let dx = px + subX;
  let dy = py + subY;
  if (dx > size / 2) dx -= size;
  if (dy > size / 2) dy -= size;
  return {
    dx: dx * (reference.width / size),
    dy: dy * (reference.height / size),
    confidence: Math.min(1, Math.max(0, confidence)),
  };
}
