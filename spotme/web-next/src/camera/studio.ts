/**
 * Creative Studio — Stage 1 subset (C3): the non-destructive edit-document
 * evaluator over the C1 contract vocabulary. The OP-DOC MODEL and undo
 * semantics port from #55 `opdoc.js` (read-only source): a document is a
 * base + ordered ops; undo IS slicing; evaluation is pure (fresh buffers).
 * The adjustment kernels are re-expressed in TypeScript against the closed
 * contract ops — including the source's Fritsch–Carlson monotone cubic for
 * curves (monotone in, monotone out; no overshoot) — honestly labeled a
 * subset re-derivation, not byte-identical kernels; the full CAM-4 kernel
 * set (removal/bg/sky/relight/composer/…) remains on the source branch.
 */

import type { CurvePoint, EditDocument, EditOp, LookId } from '@spotme/contracts';
import type { RgbaImage } from './types';

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const clamp255 = (v: number) => Math.max(0, Math.min(255, v));

/* ---------------- op-doc model (ported semantics) ---------------- */

export function createDocument(baseMediaId: string): EditDocument {
  return { version: 1, baseMediaId, ops: [] };
}

export function pushOp(doc: EditDocument, op: EditOp): EditDocument {
  return { ...doc, ops: [...doc.ops, op] };
}

/** Undo IS document slicing — there is no destructive mutation to reverse. */
export function undo(doc: EditDocument): EditDocument {
  return { ...doc, ops: doc.ops.slice(0, -1) };
}

/** Serialization round-trip: documents are plain versioned data. */
export function serializeDocument(doc: EditDocument): string {
  return JSON.stringify(doc);
}

