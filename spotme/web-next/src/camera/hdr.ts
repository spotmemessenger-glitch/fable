/**
 * HDR — Mertens-style exposure fusion. TypeScript port of the math half of
 * the CAM-1 `hdr.js` (#56, read-only source): pure, runs on RGBA frames
 * anywhere including Node, where its golden vectors are pinned.
 *
 * The HARDWARE half (bracket capture over a real exposureCompensation
 * range) lives in `capture.ts` against the session seam and keeps the
 * source's law: fusing identical exposures is fake HDR and is refused with
 * `no-exposure-control`.
 *
 * SINGLE-SCALE, DOCUMENTED TRADE-OFF (unchanged from source): full Mertens
 * blends per pyramid level; with heavily blurred weight maps the residual
 * is mild halos at hard silhouettes — accepted for v1, upgrade contained
 * inside this function's contract.
 */

import { boxBlurPlane } from './imagemath';
import { available, unavailable } from './types';
import type { Availability, LumaPlane, RgbaImage } from './types';

/** Floor under contrast/saturation: clipped shadows and blown highlights
 *  are locally FLAT, and the raw Mertens product would zero every frame's
 *  weight there — the floor hands flat regions to well-exposedness, the
 *  physically right arbiter. */
export const MEASURE_FLOOR = 0.01;

export const DEFAULT_EVS: readonly number[] = [-2, 0, 2];

export interface FusionOptions {
  wContrast?: number;
  wSaturation?: number;
  wExposedness?: number;
  sigma?: number;
  blurRadius?: number;
}

/** The three Mertens measures for one image → a Float32 weight plane. */
export function weightPlane(image: RgbaImage, {
  wContrast = 1, wSaturation = 1, wExposedness = 1, sigma = 0.2,
}: FusionOptions = {}): LumaPlane {
  const { data, width, height } = image;
  const weights = new Float32Array(width * height);
  const luma = new Float32Array(width * height);
  for (let p = 0, i = 0; p < luma.length; p++, i += 4) {
    luma[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const i = p * 4;
      const left = luma[y * width + Math.max(0, x - 1)];
      const right = luma[y * width + Math.min(width - 1, x + 1)];
      const up = luma[Math.max(0, y - 1) * width + x];
      const down = luma[Math.min(height - 1, y + 1) * width + x];
      const contrast = Math.abs(left + right + up + down - 4 * luma[p]);
      const r = data[i] / 255; const g = data[i + 1] / 255; const b = data[i + 2] / 255;
      const mean = (r + g + b) / 3;
      const saturation = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3);
      const gauss = (v: number) => Math.exp(-((v - 0.5) ** 2) / (2 * sigma * sigma));
      const exposedness = gauss(r) * gauss(g) * gauss(b);
      weights[p] = Math.pow(Math.max(contrast, MEASURE_FLOOR), wContrast) *
        Math.pow(Math.max(saturation, MEASURE_FLOOR), wSaturation) *
        Math.pow(exposedness, wExposedness) + 1e-12;
    }
  }
  return { data: weights, width, height };
}

export interface FusedResult { image: RgbaImage; frames: number }

/** Fuse an exposure bracket — same-geometry RGBA frames in, one out. */
export function fuseExposures(images: readonly RgbaImage[], opts: FusionOptions = {}): Availability<FusedResult> {
  if (!Array.isArray(images) || images.length === 0) {
    return unavailable('unsupported', 'fuseExposures needs at least one frame');
  }
  const { width, height } = images[0];
  if (!images.every((f) => f.width === width && f.height === height)) {
    return unavailable('unsupported', 'bracket frames differ in geometry');
  }
  if (images.length === 1) {
    return available({ image: { data: new Uint8ClampedArray(images[0].data), width, height }, frames: 1 });
  }
  const blurRadius = opts.blurRadius ?? 8;
  const weights = images.map((image) => boxBlurPlane(weightPlane(image, opts), blurRadius));

  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    let total = 0;
    for (const w of weights) total += w.data[p];
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let k = 0; k < images.length; k++) {
      const w = weights[k].data[p] / total;
      const d = images[k].data;
      r += w * d[i]; g += w * d[i + 1]; b += w * d[i + 2]; a += w * d[i + 3];
    }
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
  }
  return available({ image: { data: out, width, height }, frames: images.length });
}
