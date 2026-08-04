/**
 * AR & Beauty — Stage 1 (C3), ported from #59 (read-only source):
 *
 *  - BEAUTY TIER-0: the three CPU stages formula-for-formula (skin-masked
 *    separable bilateral, tone+warmth, headroom brighten) with the
 *    BEAUTY_LIMITS naturalness caps enforced INSIDE each stage — there is
 *    no "beyond natural" parameter path. (The GLSL twins remain on the
 *    source branch: matched-formula, hardware-unverified — Stage 2.)
 *  - FACE TRACKING: the IFaceTracker registry + the platform
 *    Shape-Detection box adapter + EMA smoothing. ADVANCED beauty/masks
 *    gate on a LANDMARK engine: the MediaPipe face-landmarker adapter
 *    registers ONLY through the ADR-029 §4 integrity loader — no asset,
 *    no engine, honest 'no-landmark-engine'. A box tracker never
 *    satisfies the landmark gate (ported law).
 */

import type { BeautyRequest, FaceBox, FaceTrackingResult } from '@spotme/contracts';
import { loadVerifiedAsset } from './model-assets';
import type { AssetLoaderDeps } from './model-assets';
import type { RgbaImage } from './types';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp255 = (v: number) => Math.max(0, Math.min(255, v));
const pixelLuma = (data: Uint8ClampedArray, i: number) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];

/** The naturalness caps — hard bounds, enforced in every stage (ported). */
export const BEAUTY_LIMITS = Object.freeze({
  SKIN_SMOOTH_MAX_BLEND: 0.65,
  SKIN_SMOOTH_RADIUS: 3,
  SKIN_SMOOTH_RANGE_SIGMA: 0.08,
  WARMTH_MAX_SHIFT: 12,
  TONE_MAX_BLEND: 0.25,
  BRIGHTEN_MAX_LIFT: 0.30,
});

/* ---------------- skin mask (Chai & Ngan chroma cluster) ---------------- */

function softBand(x: number, lo: number, hi: number, ramp: number): number {
  const rise = clamp01((x - (lo - ramp)) / ramp);
  const fall = clamp01((hi + ramp - x) / ramp);
  return Math.min(rise, fall);
}

/** Per-pixel skin probability, 0..1 (BT.601 chroma cluster + shadow gate).
 *  A chroma test, not a person test: no landmarks, every skin tone inside
 *  the photographed gamut, fails soft (mask 0 = stage does nothing). */
export function skinToneMask(image: RgbaImage): { data: Float32Array; width: number; height: number } {
  const { data, width, height } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const r = data[i]; const g = data[i + 1]; const b = data[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
    const shadowGate = clamp01((y - 40) / 24);
    out[p] = softBand(cb, 77, 127, 8) * softBand(cr, 133, 173, 8) * shadowGate;
  }
  return { data: out, width, height };
}

/* ---------------- separable bilateral ---------------- */

function bilateralPass(image: RgbaImage, dx: number, dy: number, radius: number, sigma: number): RgbaImage {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  const inv2s2 = 1 / (2 * sigma * sigma);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ci = (y * width + x) * 4;
      const centerLuma = pixelLuma(data, ci) / 255;
      let wSum = 0; let r = 0; let g = 0; let b = 0;
      for (let k = -radius; k <= radius; k++) {
        const nx = x + k * dx;
        const ny = y + k * dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const ni = (ny * width + nx) * 4;
        const d = pixelLuma(data, ni) / 255 - centerLuma;
        const w = Math.exp(-(d * d) * inv2s2);
        wSum += w; r += w * data[ni]; g += w * data[ni + 1]; b += w * data[ni + 2];
      }
      out[ci] = r / wSum; out[ci + 1] = g / wSum; out[ci + 2] = b / wSum; out[ci + 3] = data[ci + 3];
    }
  }
  return { data: out, width, height };
}

/* ---------------- the three tier-0 stages (ported formulas) ---------------- */

export function applySkinSmooth(image: RgbaImage, strength: number): RgbaImage {
  const s = clamp01(strength);
  const { SKIN_SMOOTH_RADIUS: radius, SKIN_SMOOTH_RANGE_SIGMA: sigma, SKIN_SMOOTH_MAX_BLEND: cap } = BEAUTY_LIMITS;
  const mask = skinToneMask(image);
  const smooth = bilateralPass(bilateralPass(image, 1, 0, radius, sigma), 0, 1, radius, sigma);
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0, p = 0; i < src.length; i += 4, p++) {
    const blend = s * cap * mask.data[p];
    out[i] = src[i] + blend * (smooth.data[i] - src[i]);
    out[i + 1] = src[i + 1] + blend * (smooth.data[i + 1] - src[i + 1]);
    out[i + 2] = src[i + 2] + blend * (smooth.data[i + 2] - src[i + 2]);
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

/** 256-entry tone curve: tone > 0 → S-curve blend, tone < 0 → mid-grey
 *  flatten, both capped by TONE_MAX_BLEND (ported, test-pinned). */
export function toneCurve(tone: number): Uint8Array {
  const t = Math.max(-1, Math.min(1, tone));
  const blend = Math.abs(t) * BEAUTY_LIMITS.TONE_MAX_BLEND;
  const curve = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const u = v / 255;
    const target = t >= 0 ? 255 * u * u * (3 - 2 * u) : 128;
    curve[v] = Math.round(v + blend * (target - v));
  }
  return curve;
}

