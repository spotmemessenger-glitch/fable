/**
 * Spot Me — Creative Studio compositing: background replace, sky replace,
 * directional relight.
 *
 * What is REAL here and how, stated plainly:
 *   bg_replace  manual/RLE mask or chroma-key assist (masks.js) → soft alpha,
 *               edge feather (gaussian on the mask), green/blue spill
 *               suppression, over-composite onto an asset background scaled
 *               to cover. Classic keying math, no ML.
 *   sky_replace heuristic sky mask (or a user mask) + a PROCEDURAL gradient
 *               sky + optional foreground tint toward the new sky so the
 *               light direction reads as belonging. Fails honestly where the
 *               heuristic does (documented); the mask is user-correctable.
 *   relight     a 2D key light: radial falloff from a placed light with
 *               luma-aware headroom so highlights do not clip first. There
 *               is NO depth estimation — this is the honest 2D tier, and the
 *               depth tier is deferred until an owner-approved model exists.
 */

import { registerOp } from './evaluator.js'
import { decodeMaskRLE, chromaKeyMask, skyHeuristicMask } from './masks.js'
import { resampleMaskNearest } from './inpaint.js'
import { gaussianBlurPlane } from './ops-spatial.js'
import { clamp01, luma } from './kernels.js'
import { num } from './ops-color.js'
import { makeImage, isImage } from './image-io.js'

/* ------------------------------------------------------------- resampling */

/** Bilinear resize (up or down) — backgrounds are scaled to cover the frame. */
export function resizeBilinear (img, w, h) {
  if (!isImage(img)) throw new TypeError('resizeBilinear: not an image')
  const out = makeImage(w, h)
  const sx = img.width / w
  const sy = img.height / h
  for (let y = 0; y < h; y++) {
    const fy = Math.min(img.height - 1.001, Math.max(0, (y + 0.5) * sy - 0.5))
    const y0 = Math.floor(fy)
    const dy = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(img.width - 1.001, Math.max(0, (x + 0.5) * sx - 0.5))
      const x0 = Math.floor(fx)
      const dx = fx - x0
      const i00 = (y0 * img.width + x0) * 4
      const i01 = i00 + img.width * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        out.data[o + c] =
          (img.data[i00 + c] * (1 - dx) + img.data[i00 + 4 + c] * dx) * (1 - dy) +
          (img.data[i01 + c] * (1 - dx) + img.data[i01 + 4 + c] * dx) * dy + 0.5
      }
    }
  }
  return out
}

/** Scale-to-cover then center-crop to exactly w×h. */
export function coverResize (img, w, h) {
  const scale = Math.max(w / img.width, h / img.height)
  const rw = Math.max(w, Math.round(img.width * scale))
  const rh = Math.max(h, Math.round(img.height * scale))
  const scaled = resizeBilinear(img, rw, rh)
  if (rw === w && rh === h) return scaled
  const x0 = Math.floor((rw - w) / 2)
  const y0 = Math.floor((rh - h) / 2)
  const out = makeImage(w, h)
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * rw + x0) * 4
    out.data.set(scaled.data.subarray(src, src + w * 4), y * w * 4)
  }
  return out
}

/* --------------------------------------------------------------- feathering */

/** Soft alpha plane in [0,1] from a mask: optional gaussian feather. */
function alphaPlane (mask, w, h, featherPx) {
  const m = (mask.w === w && mask.h === h) ? mask : resampleMaskNearest(mask, w, h)
  const plane = new Float32Array(w * h)
  for (let i = 0; i < plane.length; i++) plane[i] = m.data[i] / 255
  return featherPx > 0 ? gaussianBlurPlane(plane, w, h, featherPx) : plane
}

/** Suppress key-color spill: pull the offending channel down to the max of
 *  the other two where it dominates, weighted by edge closeness. */
function suppressSpill (r, g, b, keyChannel, amount) {
  const other = keyChannel === 1 ? Math.max(r, b) : keyChannel === 2 ? Math.max(r, g) : Math.max(g, b)
  const v = keyChannel === 1 ? g : keyChannel === 2 ? b : r
  if (v <= other) return [r, g, b]
  const nv = v - (v - other) * amount
  if (keyChannel === 1) return [r, nv, b]
  if (keyChannel === 2) return [r, g, nv]
  return [nv, g, b]
}

/* -------------------------------------------------------------- bg_replace */

