/**
 * Spot Me — Creative Studio spatial ops: vignette, sharpen (unsharp mask),
 * clarity (local contrast), grain.
 *
 * These read neighborhoods or frame position, so their tiling story is
 * explicit: sharpen/clarity declare `pad` (the blur support) and tile
 * cleanly; vignette and grain depend on absolute frame coordinates and are
 * marked untileable — the evaluator runs them whole-image, which is fine
 * because both are O(n) single passes.
 *
 * GPU story, honestly: vignette has a GLSL twin (pure per-pixel in frame
 * coords). Sharpen and clarity are separable two-pass blurs; the one-pass-
 * per-op GL runtime would need multi-pass plumbing to do them right, so they
 * are CPU-only rather than shipped as a worse single-pass approximation that
 * would make preview and export disagree. Grain must be byte-identical from a
 * draft (seeded PRNG), which GPU float hashing cannot promise — CPU-only.
 */

import { registerOp } from './evaluator.js'
import { kVignetteFactor, mulberry32, LUMA_R, LUMA_G, LUMA_B } from './kernels.js'
import { num } from './ops-color.js'

/* --------------------------------------------------------- gaussian blur */

/** 1-D gaussian taps for sigma, radius = ceil(3σ), normalized. */
export function gaussianTaps (sigma) {
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const taps = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma))
    taps[i + radius] = w
    sum += w
  }
  for (let i = 0; i < taps.length; i++) taps[i] /= sum
  return { taps, radius }
}

/**
 * Separable gaussian over an RGBA image → Float32Array of blurred RGB
 * (alpha untouched by callers). Edge handling: clamp-to-edge, matching the
 * GL runtime's CLAMP_TO_EDGE so a future GPU twin cannot disagree at borders.
 */
export function gaussianBlurRGB (img, sigma) {
  const { taps, radius } = gaussianTaps(sigma)
  const { width: w, height: h, data: s } = img
  const tmp = new Float32Array(w * h * 3)
  const out = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0
      for (let t = -radius; t <= radius; t++) {
        const xx = Math.min(w - 1, Math.max(0, x + t))
        const i = (y * w + xx) * 4
        const wt = taps[t + radius]
        r += s[i] * wt; g += s[i + 1] * wt; b += s[i + 2] * wt
      }
      const o = (y * w + x) * 3
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0; let g = 0; let b = 0
      for (let t = -radius; t <= radius; t++) {
        const yy = Math.min(h - 1, Math.max(0, y + t))
        const i = (yy * w + x) * 3
        const wt = taps[t + radius]
        r += tmp[i] * wt; g += tmp[i + 1] * wt; b += tmp[i + 2] * wt
      }
      const o = (y * w + x) * 3
      out[o] = r; out[o + 1] = g; out[o + 2] = b
    }
  }
  return out
}

/** Same, over a single-channel Float32Array (masks, luma planes). */
export function gaussianBlurPlane (plane, w, h, sigma) {
  const { taps, radius } = gaussianTaps(sigma)
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let t = -radius; t <= radius; t++) {
        v += plane[y * w + Math.min(w - 1, Math.max(0, x + t))] * taps[t + radius]
      }
      tmp[y * w + x] = v
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0
      for (let t = -radius; t <= radius; t++) {
        v += tmp[Math.min(h - 1, Math.max(0, y + t)) * w + x] * taps[t + radius]
      }
      out[y * w + x] = v
    }
  }
  return out
}

/* ---------------------------------------------------------------- vignette */

registerOp({
  name: 'vignette',
  version: 1,
  tileable: false,                       // needs full-frame coordinates
  validate: (p) => ({
    amount: num(p.amount, 'vignette.amount', -1, 1),
    radius: num(p.radius, 'vignette.radius', 0, 1, 0.6),
    softness: num(p.softness, 'vignette.softness', 0.05, 1, 0.35)
  }),
  cpu: (img, p) => {
    const { width: w, height: h, data: s } = img
    const out = { width: w, height: h, data: new Uint8ClampedArray(s.length) }
    const d = out.data
    for (let y = 0; y < h; y++) {
      const v = (y + 0.5) / h
      for (let x = 0; x < w; x++) {
        const f = kVignetteFactor((x + 0.5) / w, v, p)
        const i = (y * w + x) * 4
        d[i] = s[i] * f
        d[i + 1] = s[i + 1] * f
        d[i + 2] = s[i + 2] * f
        d[i + 3] = s[i + 3]
      }
    }
    return out
  },
  glsl: {
    frag: `uniform float u_amount;
uniform float u_radius;
uniform float u_soft;
void main () {
  vec4 c = texture(u_src, v_uv);
  vec2 p = (v_uv - 0.5) * 2.0;
  float d = length(p) / sqrt(2.0);
  float w = smoothstep(u_radius, min(1.0001, u_radius + u_soft), d);
  float f = 1.0 - u_amount * w;
  outColor = vec4(clamp(c.rgb * f, 0.0, 1.0), c.a);
}`,
    uniforms: (p) => ({ u_amount: p.amount, u_radius: p.radius, u_soft: p.softness })
  }
})

/* ----------------------------------------------------------------- sharpen */

