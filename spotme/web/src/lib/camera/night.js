/**
 * Spot Me camera — night mode: N-frame stacking with global alignment and
 * motion rejection.
 *
 * WHAT IT REALLY IS. Averaging N aligned frames cuts zero-mean sensor
 * noise by √N — that is the entire physics, and it is enough to be a real
 * night mode at N=8. What it is NOT: exposure control (that is HDR's
 * hardware half), multi-scale denoising, or ML. Where the platform allows
 * a longer exposureTime the pro controls set it BEFORE stacking; stacking
 * itself needs nothing but frames, which is why night mode is available on
 * every platform including iOS.
 *
 * ALIGNMENT: each frame is phase-correlated (align.js) against the first
 * frame's luma and integer-shifted back. A low-confidence estimate is
 * treated as zero shift — applying a hallucinated shift smears worse than
 * skipping one.
 *
 * MOTION REJECTION: after alignment, a pixel whose luma strays more than
 * `motionThreshold` from the reference is EXCLUDED from that frame's
 * contribution — a walking person becomes the reference's person, not a
 * ghost trail. The rejected fraction is reported; a caller seeing 40%
 * rejection knows the scene was moving, not dark.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { estimateShift, MIN_SHIFT_CONFIDENCE } from './align.js'
import { lumaPlane, shiftImage } from './imagemath.js'

export const NIGHT_DEFAULTS = Object.freeze({
  frames: 8,
  mode: 'mean',                            // 'mean' | 'median'
  motionThreshold: 0.12,                   // luma 0..1
  maxShiftFraction: 0.15,                  // beyond this: frame dropped whole
})

/**
 * Stack same-geometry RGBA frames. Pure math — capture is the engine's
 * job, this is the algorithm, golden-tested in Node.
 *
 * @returns {image, shifts, framesUsed, framesDropped, rejectedFraction}
 */
export function stackFrames (frames, opts = {}) {
  const { mode, motionThreshold, maxShiftFraction } = { ...NIGHT_DEFAULTS, ...opts }
  if (!Array.isArray(frames) || frames.length === 0) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, 'stackFrames needs at least one frame')
  }
  const { width, height } = frames[0]
  if (!frames.every((f) => f.width === width && f.height === height)) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, 'stack frames differ in geometry')
  }
  const reference = frames[0]
  const refLuma = lumaPlane(reference)
  const aligned = [reference]
  const shifts = [{ dx: 0, dy: 0, confidence: 1 }]
  let dropped = 0

  for (let k = 1; k < frames.length; k++) {
    const estimate = estimateShift(refLuma, lumaPlane(frames[k]), { size: pickTile(width, height) })
    const tooFar = Math.abs(estimate.dx) > width * maxShiftFraction ||
      Math.abs(estimate.dy) > height * maxShiftFraction
    if (tooFar) { dropped++; continue }    // a lurch, not hand shake: unusable
    const usable = estimate.confidence >= MIN_SHIFT_CONFIDENCE
    const dx = usable ? Math.round(estimate.dx) : 0
    const dy = usable ? Math.round(estimate.dy) : 0
    shifts.push({ ...estimate, applied: { dx: -dx, dy: -dy } })
    aligned.push(dx === 0 && dy === 0 ? frames[k] : shiftImage(frames[k], -dx, -dy))
  }

  const out = new Uint8ClampedArray(width * height * 4)
  let rejected = 0
  let considered = 0
  const include = new Uint8Array(aligned.length)
  const values = mode === 'median' ? new Float32Array(aligned.length) : null

  for (let p = 0, i = 0; p < width * height; p++, i += 4) {
    const refLumaAt = refLuma.data[p]
    // Decide inclusion ONCE per pixel per frame, on luma — a pixel is in or
    // out as a whole, never channel-by-channel (channel-split ghosts).
    for (let k = 0; k < aligned.length; k++) {
      if (aligned[k] === reference) { include[k] = 1; continue }
      const d = aligned[k].data
      const lum = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255
      considered++
      if (Math.abs(lum - refLumaAt) > motionThreshold) { include[k] = 0; rejected++ } else include[k] = 1
    }
    for (let c = 0; c < 4; c++) {
      const channel = i + c
      if (mode === 'median') {
        let n = 0
        for (let k = 0; k < aligned.length; k++) if (include[k]) values[n++] = aligned[k].data[channel]
        out[channel] = median(values, n)
      } else {
        let sum = 0
        let n = 0
        for (let k = 0; k < aligned.length; k++) if (include[k]) { sum += aligned[k].data[channel]; n++ }
        out[channel] = sum / n
      }
    }
  }
  return available({
    image: { data: out, width, height },
    shifts,
    framesUsed: aligned.length,
    framesDropped: dropped,
    rejectedFraction: considered ? rejected / considered : 0,
    mode,
  })
}

function median (values, n) {
  const slice = Array.prototype.slice.call(values, 0, n).sort((a, b) => a - b)
  const mid = n >> 1
  return n % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2
}

/** Correlation tile: big enough to see structure, pow-2, ≤ the frame. */
function pickTile (width, height) {
  const cap = Math.min(width, height)
  let tile = 64
  while (tile > cap) tile >>= 1
  return Math.max(8, tile)
}
