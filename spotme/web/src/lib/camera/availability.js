/**
 * Spot Me camera — the honesty vocabulary.
 *
 * THE RULE (inherited from qr-scan.js and the BLE work): where a platform
 * cannot do something, the API says UNAVAILABLE with a machine-readable
 * reason — never a degraded imitation pretending to be the feature. A fake
 * night mode that just raises gain would score well in a demo and betray the
 * user the first dark room they trust it in.
 *
 * Every capability answer in the engine is one of:
 *
 *   { available: true, ...facts }                      — real, use it
 *   { available: false, reason, detail? }              — and here is WHY
 *
 * Reasons are closed-set constants so a UI (in the future wiring PR) can put
 * a specific sentence in front of the user, tests can assert exact causes,
 * and a log line is greppable. `detail` is free-form context (which
 * constraint was missing, what the device's max actually was).
 */

export const CAMERA_UNAVAILABLE = Object.freeze({
  /** The governing flag (or an ancestor) is off. The dark-launch answer. */
  FLAG_DISABLED: 'FLAG_DISABLED',
  /** Browser has no navigator.mediaDevices / getUserMedia at all. */
  NO_MEDIA_DEVICES: 'NO_MEDIA_DEVICES',
  /** User (or platform policy) refused the camera permission. */
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** No camera hardware, or none matching the requested constraints. */
  NO_CAMERA_FOUND: 'NO_CAMERA_FOUND',
  /** The camera is present but another app/tab holds it. */
  CAMERA_BUSY: 'CAMERA_BUSY',
  /** Needed a live session/track and none was supplied or it has ended. */
  NO_ACTIVE_SESSION: 'NO_ACTIVE_SESSION',
  /** Browser lacks the ImageCapture API (notably iOS Safari). */
  NO_IMAGE_CAPTURE: 'NO_IMAGE_CAPTURE',
  /** Browser lacks WebCodecs (VideoEncoder/VideoDecoder). */
  NO_WEBCODECS: 'NO_WEBCODECS',
  /** Browser lacks MediaRecorder, or supports none of the offered types. */
  NO_RECORDER: 'NO_RECORDER',
  /** Browser/canvas cannot produce a WebGL2 context. */
  NO_WEBGL2: 'NO_WEBGL2',
  /** The track's MediaTrackCapabilities does not expose this control
   *  (torch, zoom, focus/exposure modes, ISO…). Device truth, not a bug. */
  NOT_IN_TRACK_CAPABILITIES: 'NOT_IN_TRACK_CAPABILITIES',
  /** HDR bracketing needs a real exposureCompensation range; none exists. */
  NO_EXPOSURE_CONTROL: 'NO_EXPOSURE_CONTROL',
  /** Slow-motion needs a genuinely high-fps mode; the device tops out lower.
   *  Interpolating frames to fake one is exactly what this engine refuses. */
  NO_HIGH_FPS_MODE: 'NO_HIGH_FPS_MODE',
  /** Portrait needs a registered ISegmenter engine; none is registered.
   *  (The MediaPipe dependency decision belongs to the owner — ADR-014a.) */
  NO_SEGMENTER_REGISTERED: 'NO_SEGMENTER_REGISTERED',
  /** Real on this platform only through the Capacitor native layer (P10):
   *  RAW capture, gyro-assisted EIS, native depth. The adapter contract is
   *  documented; the web build reports it honestly instead of simulating. */
  DEFERRED_NATIVE: 'DEFERRED_NATIVE',
  /** A stated resource bound (memory, frame count, duration) was hit. */
  RESOURCE_LIMIT: 'RESOURCE_LIMIT',
  /** The operation was tried for real and failed; detail says how. */
  FAILED: 'FAILED',
})

/** An affirmative answer, with whatever facts ride along. */
export function available (facts = {}) {
  return Object.freeze({ available: true, ...facts })
}

/** A refusal with a reason. Unknown reasons throw — an unnamed refusal is a
 *  shrug, and shrugs are what this vocabulary exists to eliminate. */
export function unavailable (reason, detail) {
  if (!Object.prototype.hasOwnProperty.call(CAMERA_UNAVAILABLE, reason)) {
    throw new Error(`unknown unavailability reason: ${reason}`)
  }
  const out = { available: false, reason }
  if (detail !== undefined) out.detail = detail
  return Object.freeze(out)
}

/** getUserMedia's errors are named, not coded — mapped once, here, so every
 *  session-open path reports the same specific cause. */
export function reasonFromMediaError (err) {
  const name = err?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') return CAMERA_UNAVAILABLE.PERMISSION_DENIED
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return CAMERA_UNAVAILABLE.NO_CAMERA_FOUND
  if (name === 'NotReadableError' || name === 'AbortError') return CAMERA_UNAVAILABLE.CAMERA_BUSY
  return CAMERA_UNAVAILABLE.FAILED
}
