/**
 * Spot Me AR/beauty — the honesty vocabulary for lib/ar/.
 *
 * Same rule as ../camera/availability.js, inherited unchanged: where a
 * platform (or a missing engine) cannot do something, the API answers
 * UNAVAILABLE with a machine-readable reason — never a degraded imitation
 * pretending to be the feature. A "face tracker" that draws a centred oval,
 * or a "smile detector" guessing from a bounding box, would demo well and
 * be a lie; both are exactly what this closed set exists to refuse.
 *
 * Every capability answer in this module is one of:
 *
 *   { available: true, ...facts }              — real, use it
 *   { available: false, reason, detail? }      — and here is WHY
 *
 * The set is CLOSED and AR-specific (the camera engine keeps its own): a UI
 * can put one exact sentence in front of the user per reason, tests assert
 * exact causes, and an unknown reason THROWS instead of shipping a shrug.
 */

export const AR_UNAVAILABLE = Object.freeze({
  /** The governing flag (or an ancestor) is off. The dark-launch answer. */
  FLAG_DISABLED: 'FLAG_DISABLED',
  /** No IFaceTracker engine is registered at all. */
  NO_FACE_TRACKER: 'NO_FACE_TRACKER',
  /** The platform FaceDetector (Shape Detection API) does not exist here —
   *  Chrome/Android ships it; Safari and Firefox do not. Platform truth. */
  NO_PLATFORM_FACE_DETECTOR: 'NO_PLATFORM_FACE_DETECTOR',
  /** Landmark-gated work needs a registered landmark-mesh engine (MediaPipe
   *  face-landmarker — a named OWNER dependency decision, ADR-014c §4).
   *  Never approximated from boxes; absent means absent. */
  NO_LANDMARK_ENGINE: 'NO_LANDMARK_ENGINE',
  /** Hand gestures need a hand-landmark engine; the seam exists, the
   *  engine is the same class of owner dependency decision. */
  NO_HAND_ENGINE: 'NO_HAND_ENGINE',
  /** A landmark engine IS registered but does not expose the specific
   *  points this feature computes from. Per-platform truth, not a bug. */
  MISSING_LANDMARKS: 'MISSING_LANDMARKS',
  /** World-anchored AR is real only through WebXR immersive-ar or the P10
   *  native layer (ARCore/ARKit). The seam is documented; simulating plane
   *  detection with a gyro guess is refused. */
  DEFERRED_WEBXR: 'DEFERRED_WEBXR',
  /** The operation was tried for real and failed; detail says how. */
  FAILED: 'FAILED',
})

/** An affirmative answer, with whatever facts ride along. */
export function available (facts = {}) {
  return Object.freeze({ available: true, ...facts })
}

/** A refusal with a reason. Unknown reasons throw — an unnamed refusal is
 *  a shrug, and shrugs are what this vocabulary exists to eliminate. */
export function unavailable (reason, detail) {
  if (!Object.prototype.hasOwnProperty.call(AR_UNAVAILABLE, reason)) {
    throw new Error(`unknown ar unavailability reason: ${reason}`)
  }
  const out = { available: false, reason }
  if (detail !== undefined) out.detail = detail
  return Object.freeze(out)
}
