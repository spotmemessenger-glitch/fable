/**
 * Spot Me AI Vision (mission CAM-2) — the public surface of lib/vision/.
 *
 * NOTHING IN THE APP IMPORTS THIS MODULE (fence-tested; vite tree-shakes the
 * whole directory out of dist/). It exists for the future owner-approved
 * wiring PR and for the test/bench suites. Importing it does nothing: no
 * probe, no registry, no network — construction happens only inside
 * `createVision`, and only when the flag chain is lit.
 *
 * This module builds ON the camera engine (SEAM#1 FrameSource, shared image
 * math): those `../camera/*` imports are the platform sibling, not app code —
 * the vision fence allows exactly them and forbids everything else.
 *
 * Scope note: the on-device document scanner (docscan/quad/homography/…) is
 * NOT exported here — it landed unreviewed and failing its golden tests, so
 * it is held on branch wip/ai-vision-docscan-unreviewed (ADR-014b §4) until
 * it is finished to the platform bar. This surface ships the one proven
 * on-device leg (scan) plus the honest dark seams.
 */

export { createVision } from './engine.js'
export {
  DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, isVisionEnabled, assertShippedDark,
} from './flags.js'
export { VISION_UNAVAILABLE, available, unavailable } from './availability.js'
export {
  scannerSupport, createBarcodeReader, scanFrames, readImage, createDedup,
  SCAN_ENGINE, SCAN_FORMATS, JSQR_FORMATS,
} from './scan.js'
export {
  createTextRecognizerRegistry, validateTextRecognizer,
  createTranslatorSlot, validateTranslator,
} from './seams.js'
export { createVisionCloudClient } from './vision-cloud.js'