export function applyToneWarmth(image: RgbaImage, tone: number, warmth: number): RgbaImage {
  const w = Math.max(-1, Math.min(1, warmth)) * BEAUTY_LIMITS.WARMTH_MAX_SHIFT;
  const curve = toneCurve(tone);
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    out[i] = clamp255(curve[src[i]] + w);
    out[i + 1] = curve[src[i + 1]];
    out[i + 2] = clamp255(curve[src[i + 2]] - w);
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

/** Headroom lift: out = v + s·cap·(255 − v) — monotone, algebraically
 *  clip-free, shadows lift most, highlights untouched (ported). */
export function applyBrighten(image: RgbaImage, strength: number): RgbaImage {
  const lift = clamp01(strength) * BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT;
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i] + lift * (255 - src[i]);
    out[i + 1] = src[i + 1] + lift * (255 - src[i + 1]);
    out[i + 2] = src[i + 2] + lift * (255 - src[i + 2]);
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

/** The tier pipeline. ADVANCED requests additionally REQUIRE a registered
 *  landmark engine — the ADR-014c gate at runtime as well as in types. */
export function applyBeauty(
  image: RgbaImage,
  request: BeautyRequest,
  landmarkEngineRegistered: boolean,
): RgbaImage | { state: 'unavailable'; reason: 'no-landmark-engine' } {
  if (request.tier === 'advanced' && !landmarkEngineRegistered) {
    return { state: 'unavailable', reason: 'no-landmark-engine' };
  }
  const { smooth, tone, brighten } = request.params;
  let out = applySkinSmooth(image, smooth);
  out = applyToneWarmth(out, tone, 0);
  out = applyBrighten(out, brighten);
  return out;
}

/* ---------------- face tracking ---------------- */

/** Platform Shape-Detection FaceDetector, structurally typed. */
export interface PlatformFaceDetector {
  detect(image: unknown): Promise<{ boundingBox: { x: number; y: number; width: number; height: number } }[]>;
}

/** EMA temporal smoothing over successive box sets (ported discipline). */
export function createBoxSmoother(alpha = 0.6) {
  let previous: FaceBox[] | null = null;
  return (boxes: FaceBox[]): FaceBox[] => {
    if (!previous || previous.length !== boxes.length) { previous = boxes; return boxes; }
    const smoothed = boxes.map((box, k) => ({
      ...box,
      x: alpha * previous![k].x + (1 - alpha) * box.x,
      y: alpha * previous![k].y + (1 - alpha) * box.y,
      width: alpha * previous![k].width + (1 - alpha) * box.width,
      height: alpha * previous![k].height + (1 - alpha) * box.height,
    }));
    previous = smoothed;
    return smoothed;
  };
}

export interface FaceTrackerDeps {
  /** () => the platform detector, or null where the API doesn't exist. */
  platformDetector?: () => PlatformFaceDetector | null;
  /** Landmark engine assets go through the integrity loader ONLY. */
  assetLoader?: AssetLoaderDeps;
}

export function createFaceTracker(deps: FaceTrackerDeps = {}) {
  const smooth = createBoxSmoother();
  let landmarkerReady = false;

  return {
    /** A BOX tracker never satisfies the landmark gate (ported law). */
    landmarkAvailability: () => landmarkerReady,

    /** Register the MediaPipe face-landmarker through the ADR-029 §4
     *  integrity loader. With the Stage-1 empty manifest this ALWAYS
     *  refuses — the honest posture until Stage 2 vendors the asset. */
    async registerLandmarker(): Promise<FaceTrackingResult | { state: 'registered' }> {
      if (!deps.assetLoader) return { state: 'unavailable', reason: 'no-landmark-engine' };
      const asset = await loadVerifiedAsset('face-landmarker', deps.assetLoader);
      if (asset.state !== 'loaded') {
        return {
          state: 'unavailable',
          reason: asset.reason === 'asset-integrity-failed' ? 'asset-integrity-failed' : 'no-landmark-engine',
        };
      }
      landmarkerReady = true;
      return { state: 'registered' };
    },

    async track(image: RgbaImage): Promise<FaceTrackingResult> {
      const detector = deps.platformDetector?.() ?? null;
      if (!detector) return { state: 'unavailable', reason: 'no-platform-face-detector' };
      const raw = await detector.detect(image);
      const boxes: FaceBox[] = raw.map((f) => ({
        x: f.boundingBox.x / image.width,
        y: f.boundingBox.y / image.height,
        width: f.boundingBox.width / image.width,
        height: f.boundingBox.height / image.height,
        confidence: 0.5, // Shape Detection reports no confidence — honest fixed floor, never invented
        source: 'platform-shape-detection',
      }));
      return { state: 'tracked', faces: smooth(boxes) };
    },
  };
}