export function deserializeDocument(json: string): EditDocument | null {
  try {
    const parsed = JSON.parse(json) as EditDocument;
    if (parsed?.version !== 1 || typeof parsed.baseMediaId !== 'string' || !Array.isArray(parsed.ops)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ---------------- curves: Fritsch–Carlson monotone cubic → LUT ---------------- */

/** Build a 256-entry LUT through the control points, monotone by
 *  construction (the source's curve discipline: no overshoot, ever). */
export function curveLut(points: readonly CurvePoint[]): Uint8Array {
  const ps = [...points].sort((a, b) => a.x - b.x).map((p) => ({ x: clamp01(p.x), y: clamp01(p.y) }));
  const n = ps.length;
  const lut = new Uint8Array(256);
  if (n === 1) { lut.fill(Math.round(ps[0].y * 255)); return lut; }

  // Secant slopes, then Fritsch–Carlson tangent limiting.
  const h: number[] = []; const delta: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(Math.max(1e-9, ps[i + 1].x - ps[i].x));
    delta.push((ps[i + 1].y - ps[i].y) / h[i]);
  }
  const m: number[] = [delta[0]];
  for (let i = 1; i < n - 1; i++) {
    m.push(delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2);
  }
  m.push(delta[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / delta[i];
    const b = m[i + 1] / delta[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * delta[i]; m[i + 1] = t * b * delta[i]; }
  }

  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    if (x <= ps[0].x) { lut[v] = Math.round(ps[0].y * 255); continue; }
    if (x >= ps[n - 1].x) { lut[v] = Math.round(ps[n - 1].y * 255); continue; }
    let i = 0;
    while (i < n - 2 && x > ps[i + 1].x) i++;
    const t = (x - ps[i].x) / h[i];
    const t2 = t * t; const t3 = t2 * t;
    const y = (2 * t3 - 3 * t2 + 1) * ps[i].y + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ps[i + 1].y + (t3 - t2) * h[i] * m[i + 1];
    lut[v] = Math.round(clamp01(y) * 255);
  }
  return lut;
}

/* ---------------- looks: 8 procedural per-channel curves ---------------- */

/** Honestly named procedural looks — parameterized channel gains + tone
 *  bias, never "AI". Strength blends look output with the input. */
const LOOKS: Readonly<Record<LookId, { r: number; g: number; b: number; contrast: number; lift: number }>> = Object.freeze({
  silver: { r: 0.95, g: 0.97, b: 1.0, contrast: 0.1, lift: 0.02 },
  ember: { r: 1.08, g: 0.98, b: 0.9, contrast: 0.08, lift: 0 },
  coast: { r: 0.94, g: 1.0, b: 1.08, contrast: 0.05, lift: 0.02 },
  meadow: { r: 0.97, g: 1.06, b: 0.95, contrast: 0.05, lift: 0 },
  noir: { r: 1.0, g: 1.0, b: 1.0, contrast: 0.35, lift: -0.05 },
  lumen: { r: 1.03, g: 1.03, b: 1.0, contrast: -0.05, lift: 0.08 },
  fade: { r: 1.0, g: 1.0, b: 1.0, contrast: -0.2, lift: 0.1 },
  dusk: { r: 1.02, g: 0.96, b: 1.06, contrast: 0.12, lift: -0.02 },
});

/* ---------------- the evaluator ---------------- */

function applyScalar(image: RgbaImage, kind: string, value: number): RgbaImage {
  const v = Math.max(-1, Math.min(1, value));
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    let r = src[i] / 255; let g = src[i + 1] / 255; let b = src[i + 2] / 255;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    switch (kind) {
      case 'exposure': { const gain = Math.pow(2, v); r *= gain; g *= gain; b *= gain; break; }
      case 'contrast': { const k = 1 + v; r = 0.5 + (r - 0.5) * k; g = 0.5 + (g - 0.5) * k; b = 0.5 + (b - 0.5) * k; break; }
      case 'saturation': { const k = 1 + v; r = luma + (r - luma) * k; g = luma + (g - luma) * k; b = luma + (b - luma) * k; break; }
      case 'temperature': { r += 0.1 * v; b -= 0.1 * v; break; }
      case 'tint': { g += 0.1 * v; break; }
      case 'highlights': { const w = clamp01((luma - 0.5) * 2); const k = 1 + v * w * 0.6; r *= k; g *= k; b *= k; break; }
      case 'shadows': { const w = clamp01((0.5 - luma) * 2); const k = 1 + v * w * 0.6; r *= k; g *= k; b *= k; break; }
      default: break; // vignette/sharpen/clarity/grain are SPATIAL — applied in their own kernels (F-CAM-3)
    }
    out[i] = clamp255(r * 255); out[i + 1] = clamp255(g * 255); out[i + 2] = clamp255(b * 255); out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

function applyCurves(image: RgbaImage, points: readonly CurvePoint[]): RgbaImage {
  const lut = curveLut(points);
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    out[i] = lut[src[i]]; out[i + 1] = lut[src[i + 1]]; out[i + 2] = lut[src[i + 2]]; out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

function applyCrop(image: RgbaImage, x: number, y: number, width: number, height: number): RgbaImage {
  const cx = Math.max(0, Math.min(image.width - 1, Math.round(x)));
  const cy = Math.max(0, Math.min(image.height - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(image.width - cx, Math.round(width)));
  const ch = Math.max(1, Math.min(image.height - cy, Math.round(height)));
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let row = 0; row < ch; row++) {
    const srcStart = ((cy + row) * image.width + cx) * 4;
    out.set(image.data.subarray(srcStart, srcStart + cw * 4), row * cw * 4);
  }
  return { data: out, width: cw, height: ch };
}

function applyRotate(image: RgbaImage, quarterTurns: 1 | 2 | 3): RgbaImage {
  const { data, width, height } = image;
  const swap = quarterTurns % 2 === 1;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let tx: number; let ty: number;
      if (quarterTurns === 1) { tx = height - 1 - y; ty = x; }
      else if (quarterTurns === 2) { tx = width - 1 - x; ty = height - 1 - y; }
      else { tx = y; ty = width - 1 - x; }
      const s = (y * width + x) * 4;
      const d = (ty * w + tx) * 4;
      out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = data[s + 3];
    }
  }
  return { data: out, width: w, height: h };
}

function applyLook(image: RgbaImage, look: LookId, strength: number): RgbaImage {
  const s = clamp01(strength);
  const params = LOOKS[look];
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    const channels = [src[i] / 255 * params.r, src[i + 1] / 255 * params.g, src[i + 2] / 255 * params.b];
    for (let c = 0; c < 3; c++) {
      let v = channels[c];
      v = 0.5 + (v - 0.5) * (1 + params.contrast) + params.lift;
      if (look === 'noir') {
        const lum = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
        v = 0.5 + (lum - 0.5) * (1 + params.contrast) + params.lift;
      }
      const original = src[i + c] / 255;
      out[i + c] = clamp255((original + s * (v - original)) * 255);
    }
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

/* ---------------- spatial kernels (review repair F-CAM-3: a stored op
 * that silently did nothing was a lie — these four now really apply) ----- */

function boxBlurRgba(image: RgbaImage, radius: number): RgbaImage {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0; let g = 0; let b = 0; let n = 0;
      for (let ky = -radius; ky <= radius; ky++) {
        for (let kx = -radius; kx <= radius; kx++) {
          const yy = y + ky; const xx = x + kx;
          if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
          const s = (yy * width + xx) * 4;
          r += data[s]; g += data[s + 1]; b += data[s + 2]; n++;
        }
      }
      const d = (y * width + x) * 4;
      out[d] = r / n; out[d + 1] = g / n; out[d + 2] = b / n; out[d + 3] = data[d + 3];
    }
  }
  return { data: out, width, height };
}

/** Unsharp mask: out = src + amount·(src − blur). Sharpen uses a tight
 *  radius; clarity the same mechanism at a wider radius, lower gain. */
function applyUnsharp(image: RgbaImage, amount: number, radius: number, gain: number): RgbaImage {
  const v = Math.max(-1, Math.min(1, amount)) * gain;
  const blur = boxBlurRgba(image, radius);
  const out = new Uint8ClampedArray(image.data.length);
  const src = image.data;
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) out[i + c] = clamp255(src[i + c] + v * (src[i + c] - blur.data[i + c]));
    out[i + 3] = src[i + 3];
  }
  return { data: out, width: image.width, height: image.height };
}

