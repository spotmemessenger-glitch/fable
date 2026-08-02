/**
 * Spot Me AR/beauty — beauty TIER 0: real image math that needs NO
 * landmarks. Three ../camera/pipeline.js stages, each with a bit-exact CPU
 * reference (golden-tested in Node) and a GLSL twin for the WebGL2
 * executor (same math as a single fragment pass; CPU is the tested
 * reference semantics, per the portrait precedent).
 *
 * NATURAL-ONLY, BY CONSTRUCTION. Every stage clamps its parameters into
 * the hard-coded BEAUTY_LIMITS caps INSIDE cpu() and uniforms() — a caller
 * passing strength 5 gets exactly the capped effect, tested. The caps are
 * the module's naturalness policy (ar-activation.md records the owner
 * sign-off item): skin keeps texture, warmth cannot cook a face orange,
 * brighten cannot clip. There is no "beyond natural" parameter path.
 *
 * THE SKIN MASK, from first principles: pixels are classified by chroma in
 * YCbCr (BT.601): the well-measured skin cluster Cb ∈ [77,127],
 * Cr ∈ [133,173] (Chai & Ngan 1999), with soft 8-unit ramps at every
 * boundary and a shadow gate on Y (ramp 40→64) so noise in the dark is
 * not "skin". This is a chroma test, not a person test: it needs no
 * landmarks, works for every skin tone inside the photographed gamut, and
 * fails soft (mask 0 = stage does nothing).
 *
 * THE SMOOTHER, from first principles: a SEPARABLE BILATERAL APPROXIMATION
 * — two 1-D passes (horizontal, then vertical) of a box-spatial,
 * Gaussian-range filter: w_k = exp(−ΔY_k² / 2σ²) where ΔY is the luma
 * difference to the window centre. Range weighting is what preserves
 * edges (a jawline neighbour with ΔY ≈ 0.5 at σ = 0.08 weighs e⁻²⁰ ≈ 0);
 * separability is what makes it O(r) per pixel instead of O(r²).
 */

import { clamp255 } from '../camera/pipeline.js'
import { clamp01, pixelLuma } from './armath.js'

/** The naturalness caps — hard bounds, enforced in every stage, tested. */
export const BEAUTY_LIMITS = Object.freeze({
  /** Max share of the smoothed value blended in on full-probability skin. */
  SKIN_SMOOTH_MAX_BLEND: 0.65,
  /** Bilateral window radius (px per pass). */
  SKIN_SMOOTH_RADIUS: 3,
  /** Range sigma in 0..1 luma — edges beyond ~2σ survive untouched. */
  SKIN_SMOOTH_RANGE_SIGMA: 0.08,
  /** Max ±R/B shift at |warmth| = 1, in 0..255 units. */
  WARMTH_MAX_SHIFT: 12,
  /** Max S-curve (or flatten) blend at |tone| = 1. */
  TONE_MAX_BLEND: 0.25,
  /** Max fraction of per-pixel headroom lifted at strength 1 — cannot clip. */
  BRIGHTEN_MAX_LIFT: 0.30,
})

/* ------------------------------------------------------------ skin mask -- */

/** Soft membership of x in [lo, hi] with `ramp`-unit smooth edges. */
function softBand (x, lo, hi, ramp) {
  const rise = clamp01((x - (lo - ramp)) / ramp)
  const fall = clamp01(((hi + ramp) - x) / ramp)
  return Math.min(rise, fall)
}

/** Per-pixel skin probability, 0..1 (BT.601 chroma cluster + shadow gate).
 *  Exported so tests pin the classifier itself, not just its effect. */
export function skinToneMask (image) {
  const { data, width, height } = image
  const out = new Float32Array(width * height)
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
    const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
    const shadowGate = clamp01((y - 40) / 24)
    out[p] = softBand(cb, 77, 127, 8) * softBand(cr, 133, 173, 8) * shadowGate
  }
  return { data: out, width, height }
}

/* ------------------------------------------- separable bilateral core ---- */