registerOp({
  name: 'bg_replace',
  version: 1,
  tileable: false,
  validate: (p) => {
    const hasMask = p.mask !== undefined
    const hasChroma = p.chroma !== undefined
    if (hasMask === hasChroma) throw new RangeError('bg_replace: exactly one of mask (foreground) or chroma required')
    const out = {
      feather: num(p.feather, 'bg_replace.feather', 0, 20, 2),
      bg: (() => {
        if (typeof p.bg !== 'string' || !p.bg) throw new TypeError('bg_replace.bg must be an asset id')
        return p.bg
      })()
    }
    if (hasMask) out.mask = (decodeMaskRLE(p.mask), p.mask)
    if (hasChroma) {
      const c = p.chroma
      if (!Array.isArray(c.color) || c.color.length !== 3) throw new TypeError('bg_replace.chroma.color must be [r,g,b]')
      out.chroma = {
        color: c.color.map((v) => Math.round(num(v, 'chroma.color', 0, 255))),
        tolerance: num(c.tolerance, 'chroma.tolerance', 0.01, 0.5, 0.12),
        softness: num(c.softness, 'chroma.softness', 0.01, 0.5, 0.08),
        spill: num(c.spill, 'chroma.spill', 0, 1, 0.7)
      }
    }
    return out
  },
  cpu: (img, p, ctx) => {
    const { width: w, height: h } = img
    const bgAsset = ctx?.assets?.get?.(p.bg)
    if (!isImage(bgAsset)) throw new Error(`bg_replace: asset ${p.bg} not provided to render()`)
    const bg = coverResize(bgAsset, w, h)

    let alpha        // foreground coverage in [0,1]
    let keyChannel = -1
    let spillAmount = 0
    if (p.mask) {
      alpha = alphaPlane(decodeMaskRLE(p.mask), w, h, p.feather)
    } else {
      const bgMask = chromaKeyMask(img, p.chroma)          // 255 where KEY color
      const plane = alphaPlane(bgMask, w, h, p.feather)
      alpha = new Float32Array(plane.length)
      for (let i = 0; i < plane.length; i++) alpha[i] = 1 - plane[i]
      const [kr, kg, kb] = p.chroma.color
      keyChannel = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0
      spillAmount = p.chroma.spill
    }

    const out = makeImage(w, h)
    for (let i = 0, j = 0; j < alpha.length; i += 4, j++) {
      const a = clamp01(alpha[j])
      let fr = img.data[i] / 255
      let fg = img.data[i + 1] / 255
      let fb = img.data[i + 2] / 255
      if (keyChannel >= 0 && a > 0.02 && a < 0.98) {
        // Spill lives on the mixed edge; interior foreground is left alone.
        ;[fr, fg, fb] = suppressSpill(fr, fg, fb, keyChannel, spillAmount)
      }
      out.data[i] = (fr * a + (bg.data[i] / 255) * (1 - a)) * 255 + 0.5
      out.data[i + 1] = (fg * a + (bg.data[i + 1] / 255) * (1 - a)) * 255 + 0.5
      out.data[i + 2] = (fb * a + (bg.data[i + 2] / 255) * (1 - a)) * 255 + 0.5
      out.data[i + 3] = 255
    }
    return out
  }
})

/* -------------------------------------------------------------- sky_replace */

/** Procedural sky presets: vertical gradient stops (top→horizon) + optional
 *  sun glow. Stops are [position 0..1, r, g, b] in bytes. */
export const SKY_PRESETS = Object.freeze({
  clear_noon: { stops: [[0, 43, 108, 197], [0.7, 122, 172, 226], [1, 205, 224, 239]] },
  sunset_glow: { stops: [[0, 66, 71, 143], [0.55, 214, 120, 87], [1, 250, 204, 129]], sun: { x: 0.5, y: 0.92, radius: 0.28, color: [255, 214, 140], strength: 0.75 } },
  dusk_violet: { stops: [[0, 34, 26, 77], [0.6, 96, 66, 128], [1, 182, 128, 148]] },
  overcast_soft: { stops: [[0, 168, 174, 182], [1, 214, 217, 221]] }
})

/** Render a preset sky plane of w×h. `horizon` = where gradient bottom sits. */
export function generateSky (preset, w, h, { horizon = 1 } = {}) {
  const def = SKY_PRESETS[preset]
  if (!def) throw new RangeError(`unknown sky preset: ${preset}`)
  const out = makeImage(w, h)
  const stops = def.stops
  for (let y = 0; y < h; y++) {
    const t = clamp01((y / Math.max(1, h * horizon)))
    let s0 = stops[0]
    let s1 = stops[stops.length - 1]
    for (let k = 0; k < stops.length - 1; k++) {
      if (t >= stops[k][0] && t <= stops[k + 1][0]) { s0 = stops[k]; s1 = stops[k + 1]; break }
    }
    const span = Math.max(1e-6, s1[0] - s0[0])
    const f = clamp01((t - s0[0]) / span)
    const r = s0[1] + (s1[1] - s0[1]) * f
    const g = s0[2] + (s1[2] - s0[2]) * f
    const b = s0[3] + (s1[3] - s0[3]) * f
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      let rr = r; let gg = g; let bb = b
      if (def.sun) {
        const dx = x / w - def.sun.x
        const dy = y / h - def.sun.y
        const d = Math.sqrt(dx * dx + dy * dy)
        const glow = Math.exp(-(d * d) / (2 * def.sun.radius * def.sun.radius)) * def.sun.strength
        rr += (def.sun.color[0] - rr) * glow
        gg += (def.sun.color[1] - gg) * glow
        bb += (def.sun.color[2] - bb) * glow
      }
      out.data[i] = rr + 0.5
      out.data[i + 1] = gg + 0.5
      out.data[i + 2] = bb + 0.5
      out.data[i + 3] = 255
    }
  }
  return out
}