/** Radial darkening toward the corners, strength 0..1. */
function applyVignette(image: RgbaImage, value: number): RgbaImage {
  const v = clamp01(Math.abs(value)) * 0.6;
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  const cx = (width - 1) / 2; const cy = (height - 1) / 2;
  const maxDist = Math.hypot(cx, cy) || 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const fall = 1 - v * Math.pow(Math.hypot(x - cx, y - cy) / maxDist, 2);
      out[i] = data[i] * fall; out[i + 1] = data[i + 1] * fall; out[i + 2] = data[i + 2] * fall; out[i + 3] = data[i + 3];
    }
  }
  return { data: out, width, height };
}

/** Deterministic film grain — seeded PRNG, replayable (no ambient time). */
function applyGrain(image: RgbaImage, value: number): RgbaImage {
  const v = clamp01(Math.abs(value)) * 24;
  let seed = 0x9e3779b9;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const n = (rand() - 0.5) * 2 * v;
    out[i] = clamp255(data[i] + n); out[i + 1] = clamp255(data[i + 1] + n); out[i + 2] = clamp255(data[i + 2] + n);
    out[i + 3] = data[i + 3];
  }
  return { data: out, width, height };
}

/** Ops the jsdom evaluator stores but does NOT rasterize — the honest
 *  disclosure surface (F-CAM-3). Exactly ['straighten'] this stage: its
 *  sub-degree resample is the Stage 2 GL path. */
export function unappliedOps(doc: EditDocument): EditOp['kind'][] {
  return [...new Set(doc.ops.filter((op) => op.kind === 'straighten').map((op) => op.kind))];
}

/** Evaluate a document against its base image — pure, in op order. */
export function evaluateDocument(base: RgbaImage, doc: EditDocument): RgbaImage {
  let current: RgbaImage = { data: new Uint8ClampedArray(base.data), width: base.width, height: base.height };
  for (const op of doc.ops) {
    switch (op.kind) {
      case 'curves': current = applyCurves(current, op.points); break;
      case 'crop': current = applyCrop(current, op.x, op.y, op.width, op.height); break;
      case 'rotate': current = applyRotate(current, op.quarterTurns); break;
      case 'straighten': break; // stored, honestly not rasterized in jsdom — see unappliedOps()
      case 'look': current = applyLook(current, op.look, op.strength); break;
      case 'vignette': current = applyVignette(current, op.value); break;
      case 'sharpen': current = applyUnsharp(current, op.value, 1, 1.0); break;
      case 'clarity': current = applyUnsharp(current, op.value, 3, 0.5); break;
      case 'grain': current = applyGrain(current, op.value); break;
      default: current = applyScalar(current, op.kind, op.value); break;
    }
  }
  return current;
}
