/**
 * Spot Me camera — electronic image stabilization, TIER_BASIC, real.
 *
 * THE MODEL. Hand shake between consecutive frames is translation (see
 * align.js). So per frame: estimate the shift against the PREVIOUS frame
 * (phase correlation), accumulate the camera's actual path, run an
 * exponential smoother over that path, and counter-shift each frame by
 * (smoothed − actual) — the display then travels the smooth path while
 * the camera travels the shaky one. The correction is CLAMPED to a crop
 * margin (the classic EIS zoom-in): margin pixels are reserved on every
 * edge, corrections beyond it are clipped rather than showing the void
 * past the sensor, and the output is the fixed centre crop — stable
 * geometry every frame.
 *
 * TIERS, honestly: TIER_BASIC (this — software, translation-only) ships;
 * TIER_ADVANCED (gyro-fused, rolling-shutter aware, sub-pixel warp) needs
 * IMU access the web does not grant capture-synchronized, so it reports
 * DEFERRED_NATIVE for the P10 Capacitor adapter, and nothing here
 * pretends otherwise.
 *
 * A LOW-CONFIDENCE estimate contributes ZERO delta (align.js's floor):
 * a stabilizer that trusts a hallucinated shift adds the very judder it
 * exists to remove.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { estimateShift, MIN_SHIFT_CONFIDENCE } from './align.js'
import { lumaPlane, shiftImage } from './imagemath.js'

export const EIS_TIER = Object.freeze({
  BASIC: 'TIER_BASIC',
  ADVANCED: 'TIER_ADVANCED',
})

export function stabilizationAvailability (tier = EIS_TIER.BASIC) {
  if (tier === EIS_TIER.BASIC) return available({ tier })
  if (tier === EIS_TIER.ADVANCED) {
    return unavailable(CAMERA_UNAVAILABLE.DEFERRED_NATIVE,
      'gyro-fused EIS needs capture-synchronized IMU — native adapter (P10)')
  }
  return unavailable(CAMERA_UNAVAILABLE.FAILED, `unknown tier: ${tier}`)
}

export const EIS_DEFAULTS = Object.freeze({
  smoothing: 0.85,                         // path low-pass factor
  cropMargin: 0.08,                        // fraction reserved per edge
  tileSize: 64,                            // correlation tile
})

/**
 * One stabilizer per video take. Feed it each frame's LUMA plane, get the
 * pixel correction to apply to that frame.
 */
export function createStabilizer ({
  smoothing = EIS_DEFAULTS.smoothing,
  cropMargin = EIS_DEFAULTS.cropMargin,
  tileSize = EIS_DEFAULTS.tileSize,
} = {}) {
  let previous = null
  let path = { x: 0, y: 0 }                // where the camera actually went
  let smooth = { x: 0, y: 0 }              // where the display should go
  let frames = 0
  let clampedCount = 0

  return {
    tier: EIS_TIER.BASIC,

    feed (luma) {
      frames++
      if (!previous) {
        previous = luma
        return { dx: 0, dy: 0, clamped: false, confidence: 1 }
      }
      const estimate = estimateShift(previous, luma, { size: tileSize })
      previous = luma
      const trusted = estimate.confidence >= MIN_SHIFT_CONFIDENCE
      path = { x: path.x + (trusted ? estimate.dx : 0), y: path.y + (trusted ? estimate.dy : 0) }
      smooth = {
        x: smoothing * smooth.x + (1 - smoothing) * path.x,
        y: smoothing * smooth.y + (1 - smoothing) * path.y,
      }
      const maxX = luma.width * cropMargin
      const maxY = luma.height * cropMargin
      const rawX = smooth.x - path.x
      const rawY = smooth.y - path.y
      const dx = Math.max(-maxX, Math.min(maxX, rawX))
      const dy = Math.max(-maxY, Math.min(maxY, rawY))
      const clamped = dx !== rawX || dy !== rawY
      if (clamped) clampedCount++
      return { dx, dy, clamped, confidence: estimate.confidence, raw: { dx: rawX, dy: rawY } }
    },

    reset () { previous = null; path = { x: 0, y: 0 }; smooth = { x: 0, y: 0 }; frames = 0; clampedCount = 0 },
    state: () => ({ frames, path: { ...path }, smooth: { ...smooth }, clampedCount, cropMargin }),
  }
}

/**
 * Apply a correction: shift, then take the fixed centre crop the margin
 * reserved. Output geometry is CONSTANT for a given input size — a video
 * whose frames change size is not a video.
 */
export function stabilizeFrame (image, correction, cropMargin = EIS_DEFAULTS.cropMargin) {
  const shifted = shiftImage(image, Math.round(correction.dx), Math.round(correction.dy))
  const mx = Math.round(image.width * cropMargin)
  const my = Math.round(image.height * cropMargin)
  const w = image.width - 2 * mx
  const h = image.height - 2 * my
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    const srcRow = ((y + my) * image.width + mx) * 4
    out.set(shifted.data.subarray(srcRow, srcRow + w * 4), y * w * 4)
  }
  return { data: out, width: w, height: h }
}

/**
 * The pipeline-stage form — the seam wiring uses to put EIS in the
 * preview chain. Stateful across frames BY DESIGN (a stabilizer is a
 * filter with memory); the stage contract's purity holds per input: the
 * incoming frame is never mutated.
 */
export function stabilizerStage (stabilizer, { cropMargin = EIS_DEFAULTS.cropMargin } = {}) {
  return {
    name: 'eis-basic',
    params: { cropMargin },
    cpu (image, params) {
      const correction = stabilizer.feed(lumaPlane(image))
      return stabilizeFrame(image, correction, params.cropMargin)
    },
  }
}
