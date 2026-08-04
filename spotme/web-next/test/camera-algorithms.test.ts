/**
 * Stage 1 C2 — the CAM-1 golden-vector suite MIGRATED from the source
 * branch (#56 `test/camera-algorithms.test.js`, read-only): FFT round
 * trips, phase-correlation shift recovery with the PINNED sign convention,
 * Mertens fusion behaviour, night stacking (noise ↓ √N, alignment, motion
 * rejection), and plane helpers. All fixtures tiny, synthetic, seeded.
 */

import { describe, expect, it } from 'vitest';
import { fft1d, fft2d, isPow2 } from '../src/camera/fft';
import { MIN_SHIFT_CONFIDENCE, estimateShift } from '../src/camera/align';
import { fuseExposures, weightPlane } from '../src/camera/hdr';
import { stackFrames } from '../src/camera/night';
import { createStabilizer, stabilizeFrame } from '../src/camera/stabilize';
import {
  boxBlurImage, boxBlurPlane, downscalePlane, lumaPlane, meanAbsDiff,
  nextPow2, planeVariance, shiftImage, shiftPlane,
} from '../src/camera/imagemath';
import { scene64 } from '../src/camera/fixtures';
import type { LumaPlane, RgbaImage } from '../src/camera/types';

function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function grey(v: number, width: number, height: number, alpha = 255): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = alpha; }
  return { data, width, height };
}

function addNoise(image: RgbaImage, sigma: number, rand: () => number): RgbaImage {
  const out = { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  for (let i = 0; i < out.data.length; i += 4) {
    const n = Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand()) * sigma;
    out.data[i] += n; out.data[i + 1] += n; out.data[i + 2] += n;
  }
  return out;
}

function residual(image: RgbaImage, clean: RgbaImage): LumaPlane {
  const out = new Float32Array(image.width * image.height);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) out[p] = (image.data[i] - clean.data[i]) / 255;
  return { data: out, width: image.width, height: image.height };
}

describe('FFT', () => {
  it('isPow2 and nextPow2 agree', () => {
    expect(isPow2(64)).toBe(true);
    expect(isPow2(48)).toBe(false);
    expect(nextPow2(48)).toBe(64);
    expect(nextPow2(64)).toBe(64);
  });

  it('impulse transforms to flat 1s (the analytic answer)', () => {
    const re = new Float32Array(8); const im = new Float32Array(8);
    re[0] = 1;
    fft1d(re, im);
    for (const v of re) expect(Math.abs(v - 1)).toBeLessThan(1e-6);
    for (const v of im) expect(Math.abs(v)).toBeLessThan(1e-6);
  });

  it('a pure cosine puts its energy in exactly bins k and N-k', () => {
    const N = 16;
    const re = new Float32Array(N); const im = new Float32Array(N);
    for (let x = 0; x < N; x++) re[x] = Math.cos((2 * Math.PI * 3 * x) / N);
    fft1d(re, im);
    const mag = [...re].map((r, i) => Math.hypot(r, im[i]));
    const big = mag.map((m, i) => (m > 1 ? i : -1)).filter((i) => i >= 0);
    expect(big.join(',')).toBe('3,13');
    expect(Math.abs(mag[3] - N / 2)).toBeLessThan(1e-4);
  });

  it('fft2d round-trips to the input (1e-5)', () => {
    const rand = mulberry32(7);
    const N = 16;
    const original = new Float32Array(N * N).map(() => rand());
    const re = new Float32Array(original); const im = new Float32Array(N * N);
    fft2d(re, im, N, N);
    fft2d(re, im, N, N, true);
    original.forEach((v, i) => expect(Math.abs(v - re[i])).toBeLessThan(1e-5));
  });

  it('a non-pow2 size THROWS instead of quietly padding', () => {
    expect(() => fft1d(new Float32Array(12), new Float32Array(12))).toThrow();
  });
});

