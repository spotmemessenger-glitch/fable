/**
 * Spot Me — Creative Studio looks: procedural 3D LUTs.
 *
 * A look is a NAMED, PARAMETERIZED color pipeline — filmic tone curve, white
 * balance bias, saturation, split-toning, optional mono mix — baked into a
 * 3D LUT once and applied per pixel by trilinear interpolation. Procedural
 * generation (not shipped LUT binaries) keeps the bundle at a few hundred
 * bytes of parameters, makes every look exactly reproducible from a draft,
 * and lets strength blend in the op rather than in N pre-baked variants.
 *
 * HONEST NAMING. These are looks: deterministic color mathematics. They are
 * not, and are never presented as, "AI filters" or style transfer — neural
 * style transfer is a separate DARK cloud leg behind STUDIO_CLOUD_AI_ENABLED
 * (studio-cloud.js) with its own owner gates. A user reading "Golden Hour"
 * gets tone math, and the docs say so (docs/ai-camera/studio.md).
 *
 * LUT layout: size N per axis, entries Float32Array(N³·3), index
 * ((b·N + g)·N + r)·3 — r fastest, the .cube convention.
 */

import { registerOp } from './evaluator.js'
import { clamp01, luma, kTemperature, kSaturation } from './kernels.js'
import { num } from './ops-color.js'

export const LUT_SIZE = 17

/* ------------------------------------------------------ the color pipeline */

/**
 * Filmic-ish S-curve on one channel: contrast about 0.435 pivot in a
 * smoothstep-blended lift/gain shape, then black fade. Simple, monotone,
 * and tuned by ear against the reference looks below.
 */
function tone (x, { contrast = 0, gamma = 1, fade = 0 }) {
  let v = clamp01(x)
  if (gamma !== 1) v = Math.pow(v, gamma)
  if (contrast !== 0) {
    const t = v * v * (3 - 2 * v)                 // smoothstep(0,1,v)
    v = clamp01(v + (t - v) * contrast)
  }
  if (fade > 0) v = fade * 0.18 + v * (1 - fade * 0.18)   // lifted, milky blacks
  return v
}

/** Split-tone: tint shadows and highlights toward two colors, luma-weighted. */
function splitTone (r, g, b, { shadow, highlight, amount }) {
  if (!amount) return [r, g, b]
  const y = luma(r, g, b)
  const sw = (1 - y) * (1 - y) * amount
  const hw = y * y * amount
  return [
    clamp01(r + shadow[0] * sw + highlight[0] * hw),
    clamp01(g + shadow[1] * sw + highlight[1] * hw),
    clamp01(b + shadow[2] * sw + highlight[2] * hw)
  ]
}

/** One look's full pipeline over a single rgb triple in [0,1]. */
export function lookPipeline (r, g, b, params) {
  let out = [r, g, b]
  if (params.mono) {
    const [wr, wg, wb] = params.mono.weights
    const y = clamp01(wr * out[0] + wg * out[1] + wb * out[2])
    out = [y, y, y]
  }
  if (params.wb) out = kTemperature(out[0], out[1], out[2], params.wb)
  if (params.sat !== undefined && params.sat !== 0 && !params.mono) {
    out = kSaturation(out[0], out[1], out[2], { amount: params.sat })
  }
  if (params.tone) out = out.map((v) => tone(v, params.tone))
  if (params.split) out = splitTone(out[0], out[1], out[2], params.split)
  return out
}

/* ---------------------------------------------------------- the starter set */

/**
 * Tastefully parameterized, deliberately restrained. Names are honest about
 * being color grades. Frozen: editing a look in place would silently change
 * every draft that references it — new taste means a NEW id, and the old one
 * stays (documented in adr/014d §evolution).
 */
export const LOOKS = Object.freeze({
  teal_glow: {
    name: 'Teal Glow',
    params: { tone: { contrast: 0.18, fade: 0.1 }, sat: 0.06, split: { shadow: [-0.02, 0.03, 0.05], highlight: [0.04, 0.02, -0.02], amount: 0.9 } }
  },
  golden_hour: {
    name: 'Golden Hour',
    params: { wb: { temp: 0.35, tint: 0.05 }, tone: { contrast: 0.12, gamma: 0.96 }, sat: 0.1, split: { shadow: [0.02, 0, -0.02], highlight: [0.06, 0.03, -0.01], amount: 0.8 } }
  },
  film_fade: {
    name: 'Film Fade',
    params: { tone: { contrast: 0.08, fade: 0.55 }, sat: -0.18, split: { shadow: [0.01, 0.01, 0.02], highlight: [0.02, 0.01, 0], amount: 0.5 } }
  },
  cool_morning: {
    name: 'Cool Morning',
    params: { wb: { temp: -0.28, tint: -0.04 }, tone: { contrast: 0.1, gamma: 1.02 }, sat: -0.05 }
  },
  verde_matte: {
    name: 'Verde Matte',
    params: { tone: { contrast: 0.14, fade: 0.4 }, sat: -0.1, split: { shadow: [0, 0.035, 0.01], highlight: [0.015, 0.02, 0], amount: 0.7 } }
  },
  punch: {
    name: 'Punch',
    params: { tone: { contrast: 0.32, gamma: 0.98 }, sat: 0.22 }
  },
  mono_classic: {
    name: 'Mono Classic',
    params: { mono: { weights: [0.25, 0.65, 0.1] }, tone: { contrast: 0.16, fade: 0.12 } }
  },
  mono_drama: {
    name: 'Mono Drama',
    params: { mono: { weights: [0.4, 0.45, 0.15] }, tone: { contrast: 0.42, gamma: 1.05 } }
  }
})