/** Unsharp mask: out = in + amount · (in − blur(in, radius)). */
registerOp({
  name: 'sharpen',
  version: 1,
  pad: (p, ctx) => Math.ceil(p.radius * (ctx?.scale || 1)) * 3 + 1,
  validate: (p) => ({
    amount: num(p.amount, 'sharpen.amount', 0, 3),
    radius: num(p.radius, 'sharpen.radius', 0.5, 8, 1.5)   // sigma, source px
  }),
  cpu: (img, p, ctx) => {
    const sigma = Math.max(0.3, p.radius * (ctx?.scale || 1))
    const blur = gaussianBlurRGB(img, sigma)
    const { width: w, height: h, data: s } = img
    const out = { width: w, height: h, data: new Uint8ClampedArray(s.length) }
    const d = out.data
    for (let i = 0, j = 0; i < s.length; i += 4, j += 3) {
      d[i] = s[i] + p.amount * (s[i] - blur[j])
      d[i + 1] = s[i + 1] + p.amount * (s[i + 1] - blur[j + 1])
      d[i + 2] = s[i + 2] + p.amount * (s[i + 2] - blur[j + 2])
      d[i + 3] = s[i + 3]
    }
    return out
  }
})

/* ----------------------------------------------------------------- clarity */

/**
 * Local contrast: unsharp on the LUMA plane at a large radius, weighted
 * toward midtones (w = 4·y·(1−y)) so it adds punch without crushing blacks
 * or blowing skies, applied as a per-pixel luma gain to preserve color.
 */
registerOp({
  name: 'clarity',
  version: 1,
  pad: (p, ctx) => Math.ceil(p.radius * (ctx?.scale || 1)) * 3 + 1,
  validate: (p) => ({
    amount: num(p.amount, 'clarity.amount', -1, 1),
    radius: num(p.radius, 'clarity.radius', 4, 64, 16)      // sigma, source px
  }),
  cpu: (img, p, ctx) => {
    const { width: w, height: h, data: s } = img
    const sigma = Math.max(1, p.radius * (ctx?.scale || 1))
    const plane = new Float32Array(w * h)
    for (let i = 0, j = 0; j < plane.length; i += 4, j++) {
      plane[j] = (LUMA_R * s[i] + LUMA_G * s[i + 1] + LUMA_B * s[i + 2]) / 255
    }
    const blurred = gaussianBlurPlane(plane, w, h, sigma)
    const out = { width: w, height: h, data: new Uint8ClampedArray(s.length) }
    const d = out.data
    for (let i = 0, j = 0; j < plane.length; i += 4, j++) {
      const y = plane[j]
      const mid = 4 * y * (1 - y)
      const boost = p.amount * mid * (y - blurred[j])
      const gain = y > 1e-5 ? (y + boost) / y : 1
      d[i] = s[i] * gain
      d[i + 1] = s[i + 1] * gain
      d[i + 2] = s[i + 2] * gain
      d[i + 3] = s[i + 3]
    }
    return out
  }
})

/* ------------------------------------------------------------------- grain */

/**
 * Film grain: seeded value noise at 1/size resolution, bilinearly upsampled,
 * luma-modulated (strongest in midtones, like film), added symmetrically.
 * Deterministic for a given {seed, size, amount} and image dimensions — a
 * draft re-renders byte-identically.
 */
registerOp({
  name: 'grain',
  version: 1,
  tileable: false,                        // noise lattice is frame-absolute
  validate: (p) => ({
    amount: num(p.amount, 'grain.amount', 0, 1),
    size: num(p.size, 'grain.size', 1, 8, 2),
    seed: (() => {
      const s = p.seed === undefined ? 1 : p.seed
      if (!Number.isInteger(s) || s < 0 || s > 0xffffffff) throw new RangeError('grain.seed must be a uint32')
      return s
    })()
  }),
  cpu: (img, p) => {
    const { width: w, height: h, data: s } = img
    const cell = Math.max(1, Math.round(p.size))
    const gw = Math.ceil(w / cell) + 1
    const gh = Math.ceil(h / cell) + 1
    const rand = mulberry32(p.seed)
    const lattice = new Float32Array(gw * gh)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rand() * 2 - 1
    const out = { width: w, height: h, data: new Uint8ClampedArray(s.length) }
    const d = out.data
    const strength = p.amount * 32
    for (let y = 0; y < h; y++) {
      const gy = y / cell
      const y0 = Math.floor(gy)
      const fy = gy - y0
      for (let x = 0; x < w; x++) {
        const gx = x / cell
        const x0 = Math.floor(gx)
        const fx = gx - x0
        const i00 = y0 * gw + x0
        const n = (lattice[i00] * (1 - fx) + lattice[i00 + 1] * fx) * (1 - fy) +
          (lattice[i00 + gw] * (1 - fx) + lattice[i00 + gw + 1] * fx) * fy
        const i = (y * w + x) * 4
        const yl = (LUMA_R * s[i] + LUMA_G * s[i + 1] + LUMA_B * s[i + 2]) / 255
        const g = n * strength * (0.25 + 0.75 * 4 * yl * (1 - yl))
        d[i] = s[i] + g
        d[i + 1] = s[i + 1] + g
        d[i + 2] = s[i + 2] + g
        d[i + 3] = s[i + 3]
      }
    }
    return out
  }
})
