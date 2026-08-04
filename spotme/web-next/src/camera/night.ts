/**
 * Night mode — N-frame stacking with global alignment and motion rejection.
 * TypeScript port of the CAM-1 `night.js` (#56, read-only source).
 *
 * Averaging N aligned frames cuts zero-mean sensor noise by √N — that is
 * the entire physics. Alignment: phase correlation against the first
 * frame; a low-confidence estimate is treated as zero shift (a
 * hallucinated shift smears worse than skipping one). Motion rejection:
 * a pixel whose luma strays past the threshold is excluded WHOLE (never
 * channel-by-channel — channel-split ghosts). The rejected fraction is
 * reported: 40% rejection means the scene was moving, not dark.
 */

import { MIN_SHIFT_CONFIDENCE, estimateShift } from './align';
import { lumaPlane, shiftImage } from './imagemath';
import { available, unavailable } from './types';
import type { Availability, RgbaImage, ShiftEstimate } from './types';

export interface NightOptions {
  mode?: 'mean' | 'median';
  motionThreshold?: number;
  maxShiftFraction?: number;
}

export const NIGHT_DEFAULTS = Object.freeze({
  frames: 8,
  mode: 'mean' as const,
  motionThreshold: 0.12,
  maxShiftFraction: 0.15,
});

export interface StackedResult {
  image: RgbaImage;
  shifts: (ShiftEstimate & { applied?: { dx: number; dy: number } })[];
  framesUsed: number;
  framesDropped: number;
  rejectedFraction: number;
  mode: 'mean' | 'median';
}

export function stackFrames(frames: readonly RgbaImage[], opts: NightOptions = {}): Availability<StackedResult> {
  const { mode, motionThreshold, maxShiftFraction } = { ...NIGHT_DEFAULTS, ...opts };
  if (!Array.isArray(frames) || frames.length === 0) {
    return unavailable('unsupported', 'stackFrames needs at least one frame');
  }
  const { width, height } = frames[0];
  if (!frames.every((f) => f.width === width && f.height === height)) {
    return unavailable('unsupported', 'stack frames differ in geometry');
  }
  const reference = frames[0];
  const refLuma = lumaPlane(reference);
  const aligned: RgbaImage[] = [reference];
  const shifts: StackedResult['shifts'] = [{ dx: 0, dy: 0, confidence: 1 }];
  let dropped = 0;

  for (let k = 1; k < frames.length; k++) {
    const estimate = estimateShift(refLuma, lumaPlane(frames[k]), { size: pickTile(width, height) });
    const tooFar = Math.abs(estimate.dx) > width * maxShiftFraction ||
      Math.abs(estimate.dy) > height * maxShiftFraction;
    if (tooFar) { dropped++; continue; } // a lurch, not hand shake: unusable
    const usable = estimate.confidence >= MIN_SHIFT_CONFIDENCE;
    const dx = usable ? Math.round(estimate.dx) : 0;
    const dy = usable ? Math.round(estimate.dy) : 0;
    shifts.push({ ...estimate, applied: { dx: -dx, dy: -dy } });
    aligned.push(dx === 0 && dy === 0 ? frames[k] : shiftImage(frames[k], -dx, -dy));
  }

  const out = new Uint8ClampedArray(width * height * 4);
  let rejected = 0;
  let considered = 0;
  const include = new Uint8Array(aligned.length);
  const values = mode === 'median' ? new Float32Array(aligned.length) : null;

  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const refLumaAt = refLuma.data[p];
    for (let k = 0; k < aligned.length; k++) {
      if (aligned[k] === reference) { include[k] = 1; continue; }
      const d = aligned[k].data;
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      considered++;
      if (Math.abs(lum - refLumaAt) > motionThreshold) { include[k] = 0; rejected++; } else include[k] = 1;
    }
    for (let c = 0; c < 4; c++) {
      const channel = i + c;
      if (mode === 'median' && values) {
        let n = 0;
        for (let k = 0; k < aligned.length; k++) if (include[k]) values[n++] = aligned[k].data[channel];
        out[channel] = median(values, n);
      } else {
        let sum = 0;
        let n = 0;
        for (let k = 0; k < aligned.length; k++) if (include[k]) { sum += aligned[k].data[channel]; n++; }
        out[channel] = sum / n;
      }
    }
  }
  return available({
    image: { data: out, width, height },
    shifts,
    framesUsed: aligned.length,
    framesDropped: dropped,
    rejectedFraction: considered ? rejected / considered : 0,
    mode,
  });
}

function median(values: Float32Array, n: number): number {
  const slice = Array.prototype.slice.call(values, 0, n).sort((a: number, b: number) => a - b);
  const mid = n >> 1;
  return n % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2;
}

/** Correlation tile: big enough to see structure, pow-2, ≤ the frame. */
function pickTile(width: number, height: number): number {
  const cap = Math.min(width, height);
  let tile = 64;
  while (tile > cap) tile >>= 1;
  return Math.max(8, tile);
}
