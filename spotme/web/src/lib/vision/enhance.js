/**
 * Spot Me vision — the "scan look": turning a rectified photo of a page
 * into something that reads like a scanner produced it.
 *
 * Two real modes, both pure math:
 *
 *   'bw'     adaptive (locally-referenced) threshold. A global threshold
 *            cannot survive the illumination gradient every hand-held
 *            photo has — half the page ends up black. Comparing each
 *            pixel against its own neighbourhood mean (integral-image,
 *            O(1) per pixel) survives it by construction.
 *   'color'  illumination flattening: estimate the page background as the
 *            LOCAL BRIGHT level (windowed mean pushed toward white),
 *            divide it out per channel, so shadows lift and paper goes
 *            paper-white while ink and stamps keep their colour.
 *
 * 'original' passes through untouched — a mode, not a default fallback,
 * so the caller always states what it wants.
 */

import { lumaPlane } from '../camera/imagemath.js'
import { integralPlane, localMean, channelPlane } from './imageops.js'
import { VISION_UNAVAILABLE, available, unavailable } from './availability.js'

export const ENHANCE_MODES = Object.freeze(['original', 'color', 'bw'])

export const ENHANCE_DEFAULTS = Object.freeze({
  /** B/W: window radius as a fraction of the short side; floor 8 px. */
  bwWindowFraction: 1 / 16,
  /** B/W: a pixel must undercut its local mean by this (0..1) to be ink.
   *  Measured on the synthetic corpus: 0.06 keeps 10%-contrast text while
   *  refusing to hallucinate ink out of sensor noise. */
  bwBias: 0.06,
  /** Color: window radius fraction for the background estimate. Wider than
   *  the B/W window — the background varies slower than glyphs. */
  colorWindowFraction: 1 / 8,
  /** Color: fraction of headroom the flattened page is stretched into. */
  whitePoint: 0.94,
})

/**
 * Adaptive threshold → black-ink-on-white RGBA. Pixels darker than
 * (local mean − bias) become ink; everything else becomes paper.
 */
export function adaptiveThreshold (image, opts = {}) {
  const o = { ...ENHANCE_DEFAULTS, ...opts }
  const luma = lumaPlane(image)
  const { width, height } = luma
  const integral = integralPlane(luma)
  const r = Math.max(8, Math.round(Math.min(width, height) * o.bwWindowFraction))
  const out = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const ink = luma.data[i] < localMean(integral, width, height, x, y, r) - o.bwBias
      const v = ink ? 0 : 255
      const q = i * 4
      out[q] = v; out[q + 1] = v; out[q + 2] = v; out[q + 3] = 255
    }
  }
  return { data: out, width, height }
}

/**
 * Illumination-flattening colour enhancement. Per channel: background =
 * max(local mean, channel value) smoothed by the window — dividing by it
 * maps paper to ~1.0 wherever the light was, then the whitePoint stretch
 * snaps it to white while ink (far below background) keeps its ratio.
 */
export function scanColor (image, opts = {}) {
  const o = { ...ENHANCE_DEFAULTS, ...opts }
  const { width, height } = image
  const r = Math.max(8, Math.round(Math.min(width, height) * o.colorWindowFraction))
  const out = new Uint8ClampedArray(width * height * 4)
  for (let ch = 0; ch < 3; ch++) {
    const plane = channelPlane(image, ch)
    const integral = integralPlane(plane)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        // The bright level around this pixel: mean pushed up toward the
        // brighter of (mean, pixel) so ink cannot drag its own background.
        const mean = localMean(integral, width, height, x, y, r)
        const bg = Math.max(mean, plane.data[i], 1e-4)
        const flattened = plane.data[i] / (bg / o.whitePoint)
        out[i * 4 + ch] = Math.round(Math.min(1, flattened) * 255)
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) out[i] = 255
  return { data: out, width, height }
}

/** The mode switch every page runs through. Unknown mode is BAD_INPUT —
 *  a typo'd mode must fail tests, not silently pass 'original' through. */
export function enhancePage (image, mode = 'color', opts = {}) {
  if (!ENHANCE_MODES.includes(mode)) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, `unknown enhance mode '${mode}' (have: ${ENHANCE_MODES.join(', ')})`)
  }
  if (!image?.data || !image.width || !image.height) {
    return unavailable(VISION_UNAVAILABLE.BAD_INPUT, 'image must be {data,width,height}')
  }
  if (mode === 'original') {
    return available({ image: { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height }, mode })
  }
  if (mode === 'bw') return available({ image: adaptiveThreshold(image, opts), mode })
  return available({ image: scanColor(image, opts), mode })
}
