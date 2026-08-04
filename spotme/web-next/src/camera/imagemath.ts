/**
 * Plane and pixel math shared by HDR, night stack, alignment and
 * stabilization — TypeScript port of the CAM-1 `imagemath.js` (#56,
 * read-only source), formula-for-formula. Pure: fresh buffers, inputs
 * untouched, zero dependencies.
 */

import type { LumaPlane, RgbaImage } from './types';

/** Rec.709 luma, normalized 0..1 — the plane every aligner works on. */
export function lumaPlane(image: RgbaImage): LumaPlane {
  const { data, width, height } = image;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
  }
  return { data: out, width, height };
}

/** Box-filter downscale of a plane to an exact target size. Every source
 *  pixel lands in exactly one bucket, so energy is preserved. */
export function downscalePlane(plane: LumaPlane, targetW: number, targetH: number): LumaPlane {
  const { data, width, height } = plane;
  const out = new Float32Array(targetW * targetH);
  const counts = new Float32Array(targetW * targetH);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(targetH - 1, Math.floor((y * targetH) / height));
    for (let x = 0; x < width; x++) {
      const tx = Math.min(targetW - 1, Math.floor((x * targetW) / width));
      const t = ty * targetW + tx;
      out[t] += data[y * width + x];
      counts[t]++;
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = counts[i] ? out[i] / counts[i] : 0;
  return { data: out, width: targetW, height: targetH };
}

/** Integer-shift an RGBA image with edge CLAMP (no wraparound: wrapped
 *  pixels are lies from the far side of the frame). dx,dy move CONTENT
 *  right/down. */
export function shiftImage(image: RgbaImage, dx: number, dy: number): RgbaImage {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(height - 1, Math.max(0, y - dy));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.max(0, x - dx));
      const s = (sy * width + sx) * 4;
      const d = (y * width + x) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width, height };
}

/** Same shift for a float plane. */
export function shiftPlane(plane: LumaPlane, dx: number, dy: number): LumaPlane {
  const { data, width, height } = plane;
  const out = new Float32Array(data.length);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(height - 1, Math.max(0, y - dy));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(width - 1, Math.max(0, x - dx));
      out[y * width + x] = data[sy * width + sx];
    }
  }
  return { data: out, width, height };
}

/** One separable box-blur pass over a float plane, radius r. */
export function boxBlurPlane(plane: LumaPlane, radius: number): LumaPlane {
  if (radius <= 0) return { data: new Float32Array(plane.data), width: plane.width, height: plane.height };
  const { width, height } = plane;
  const tmp = new Float32Array(width * height);
  const out = new Float32Array(width * height);
  const src = plane.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0; let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < width) { sum += src[y * width + xx]; n++; }
      }
      tmp[y * width + x] = sum / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0; let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < height) { sum += tmp[yy * width + x]; n++; }
      }
      out[y * width + x] = sum / n;
    }
  }
  return { data: out, width, height };
}

/** RGBA box blur (radius r), edge-clamped, alpha preserved. `passes` ≥ 3
 *  approximates a Gaussian. */
export function boxBlurImage(image: RgbaImage, radius: number, passes = 1): RgbaImage {
  let current = image;
  for (let p = 0; p < passes; p++) current = boxBlurOnce(current, radius);
  return current;
}

function boxBlurOnce(image: RgbaImage, radius: number): RgbaImage {
  if (radius <= 0) return { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height };
  const { data, width, height } = image;
  const tmp = new Float32Array(width * height * 4);
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx < 0 || xx >= width) continue;
        const s = (y * width + xx) * 4;
        r += data[s]; g += data[s + 1]; b += data[s + 2]; a += data[s + 3]; n++;
      }
      const d = (y * width + x) * 4;
      tmp[d] = r / n; tmp[d + 1] = g / n; tmp[d + 2] = b / n; tmp[d + 3] = a / n;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= height) continue;
        const s = (yy * width + x) * 4;
        r += tmp[s]; g += tmp[s + 1]; b += tmp[s + 2]; a += tmp[s + 3]; n++;
      }
      const d = (y * width + x) * 4;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = a / n;
    }
  }
  return { data: out, width, height };
}

/** Mean of |a-b| over two planes — motion/quality scoring. */
export function meanAbsDiff(a: LumaPlane, b: LumaPlane): number {
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return sum / a.data.length;
}

/** Plane variance — the noise-reduction assertion in the night tests. */
export function planeVariance(plane: LumaPlane): number {
  const n = plane.data.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += plane.data[i];
  mean /= n;
  let variance = 0;
  for (let i = 0; i < n; i++) { const d = plane.data[i] - mean; variance += d * d; }
  return variance / n;
}

/** Next power of two ≥ n (FFT sizing). */
export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