/** One 1-D bilateral pass along x (dx=1,dy=0) or y (dx=0,dy=1). */
function bilateralPass (image, dx, dy, radius, sigma) {
  const { data, width, height } = image
  const out = new Uint8ClampedArray(data.length)
  const inv2s2 = 1 / (2 * sigma * sigma)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const ci = (y * width + x) * 4
      const centerLuma = pixelLuma(data, ci) / 255
      let wSum = 0
      let r = 0
      let g = 0
      let b = 0
      for (let k = -radius; k <= radius; k++) {
        const nx = x + k * dx
        const ny = y + k * dy
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
        const ni = (ny * width + nx) * 4
        const d = pixelLuma(data, ni) / 255 - centerLuma
        const w = Math.exp(-(d * d) * inv2s2)
        wSum += w
        r += w * data[ni]
        g += w * data[ni + 1]
        b += w * data[ni + 2]
      }
      out[ci] = r / wSum
      out[ci + 1] = g / wSum
      out[ci + 2] = b / wSum
      out[ci + 3] = data[ci + 3]
    }
  }
  return { data: out, width, height }
}

/* ---------------------------------------------------------- the stages --- */

/**
 * Stage 1 — skin-tone-masked edge-preserving smoothing.
 * `strength` 0..1 (clamped); effective blend = strength ×
 * SKIN_SMOOTH_MAX_BLEND × per-pixel skin probability. Non-skin pixels and
 * hard edges pass through by construction.
 */
export function skinSmoothStage (strength = 0.5) {
  return {
    name: 'beauty-skin-smooth',
    params: { strength },
    cpu (image, params) {
      const s = clamp01(params.strength)
      const { SKIN_SMOOTH_RADIUS: radius, SKIN_SMOOTH_RANGE_SIGMA: sigma, SKIN_SMOOTH_MAX_BLEND: cap } = BEAUTY_LIMITS
      const mask = skinToneMask(image)
      const h = bilateralPass(image, 1, 0, radius, sigma)
      const smooth = bilateralPass(h, 0, 1, radius, sigma)
      const out = new Uint8ClampedArray(image.data.length)
      const src = image.data
      for (let i = 0, p = 0; i < src.length; i += 4, p++) {
        const blend = s * cap * mask.data[p]
        out[i] = src[i] + blend * (smooth.data[i] - src[i])
        out[i + 1] = src[i + 1] + blend * (smooth.data[i + 1] - src[i + 1])
        out[i + 2] = src[i + 2] + blend * (smooth.data[i + 2] - src[i + 2])
        out[i + 3] = src[i + 3]
      }
      return { data: out, width: image.width, height: image.height }
    },
    glsl: {
      // Single-pass radius-3 bilateral window (the twin trades the two-pass
      // separation for one fragment pass; CPU is the reference semantics).
      fragment: `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform float u_blend;                    // strength × cap, pre-clamped
uniform float u_sigma;
in vec2 v_uv;
out vec4 outColor;
float luma (vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float band (float x, float lo, float hi, float ramp) {
  return min(clamp((x - (lo - ramp)) / ramp, 0.0, 1.0), clamp(((hi + ramp) - x) / ramp, 0.0, 1.0));
}
void main () {
  vec2 texel = 1.0 / vec2(textureSize(u_frame, 0));
  vec4 center = texture(u_frame, v_uv);
  float y601 = dot(center.rgb * 255.0, vec3(0.299, 0.587, 0.114));
  float cb = 128.0 + dot(center.rgb * 255.0, vec3(-0.168736, -0.331264, 0.5));
  float cr = 128.0 + dot(center.rgb * 255.0, vec3(0.5, -0.418688, -0.081312));
  float skin = band(cb, 77.0, 127.0, 8.0) * band(cr, 133.0, 173.0, 8.0)
             * clamp((y601 - 40.0) / 24.0, 0.0, 1.0);
  float cl = luma(center.rgb);
  float inv2s2 = 1.0 / (2.0 * u_sigma * u_sigma);
  vec3 sum = vec3(0.0);
  float wSum = 0.0;
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) {
      vec3 c = texture(u_frame, v_uv + vec2(float(dx), float(dy)) * texel).rgb;
      float d = luma(c) - cl;
      float w = exp(-(d * d) * inv2s2);
      sum += w * c;
      wSum += w;
    }
  }
  outColor = vec4(mix(center.rgb, sum / wSum, u_blend * skin), center.a);
}`,
      uniforms: (params) => ({
        u_blend: clamp01(params.strength) * BEAUTY_LIMITS.SKIN_SMOOTH_MAX_BLEND,
        u_sigma: BEAUTY_LIMITS.SKIN_SMOOTH_RANGE_SIGMA,
      }),
    },
  }
}

/** The 256-entry tone curve for a given tone value (shared CPU/tests).
 *  tone > 0 blends toward an S-curve (more contrast); tone < 0 blends
 *  toward mid-grey (less), both capped by TONE_MAX_BLEND. */
