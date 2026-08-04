/**
 * Electronic image stabilization, TIER_BASIC — TypeScript port of the CAM-1
 * `stabilize.js` (#56, read-only source). Per frame: estimate the shift
 * against the previous frame, accumulate the actual camera path, run an
 * exponential smoother, counter-shift by (smoothed − actual), CLAMPED to a
 * crop margin, output the fixed centre crop — stable geometry every frame.
 *
 * TIER_ADVANCED (gyro-fused) needs capture-synchronized IMU the web does
 * not grant — honest `unsupported` (Stage 3 native), nothing pretends
 * otherwise. A low-confidence estimate contributes ZERO delta.
 */

import { MIN_SHIFT_CONFIDENCE, estimateShift } from './align';
import { shiftImage } from './imagemath';
import type { LumaPlane, RgbaImage } from './types';

export const EIS_DEFAULTS = Object.freeze({
  smoothing: 0.85,
  cropMargin: 0.08,
  tileSize: 64,
});

export interface EisCorrection {
  dx: number;
  dy: number;
  clamped: boolean;
  confidence: number;
  raw?: { dx: number; dy: number };
}

export interface Stabilizer {
  readonly tier: 'basic';
  feed(luma: LumaPlane): EisCorrection;
  reset(): void;
  state(): { frames: number; path: { x: number; y: number }; smooth: { x: number; y: number }; clampedCount: number; cropMargin: number };
}

export function createStabilizer({
  smoothing = EIS_DEFAULTS.smoothing,
  cropMargin = EIS_DEFAULTS.cropMargin,
  tileSize = EIS_DEFAULTS.tileSize,
}: { smoothing?: number; cropMargin?: number; tileSize?: number } = {}): Stabilizer {
  let previous: LumaPlane | null = null;
  let path = { x: 0, y: 0 };
  let smooth = { x: 0, y: 0 };
  let frames = 0;
  let clampedCount = 0;

  return {
    tier: 'basic',

    feed(luma: LumaPlane): EisCorrection {
      frames++;
      if (!previous) {
        previous = luma;
        return { dx: 0, dy: 0, clamped: false, confidence: 1 };
      }
      const estimate = estimateShift(previous, luma, { size: tileSize });
      previous = luma;
      const trusted = estimate.confidence >= MIN_SHIFT_CONFIDENCE;
      path = { x: path.x + (trusted ? estimate.dx : 0), y: path.y + (trusted ? estimate.dy : 0) };
      smooth = {
        x: smoothing * smooth.x + (1 - smoothing) * path.x,
        y: smoothing * smooth.y + (1 - smoothing) * path.y,
      };
      const maxX = luma.width * cropMargin;
      const maxY = luma.height * cropMargin;
      const rawX = smooth.x - path.x;
      const rawY = smooth.y - path.y;
      const dx = Math.max(-maxX, Math.min(maxX, rawX));
      const dy = Math.max(-maxY, Math.min(maxY, rawY));
      const clamped = dx !== rawX || dy !== rawY;
      if (clamped) clampedCount++;
      return { dx, dy, clamped, confidence: estimate.confidence, raw: { dx: rawX, dy: rawY } };
    },

    reset() { previous = null; path = { x: 0, y: 0 }; smooth = { x: 0, y: 0 }; frames = 0; clampedCount = 0; },
    state: () => ({ frames, path: { ...path }, smooth: { ...smooth }, clampedCount, cropMargin }),
  };
}

/** Apply a correction: shift, then the fixed centre crop the margin
 *  reserves. Output geometry is CONSTANT for a given input size. */
export function stabilizeFrame(image: RgbaImage, correction: EisCorrection, cropMargin = EIS_DEFAULTS.cropMargin): RgbaImage {
  const shifted = shiftImage(image, Math.round(correction.dx), Math.round(correction.dy));
  const mx = Math.round(image.width * cropMargin);
  const my = Math.round(image.height * cropMargin);
  const w = image.width - 2 * mx;
  const h = image.height - 2 * my;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = ((y + my) * image.width + mx) * 4;
    out.set(shifted.data.subarray(srcRow, srcRow + w * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}
