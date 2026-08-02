/**
 * Spot Me camera — HDR: exposure-bracketed capture + Mertens-style fusion.
 *
 * TWO HALVES, SPLIT ON PURPOSE. `captureBracket` is the hardware half: it
 * exists only where the track exposes a REAL exposureCompensation range
 * (Android Chrome on capable devices) and reports NO_EXPOSURE_CONTROL
 * everywhere else — fusing three identical exposures is a fake HDR this
 * engine refuses to ship. `fuseExposures` is the math half: pure, runs on
 * ImageData-shaped frames anywhere including Node, which is where its
 * golden vectors are pinned.
 *
 * FUSION. Mertens/Kautz/Van Reeth exposure fusion — no radiance recovery,
 * no tone mapping pass, no camera response calibration; per-pixel weights
 * from three measures:
 *     contrast          |4-neighbour Laplacian| of luma
 *     saturation        stddev of (R,G,B)
 *     well-exposedness  Gaussian of each channel around 0.5, multiplied
 * normalized across the bracket, SMOOTHED, then a weighted per-pixel blend.
 *
 * SINGLE-SCALE, DOCUMENTED TRADE-OFF: full Mertens blends per level of a
 * Laplacian pyramid, which hides seams where weight maps step sharply. At
 * preview/bracket resolutions with heavily blurred weight maps (radius 8
 * default = the pyramid's coarse levels, approximately) the residual is
 * mild halos at high-contrast silhouettes — accepted for v1, measured in
 * the bench, and the pyramid upgrade is a contained TODO-free follow-up
 * inside this one function's contract (same signature, better blender).
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { boxBlurPlane } from './imagemath.js'

export const DEFAULT_EVS = [-2, 0, 2]

/**
 * Capture an exposure bracket through a session + frame source.
 * Sequential by construction: EV set → settle → capture, restoring the
 * starting EV afterwards even on failure. Returns the frames with the EV
 * that was ACTUALLY applied (clamped to the device range) and the still
 * path used, so the caller knows exactly what physics happened.
 */
export async function captureBracket (session, frameSource, {
  evs = DEFAULT_EVS, settleMs = 120, clock = null,
} = {}) {
  const clk = clock || session.clock
  const caps = session.capabilities()
  const evCap = caps.exposureCompensation
  if (!evCap?.available) {
    return unavailable(CAMERA_UNAVAILABLE.NO_EXPOSURE_CONTROL,
      'exposureCompensation not in this track\'s capabilities — bracketing would fuse identical exposures')
  }
  const startingEv = session.settings()?.exposureCompensation ?? 0
  const frames = []
  try {
    for (const requested of evs) {
      const ev = Math.max(evCap.min, Math.min(evCap.max, requested))
      const applied = await session.pro.setExposureCompensation(ev)
      if (!applied.available) return applied
      if (settleMs > 0) await new Promise((resolve) => clk.setTimeout(resolve, settleMs))
      const shot = await frameSource.captureStill()
      if (!shot.available) return shot
      frames.push({ ...shot, ev, evRequested: requested, clamped: ev !== requested })
    }
  } finally {
    // The user's exposure must not be left wherever the bracket died.
    await session.pro.setExposureCompensation(startingEv).catch?.(() => {})
  }
  return available({ frames, evs: frames.map((f) => f.ev) })
}

/* ------------------------------------------------------------- fusion ----- */

function luma01 (data, i) {
  return (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255
}

/**
 * Floor under the contrast and saturation measures. WHY IT EXISTS: the
 * regions a bracket most needs to arbitrate — clipped shadows and blown
 * highlights — are locally FLAT, so contrast≈0 and (for grey content)
 * saturation≈0, and the raw Mertens product would zero every frame's
 * weight there, leaving the blend to numerical dust instead of the one
 * measure that still speaks: well-exposedness. Flooring the two dead
 * measures preserves their ratios where they are alive and hands flat
 * regions to exposedness, which is the physically right arbiter there.
 */
export const MEASURE_FLOOR = 0.01

/** The three Mertens measures for one image → a Float32 weight plane. */
export function weightPlane (image, { wContrast = 1, wSaturation = 1, wExposedness = 1, sigma = 0.2 } = {}) {
  const { data, width, height } = image
  const weights = new Float32Array(width * height)
  const luma = new Float32Array(width * height)
  for (let p = 0, i = 0; p < luma.length; p++, i += 4) luma[p] = luma01(data, i)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      const i = p * 4
      // Contrast: |Laplacian| of luma, edge-clamped neighbours.
      const left = luma[y * width + Math.max(0, x - 1)]
      const right = luma[y * width + Math.min(width - 1, x + 1)]
      const up = luma[Math.max(0, y - 1) * width + x]
      const down = luma[Math.min(height - 1, y + 1) * width + x]
      const contrast = Math.abs(left + right + up + down - 4 * luma[p])
      // Saturation: stddev of the three channels.
      const r = data[i] / 255; const g = data[i + 1] / 255; const b = data[i + 2] / 255
      const mean = (r + g + b) / 3
      const saturation = Math.sqrt(((r - mean) ** 2 + (g - mean) ** 2 + (b - mean) ** 2) / 3)
      // Well-exposedness: product of per-channel Gaussians around 0.5.
      const gauss = (v) => Math.exp(-((v - 0.5) ** 2) / (2 * sigma * sigma))
      const exposedness = gauss(r) * gauss(g) * gauss(b)
      weights[p] = Math.pow(Math.max(contrast, MEASURE_FLOOR), wContrast) *
        Math.pow(Math.max(saturation, MEASURE_FLOOR), wSaturation) *
        Math.pow(exposedness, wExposedness) + 1e-12
    }
  }
  return { data: weights, width, height }
}

/**
 * Fuse an exposure bracket. Pure math: same-geometry RGBA frames in, one
 * RGBA frame out. Weight maps are blurred (see header) before the
 * normalized per-pixel blend.
 */
export function fuseExposures (images, opts = {}) {
  if (!Array.isArray(images) || images.length === 0) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, 'fuseExposures needs at least one frame')
  }
  const { width, height } = images[0]
  if (!images.every((f) => f.width === width && f.height === height)) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, 'bracket frames differ in geometry')
  }
  if (images.length === 1) {
    return available({ image: { data: new Uint8ClampedArray(images[0].data), width, height }, frames: 1 })
  }
  const blurRadius = opts.blurRadius ?? 8
  const weights = images.map((image) => boxBlurPlane(weightPlane(image, opts), blurRadius))

  const out = new Uint8ClampedArray(width * height * 4)
  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    let total = 0
    for (const w of weights) total += w.data[p]
    let r = 0; let g = 0; let b = 0; let a = 0
    for (let k = 0; k < images.length; k++) {
      const w = weights[k].data[p] / total
      const d = images[k].data
      r += w * d[i]; g += w * d[i + 1]; b += w * d[i + 2]; a += w * d[i + 3]
    }
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a
  }
  return available({ image: { data: out, width, height }, frames: images.length })
}
