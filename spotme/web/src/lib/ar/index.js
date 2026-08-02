/**
 * Spot Me AR & Beauty (mission CAM-3) — the public surface of lib/ar/.
 *
 * NOTHING IN THE APP IMPORTS THIS MODULE (fence-tested; vite tree-shakes the
 * whole directory out of dist/). It exists for the future owner-approved
 * wiring PR and for the test/bench suites. Importing it does nothing: no
 * tracker, no detector, no timer — construction happens only inside
 * `createArBeauty`, and only when the flag chain is lit.
 *
 * This module builds ON the camera engine (shared clock, image math): the
 * `../camera/*` import is the platform sibling, not app code — the ar fence
 * allows exactly it and forbids everything else.
 */

export { createArBeauty } from './engine.js'
export {
  AR_DEFAULT_FLAGS, AR_FLAG_PARENT, resolveArFlags, isArMasterEnabled, assertArShippedDark,
} from './flags.js'
export { AR_UNAVAILABLE, available, unavailable } from './availability.js'
export {
  createTrackerRegistry, validateFaceTracker, trackFaces, LANDMARK_NAMES,
} from './trackers.js'
export { createFaceSmoother, SMOOTHER_DEFAULTS } from './smoothing.js'
export { shapeDetectionAvailability, createShapeDetectionTracker } from './shape-detection.js'
export {
  beautyTier0Stages, skinSmoothStage, toneWarmthStage, brightenStage,
  skinToneMask, BEAUTY_LIMITS,
} from './beauty.js'