registerOp({
  name: 'sky_replace',
  version: 1,
  tileable: false,
  validate: (p) => {
    if (typeof p.preset !== 'string' || !SKY_PRESETS[p.preset]) {
      throw new RangeError(`sky_replace.preset must be one of: ${Object.keys(SKY_PRESETS).join(', ')}`)
    }
    const out = {
      preset: p.preset,
      feather: num(p.feather, 'sky_replace.feather', 0, 20, 3),
      tintFg: num(p.tintFg, 'sky_replace.tintFg', 0, 1, 0.15),
      threshold: num(p.threshold, 'sky_replace.threshold', 0.2, 0.8, 0.45)
    }
    if (p.mask !== undefined) out.mask = (decodeMaskRLE(p.mask), p.mask)
    return out
  },
  cpu: (img, p) => {
    const { width: w, height: h } = img
    const mask = p.mask ? decodeMaskRLE(p.mask) : skyHeuristicMask(img, { threshold: p.threshold })
    const alpha = alphaPlane(mask, w, h, p.feather)          // 1 = sky
    const sky = generateSky(p.preset, w, h)

    // Average sky color drives the foreground tint (light "belongs").
    let ar = 0; let ag = 0; let ab = 0
    for (let i = 0; i < sky.data.length; i += 4) { ar += sky.data[i]; ag += sky.data[i + 1]; ab += sky.data[i + 2] }
    const n = sky.data.length / 4
    ar /= n * 255; ag /= n * 255; ab /= n * 255
    const tintLuma = luma(ar, ag, ab)

    const out = makeImage(w, h)
    for (let i = 0, j = 0; j < alpha.length; i += 4, j++) {
      const a = clamp01(alpha[j])
      let r = img.data[i] / 255
      let g = img.data[i + 1] / 255
      let b = img.data[i + 2] / 255
      if (p.tintFg > 0 && a < 0.5) {
        // Shift the foreground's cast toward the sky hue, luma preserved.
        const t = p.tintFg * (1 - a * 2)
        r = clamp01(r + (ar - tintLuma) * t)
        g = clamp01(g + (ag - tintLuma) * t)
        b = clamp01(b + (ab - tintLuma) * t)
      }
      out.data[i] = (r * (1 - a) + (sky.data[i] / 255) * a) * 255 + 0.5
      out.data[i + 1] = (g * (1 - a) + (sky.data[i + 1] / 255) * a) * 255 + 0.5
      out.data[i + 2] = (b * (1 - a) + (sky.data[i + 2] / 255) * a) * 255 + 0.5
      out.data[i + 3] = 255
    }
    return out
  }
})

/* ------------------------------------------------------------------ relight */

registerOp({
  name: 'relight',
  version: 1,
  tileable: false,
  validate: (p) => ({
    x: num(p.x, 'relight.x', 0, 1, 0.5),
    y: num(p.y, 'relight.y', 0, 1, 0.3),
    intensity: num(p.intensity, 'relight.intensity', -1, 1, 0.4),
    radius: num(p.radius, 'relight.radius', 0.1, 1.5, 0.6),
    warmth: num(p.warmth, 'relight.warmth', -1, 1, 0.15)
  }),
  cpu: (img, p) => {
    const { width: w, height: h, data: s } = img
    const out = makeImage(w, h)
    const sigma = p.radius * 0.5
    for (let y = 0; y < h; y++) {
      const vy = (y + 0.5) / h - p.y
      for (let x = 0; x < w; x++) {
        const vx = (x + 0.5) / w - p.x
        const d2 = vx * vx + vy * vy
        const fall = Math.exp(-d2 / (2 * sigma * sigma))
        const i = (y * w + x) * 4
        const r = s[i] / 255
        const g = s[i + 1] / 255
        const b = s[i + 2] / 255
        const yl = luma(r, g, b)
        // Headroom-aware gain: brightening fades as luma approaches 1 so the
        // key light cannot clip, and negative intensity dims with shadow
        // headroom symmetric.
        const head = p.intensity >= 0 ? 1 - yl : yl
        const gain = p.intensity * fall * head
        const warmR = 1 + p.warmth * 0.25 * fall
        const warmB = 1 - p.warmth * 0.25 * fall
        out.data[i] = clamp01(r * warmR + gain) * 255 + 0.5
        out.data[i + 1] = clamp01(g + gain) * 255 + 0.5
        out.data[i + 2] = clamp01(b * warmB + gain) * 255 + 0.5
        out.data[i + 3] = s[i + 3]
      }
    }
    return out
  }
})