export const lookIds = () => Object.keys(LOOKS)

/* ------------------------------------------------------------ LUT machinery */

const lutCache = new Map()

/** Bake one look into a 3D LUT (cached — generation is deterministic). */
export function buildLookLUT (id, size = LUT_SIZE) {
  const key = `${id}@${size}`
  const hit = lutCache.get(key)
  if (hit) return hit
  const look = LOOKS[id]
  if (!look) throw new RangeError(`unknown look: ${id}`)
  const lut = generateLUT((r, g, b) => lookPipeline(r, g, b, look.params), size)
  lutCache.set(key, lut)
  return lut
}

/** Bake any rgb→rgb function into a lattice. */
export function generateLUT (fn, size = LUT_SIZE) {
  if (!Number.isInteger(size) || size < 2 || size > 65) throw new RangeError('bad LUT size')
  const data = new Float32Array(size * size * size * 3)
  const den = size - 1
  let i = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        const [or, og, ob] = fn(r / den, g / den, b / den)
        data[i++] = clamp01(or)
        data[i++] = clamp01(og)
        data[i++] = clamp01(ob)
      }
    }
  }
  return { size, data }
}

/**
 * Apply a 3D LUT to an image with trilinear interpolation, blended with the
 * original by `strength`. This is the generic engine — the `look` op below
 * and any future imported-LUT op both land here.
 */
export function applyLUT3D (img, lut, strength = 1) {
  const { size, data: t } = lut
  const den = size - 1
  const s = img.data
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(s.length) }
  const d = out.data
  const mix = clamp01(strength)
  for (let i = 0; i < s.length; i += 4) {
    const rf = (s[i] / 255) * den
    const gf = (s[i + 1] / 255) * den
    const bf = (s[i + 2] / 255) * den
    const r0 = Math.min(den - 1, Math.floor(rf))
    const g0 = Math.min(den - 1, Math.floor(gf))
    const b0 = Math.min(den - 1, Math.floor(bf))
    const dr = rf - r0
    const dg = gf - g0
    const db = bf - b0
    const base = ((b0 * size + g0) * size + r0) * 3
    const sr = 3                       // +1 in r
    const sg = size * 3                // +1 in g
    const sb = size * size * 3         // +1 in b
    for (let c = 0; c < 3; c++) {
      const c000 = t[base + c]
      const c100 = t[base + sr + c]
      const c010 = t[base + sg + c]
      const c110 = t[base + sg + sr + c]
      const c001 = t[base + sb + c]
      const c101 = t[base + sb + sr + c]
      const c011 = t[base + sb + sg + c]
      const c111 = t[base + sb + sg + sr + c]
      const c00 = c000 * (1 - dr) + c100 * dr
      const c10 = c010 * (1 - dr) + c110 * dr
      const c01 = c001 * (1 - dr) + c101 * dr
      const c11 = c011 * (1 - dr) + c111 * dr
      const c0 = c00 * (1 - dg) + c10 * dg
      const c1 = c01 * (1 - dg) + c11 * dg
      const v = (c0 * (1 - db) + c1 * db) * 255
      d[i + c] = s[i + c] * (1 - mix) + v * mix
    }
    d[i + 3] = s[i + 3]
  }
  return out
}

/* ------------------------------------------------------------------ the op */

registerOp({
  name: 'look',
  version: 1,
  validate: (p) => {
    if (typeof p.id !== 'string' || !LOOKS[p.id]) throw new RangeError(`look.id must be one of: ${lookIds().join(', ')}`)
    return { id: p.id, strength: num(p.strength, 'look.strength', 0, 1, 1) }
  },
  // CPU-only: the LUT would need a texture unit the minimal GL runtime does
  // not carry; per-op fallback keeps mixed chains previewing fine.
  cpu: (img, p) => applyLUT3D(img, buildLookLUT(p.id), p.strength)
})