describe('phase correlation (sign convention pinned)', () => {
  it('recovers a known (+4,+2) shift', () => {
    const reference = lumaPlane(scene64());
    const moved = shiftPlane(reference, 4, 2);
    const est = estimateShift(reference, moved);
    expect(Math.abs(est.dx - 4)).toBeLessThanOrEqual(1);
    expect(Math.abs(est.dy - 2)).toBeLessThanOrEqual(1);
    expect(est.confidence).toBeGreaterThan(0.2);
  });

  it('recovers a negative shift (-6,-3)', () => {
    const reference = lumaPlane(scene64());
    const moved = shiftPlane(reference, -6, -3);
    const est = estimateShift(reference, moved);
    expect(Math.abs(est.dx + 6)).toBeLessThanOrEqual(1);
    expect(Math.abs(est.dy + 3)).toBeLessThanOrEqual(1);
  });

  it('zero shift reports ~zero with HIGH confidence', () => {
    const reference = lumaPlane(scene64());
    const est = estimateShift(reference, reference);
    expect(Math.abs(est.dx)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(est.dy)).toBeLessThanOrEqual(0.5);
    expect(est.confidence).toBeGreaterThan(0.3);
  });

  it('survives seeded sensor noise (sigma=6)', () => {
    const rand = mulberry32(42);
    const clean = scene64();
    const reference = lumaPlane(addNoise(clean, 6, rand));
    const moved = lumaPlane(addNoise(shiftImage(clean, 3, -2), 6, rand));
    const est = estimateShift(reference, moved);
    expect(Math.abs(est.dx - 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(est.dy + 2)).toBeLessThanOrEqual(1);
  });

  it('a FLAT frame gets confidence 0 and zero shift — the texture gate', () => {
    const structured = lumaPlane(scene64());
    const flat = lumaPlane(grey(128, 64, 64));
    const est = estimateShift(structured, flat);
    const estBoth = estimateShift(flat, flat);
    expect(est).toMatchObject({ dx: 0, dy: 0, confidence: 0, flat: true });
    expect(estBoth).toMatchObject({ confidence: 0, flat: true });
  });

  it('two UNRELATED noise fields score below the trust floor — no hallucinated shift', () => {
    const a = lumaPlane(addNoise(grey(128, 64, 64), 20, mulberry32(1)));
    const b = lumaPlane(addNoise(grey(128, 64, 64), 20, mulberry32(99)));
    expect(estimateShift(a, b).confidence).toBeLessThan(MIN_SHIFT_CONFIDENCE);
  });
});

describe('HDR fusion (Mertens)', () => {
  it('fusing one frame is the identity (fresh buffer)', () => {
    const image = scene64();
    const fused = fuseExposures([image]);
    if (!fused.available) throw new Error('expected fusion');
    expect(fused.image.data).not.toBe(image.data);
    expect([...fused.image.data]).toEqual([...image.data]);
  });

  it('well-exposedness dominates flat fields: mid beats dark', () => {
    const fused = fuseExposures([grey(20, 16, 16), grey(128, 16, 16)], { blurRadius: 2 });
    if (!fused.available) throw new Error('expected fusion');
    const v = fused.image.data[4 * (8 * 16 + 8)];
    expect(v).toBeGreaterThan(100);
    expect(v).toBeLessThanOrEqual(128);
  });

  it('an over-exposed white field loses to mid grey the same way', () => {
    const fused = fuseExposures([grey(250, 16, 16), grey(128, 16, 16)], { blurRadius: 2 });
    if (!fused.available) throw new Error('expected fusion');
    const v = fused.image.data[4 * (8 * 16 + 8)];
    expect(v).toBeGreaterThanOrEqual(128);
    expect(v).toBeLessThan(165);
  });

  it('output stays inside the hull of its inputs (no ringing off bytes)', () => {
    const rand = mulberry32(5);
    const a = addNoise(scene64(), 10, rand);
    const b = addNoise(scene64(), 10, rand);
    const fused = fuseExposures([a, b], { blurRadius: 4 });
    if (!fused.available) throw new Error('expected fusion');
    for (let i = 0; i < fused.image.data.length; i += 4) {
      const low = Math.min(a.data[i], b.data[i]) - 1;
      const high = Math.max(a.data[i], b.data[i]) + 1;
      expect(fused.image.data[i]).toBeGreaterThanOrEqual(low);
      expect(fused.image.data[i]).toBeLessThanOrEqual(high);
    }
  });

  it('weightPlane: mid-grey outweighs near-black on exposedness', () => {
    const w1 = weightPlane(grey(128, 4, 4)).data[5];
    const w2 = weightPlane(grey(10, 4, 4)).data[5];
    expect(w1).toBeGreaterThan(w2 * 10);
  });

  it('mismatched geometry is a named refusal', () => {
    const r = fuseExposures([grey(1, 4, 4), grey(1, 8, 8)]);
    expect(r.available).toBe(false);
    if (!r.available) expect(r.detail).toMatch(/geometry/);
  });
});

describe('night stacking', () => {
  it('stacking 8 noisy frames cuts noise variance >= 3x (sqrt-N law)', () => {
    const rand = mulberry32(11);
    const clean = scene64();
    const frames = Array.from({ length: 8 }, () => addNoise(clean, 12, rand));
    const stacked = stackFrames(frames, { motionThreshold: 1 });
    if (!stacked.available) throw new Error('expected stack');
    const noiseBefore = planeVariance(residual(frames[1], clean));
    const noiseAfter = planeVariance(residual(stacked.image, clean));
    expect(noiseAfter * 3).toBeLessThan(noiseBefore);
  });

  it('shifted frames are ALIGNED before averaging; disabling alignment drops them', () => {
    const rand = mulberry32(23);
    const clean = scene64();
    const frames = [
      addNoise(clean, 6, rand),
      addNoise(shiftImage(clean, 3, 1), 6, rand),
      addNoise(shiftImage(clean, -2, 2), 6, rand),
      addNoise(shiftImage(clean, 1, -3), 6, rand),
    ];
    const aligned = stackFrames(frames);
    const unaligned = stackFrames(frames, { maxShiftFraction: 0 });
    if (!aligned.available || !unaligned.available) throw new Error('expected stacks');
    const err = meanAbsDiff(lumaPlane(aligned.image), lumaPlane(clean));
    const errShifted = meanAbsDiff(lumaPlane(frames[1]), lumaPlane(clean));
    expect(aligned.framesUsed).toBe(4);
    expect(err).toBeLessThan(errShifted * 0.7);
    expect(unaligned.framesUsed).toBe(1);
  });

  it('detected shifts match the synthetic ground truth', () => {
    const rand = mulberry32(23);
    const clean = scene64();
    const frames = [addNoise(clean, 6, rand), addNoise(shiftImage(clean, 3, 1), 6, rand)];
    const stacked = stackFrames(frames);
    if (!stacked.available) throw new Error('expected stack');
    const applied = stacked.shifts[1].applied!;
    expect(Math.abs(applied.dx + 3)).toBeLessThanOrEqual(1);
    expect(Math.abs(applied.dy + 1)).toBeLessThanOrEqual(1);
  });

  it('a MOVING OBJECT is rejected: the ghost stays out, the reference wins', () => {
    const clean = scene64();
    const movedObject = shiftImage(clean, 0, 0);
    for (let y = 48; y < 56; y++) {
      for (let x = 4; x < 12; x++) {
        const i = (y * 64 + x) * 4;
        movedObject.data[i] = 255; movedObject.data[i + 1] = 255; movedObject.data[i + 2] = 255;
      }
    }
    const stacked = stackFrames([clean, movedObject, movedObject, movedObject]);
    if (!stacked.available) throw new Error('expected stack');
    const i = (50 * 64 + 8) * 4;
    const referenceValue = clean.data[i];
    const naive = (referenceValue + 255 * 3) / 4;
    const got = stacked.image.data[i];
    expect(Math.abs(got - referenceValue)).toBeLessThanOrEqual(2);
    expect(Math.abs(got - naive)).toBeGreaterThan(40);
    expect(stacked.rejectedFraction).toBeGreaterThan(0.005);
  });

  it('median mode survives one wild outlier better than mean', () => {
    const base = grey(100, 8, 8);
    const outlier = grey(115, 8, 8);
    const med = stackFrames([base, base, base, outlier, base], { mode: 'median', motionThreshold: 1 });
    const mean = stackFrames([base, base, base, outlier, base], { mode: 'mean', motionThreshold: 1 });
    if (!med.available || !mean.available) throw new Error('expected stacks');
    const i = 4 * (3 * 8 + 3);
    expect(med.image.data[i]).toBe(100);
    expect(mean.image.data[i]).toBe(103);
  });

  it('single-frame stack is the frame (fresh buffer), reported as 1 used', () => {
    const image = scene64();
    const stacked = stackFrames([image]);
    if (!stacked.available) throw new Error('expected stack');
    expect(stacked.framesUsed).toBe(1);
    expect([...stacked.image.data]).toEqual([...image.data]);
  });
});

describe('EIS basic (ported smoke)', () => {
  it('smooths seeded jitter: corrections oppose the raw path and stay inside the crop margin', () => {
    const rand = mulberry32(9);
    const clean = scene64();
    const stab = createStabilizer({ tileSize: 32 });
    let clampedWithin = true;
    for (let f = 0; f < 10; f++) {
      const jx = Math.round((rand() - 0.5) * 8);
      const jy = Math.round((rand() - 0.5) * 8);
      const frame = shiftImage(clean, jx, jy);
      const correction = stab.feed(lumaPlane(frame));
      if (Math.abs(correction.dx) > 64 * 0.08 + 1e-9 || Math.abs(correction.dy) > 64 * 0.08 + 1e-9) clampedWithin = false;
      const out = stabilizeFrame(frame, correction);
      expect(out.width).toBe(64 - 2 * Math.round(64 * 0.08));
    }
    expect(clampedWithin).toBe(true);
    expect(stab.state().frames).toBe(10);
  });
});

describe('plane helpers', () => {
  it('luma weights: green > red > blue; white is 1', () => {
    const px = (r: number, g: number, b: number) =>
      lumaPlane({ data: new Uint8ClampedArray([r, g, b, 255]), width: 1, height: 1 }).data[0];
    expect(px(0, 255, 0)).toBeGreaterThan(px(255, 0, 0));
    expect(px(255, 0, 0)).toBeGreaterThan(px(0, 0, 255));
    expect(Math.abs(px(255, 255, 255) - 1)).toBeLessThan(1e-6);
  });

  it('downscalePlane preserves the mean (energy-preserving)', () => {
    const rand = mulberry32(3);
    const plane = { data: new Float32Array(32 * 32).map(() => rand()), width: 32, height: 32 };
    const small = downscalePlane(plane, 8, 8);
    const mean = (p: LumaPlane) => [...p.data].reduce((a, b) => a + b, 0) / p.data.length;
    expect(Math.abs(mean(plane) - mean(small))).toBeLessThan(1e-3);
  });

  it('shiftImage clamps edges — no wraparound ghosts', () => {
    const image = grey(0, 4, 4);
    image.data[0] = 200;
    const shifted = shiftImage(image, 1, 0);
    expect(shifted.data[4]).toBe(200);
    expect(shifted.data[0]).toBe(200);
    expect(shifted.data[12]).toBe(0);
  });

  it('boxBlurPlane preserves a constant field exactly', () => {
    const plane = { data: new Float32Array(64).fill(0.4), width: 8, height: 8 };
    for (const v of boxBlurPlane(plane, 2).data) expect(Math.abs(v - 0.4)).toBeLessThan(1e-6);
  });

  it('boxBlurImage spreads an impulse and preserves alpha', () => {
    const image = grey(0, 5, 5);
    image.data[(2 * 5 + 2) * 4] = 255;
    const blurred = boxBlurImage(image, 1, 1);
    const centre = blurred.data[(2 * 5 + 2) * 4];
    const side = blurred.data[(2 * 5 + 1) * 4];
    expect(centre).toBeGreaterThan(0);
    expect(centre).toBeLessThan(255);
    expect(side).toBeGreaterThan(0);
    expect(blurred.data[3]).toBe(255);
  });
});