export function toneCurve (tone) {
  const t = Math.max(-1, Math.min(1, tone))
  const blend = Math.abs(t) * BEAUTY_LIMITS.TONE_MAX_BLEND
  const curve = new Uint8Array(256)
  for (let v = 0; v < 256; v++) {
    const u = v / 255
    const target = t >= 0 ? 255 * u * u * (3 - 2 * u) : 128
    curve[v] = Math.round(v + blend * (target - v))
  }
  return curve
}

/**
 * Stage 2 — tone + warmth. `tone` −1..1 (contrast S-curve vs flatten),
 * `warmth` −1..1 (R up / B down, or the reverse), both capped.
 */
export function toneWarmthStage (tone = 0, warmth = 0) {
  return {
    name: 'beauty-tone-warmth',
    params: { tone, warmth },
    cpu (image, params) {
      const w = Math.max(-1, Math.min(1, params.warmth)) * BEAUTY_LIMITS.WARMTH_MAX_SHIFT
      const curve = toneCurve(params.tone)
      const out = new Uint8ClampedArray(image.data.length)
      const src = image.data
      for (let i = 0; i < src.length; i += 4) {
        out[i] = clamp255(curve[src[i]] + w)
        out[i + 1] = curve[src[i + 1]]
        out[i + 2] = clamp255(curve[src[i + 2]] - w)
        out[i + 3] = src[i + 3]
      }
      return { data: out, width: image.width, height: image.height }
    },
    glsl: {
      fragment: `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform float u_toneBlend;                // signed: >0 S-curve, <0 flatten
uniform float u_warmth;                   // pre-capped, in 0..1 units
in vec2 v_uv;
out vec4 outColor;
void main () {
  vec4 c = texture(u_frame, v_uv);
  vec3 sc = c.rgb * c.rgb * (3.0 - 2.0 * c.rgb);
  vec3 target = u_toneBlend >= 0.0 ? sc : vec3(0.5019608);
  vec3 toned = mix(c.rgb, target, abs(u_toneBlend));
  toned.r = clamp(toned.r + u_warmth, 0.0, 1.0);
  toned.b = clamp(toned.b - u_warmth, 0.0, 1.0);
  outColor = vec4(toned, c.a);
}`,
      uniforms: (params) => {
        const t = Math.max(-1, Math.min(1, params.tone))
        return {
          u_toneBlend: t * BEAUTY_LIMITS.TONE_MAX_BLEND,
          u_warmth: (Math.max(-1, Math.min(1, params.warmth)) * BEAUTY_LIMITS.WARMTH_MAX_SHIFT) / 255,
        }
      },
    },
  }
}

/**
 * Stage 3 — brighten: per-pixel headroom lift, out = v + s·cap·(255 − v).
 * Monotone, algebraically clip-free (out ≤ 255 for every s ≤ 1), shadows
 * lift most, highlights are untouched.
 */
export function brightenStage (strength = 0) {
  return {
    name: 'beauty-brighten',
    params: { strength },
    cpu (image, params) {
      const lift = clamp01(params.strength) * BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT
      const out = new Uint8ClampedArray(image.data.length)
      const src = image.data
      for (let i = 0; i < src.length; i += 4) {
        out[i] = src[i] + lift * (255 - src[i])
        out[i + 1] = src[i + 1] + lift * (255 - src[i + 1])
        out[i + 2] = src[i + 2] + lift * (255 - src[i + 2])
        out[i + 3] = src[i + 3]
      }
      return { data: out, width: image.width, height: image.height }
    },
    glsl: {
      fragment: `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform float u_lift;
in vec2 v_uv;
out vec4 outColor;
void main () {
  vec4 c = texture(u_frame, v_uv);
  outColor = vec4(c.rgb + u_lift * (1.0 - c.rgb), c.a);
}`,
      uniforms: (params) => ({ u_lift: clamp01(params.strength) * BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT }),
    },
  }
}

/** The tier-0 chain in canonical order — what the wiring PR adds to a
 *  pipeline. Per-stage cost comes back from pipeline.apply's stageCosts. */
export function beautyTier0Stages ({ smooth = 0.5, tone = 0, warmth = 0, brighten = 0 } = {}) {
  return [skinSmoothStage(smooth), toneWarmthStage(tone, warmth), brightenStage(brighten)]
}
