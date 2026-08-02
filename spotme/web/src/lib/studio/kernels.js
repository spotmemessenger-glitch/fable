/**
 * Spot Me — Creative Studio color kernels: the arithmetic, in one place.
 *
 * Every color adjustment is defined here ONCE as a pure float function over
 * rgb in [0,1]. The CPU evaluator wraps these over bytes; the GLSL preview
 * shaders (ops-color.js) transcribe exactly this arithmetic — same constants,
 * same order of operations — and studio-ops.test.js holds the byte path to
 * this float reference within quantization tolerance. That is what makes
 * "the GPU twin matches the CPU path" a tested statement about the math
 * rather than a hope about two independent implementations.
 *
 * Range conventions (documented per kernel, validated in ops-color.js):
 * sliders are symmetric [-1, 1] with 0 = identity, so UI wiring later cannot
 * get the neutral point wrong.
 */

/** Rec.709 luma — the same weights the shaders use. */
export const LUMA_R = 0.2126
export const LUMA_G = 0.7152
export const LUMA_B = 0.0722

export const luma = (r, g, b) => LUMA_R * r + LUMA_G * g + LUMA_B * b

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

/** GLSL smoothstep, exactly. */
export function smoothstep (e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

/* --------------------------------------------------------------- kernels */

/** Exposure in EV stops: out = in * 2^ev. ev in [-3, 3]. */
export function kExposure (r, g, b, { ev }) {
  const f = Math.pow(2, ev)
  return [clamp01(r * f), clamp01(g * f), clamp01(b * f)]
}

/** Contrast about mid-gray. amount in [-1, 1]; factor = 1 + amount. */
export function kContrast (r, g, b, { amount }) {
  const f = 1 + amount
  return [
    clamp01((r - 0.5) * f + 0.5),
    clamp01((g - 0.5) * f + 0.5),
    clamp01((b - 0.5) * f + 0.5)
  ]
}

/** Saturation: mix from luma. amount in [-1, 1]; -1 = grayscale, +1 = doubled. */
export function kSaturation (r, g, b, { amount }) {
  const y = luma(r, g, b)
  const f = 1 + amount
  return [
    clamp01(y + (r - y) * f),
    clamp01(y + (g - y) * f),
    clamp01(y + (b - y) * f)
  ]
}

/**
 * White balance as channel gains. temp in [-1, 1] warms (+) or cools (−);
 * tint in [-1, 1] shifts green (−) ↔ magenta (+). The 0.25/0.10 scales keep
 * the full slider range inside "plausible photo" rather than color wash.
 */
export function kTemperature (r, g, b, { temp, tint }) {
  return [
    clamp01(r * (1 + 0.25 * temp + 0.05 * tint)),
    clamp01(g * (1 - 0.10 * tint)),
    clamp01(b * (1 - 0.25 * temp + 0.05 * tint))
  ]
}

/**
 * Highlights / shadows. Each in [-1, 1]. Weighted by squared distance from
 * the opposite end of the tone axis, so a shadows lift cannot touch a sky and
 * highlight recovery cannot crush a face: factor_s = 1 + s·0.7·(1−y)²,
 * factor_h = 1 + h·0.7·y², out = in · factor_s · factor_h.
 */
export function kHighlightsShadows (r, g, b, { highlights, shadows }) {
  const y = luma(r, g, b)
  const fs = 1 + shadows * 0.7 * (1 - y) * (1 - y)
  const fh = 1 + highlights * 0.7 * y * y
  const f = fs * fh
  return [clamp01(r * f), clamp01(g * f), clamp01(b * f)]
}

/**
 * Vignette FACTOR for a pixel at normalized (u, v). amount in [-1, 1]
 * (positive darkens corners, negative lifts them), radius [0, 1] where the
 * falloff starts, softness (0, 1] how wide it runs. Distance is normalized so
 * the frame corner sits at 1 regardless of aspect.
 */
export function kVignetteFactor (u, v, { amount, radius, softness }) {
  const dx = (u - 0.5) * 2
  const dy = (v - 0.5) * 2
  const d = Math.sqrt(dx * dx + dy * dy) / Math.SQRT2
  const w = smoothstep(radius, Math.min(1.0001, radius + softness), d)
  return 1 - amount * w
}

/* ----------------------------------------------------------------- curves */

/**
 * Monotone cubic interpolation (Fritsch–Carlson) through control points →
 * a 256-entry LUT in [0,1]. Monotone matters: a plain spline overshoots and
 * a tone curve that reverses direction posterizes; Fritsch–Carlson clamps
 * tangents so the curve is order-preserving between the user's points.
 *
 * points: [[x, y], …] in [0,1], strictly increasing x, 2..16 points.
 */
export function buildCurveLUT (points) {
  if (!Array.isArray(points) || points.length < 2 || points.length > 16) {
    throw new RangeError('curve needs 2..16 points')
  }
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  for (let i = 0; i < points.length; i++) {
    const [x, y] = points[i]
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new RangeError('curve points must be in [0,1]')
    if (i > 0 && !(x > xs[i - 1])) throw new RangeError('curve x must be strictly increasing')
  }
  const n = xs.length
  const h = []
  const delta = []
  for (let i = 0; i < n - 1; i++) {
    h.push(xs[i + 1] - xs[i])
    delta.push((ys[i + 1] - ys[i]) / h[i])
  }
  const m = new Array(n)
  m[0] = delta[0]
  m[n - 1] = delta[n - 2]
  for (let i = 1; i < n - 1; i++) {
    m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (delta[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / delta[i]
    const b = m[i + 1] / delta[i]
    const s = a * a + b * b
    if (s > 9) {
      const t = 3 / Math.sqrt(s)
      m[i] = t * a * delta[i]
      m[i + 1] = t * b * delta[i]
    }
  }
  const lut = new Float32Array(256)
  for (let k = 0; k < 256; k++) {
    const x = k / 255
    if (x <= xs[0]) { lut[k] = clamp01(ys[0]); continue }
    if (x >= xs[n - 1]) { lut[k] = clamp01(ys[n - 1]); continue }
    let i = 0
    while (i < n - 2 && x > xs[i + 1]) i++
    const t = (x - xs[i]) / h[i]
    const t2 = t * t
    const t3 = t2 * t
    const y = (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1]
    lut[k] = clamp01(y)
  }
  return lut
}

/** Sample a 256-entry LUT at x∈[0,1] with linear interpolation. */
export function sampleLUT (lut, x) {
  const p = clamp01(x) * 255
  const i = Math.min(254, Math.floor(p))
  const f = p - i
  return lut[i] * (1 - f) + lut[i + 1] * f
}

/* ------------------------------------------------------------ PRNG (grain) */

/**
 * mulberry32 — small, seedable, and IDENTICAL everywhere JS runs, which is
 * the whole point: grain must re-render byte-identically from a draft.
 */
export function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
