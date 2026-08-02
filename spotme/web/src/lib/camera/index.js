/**
 * Spot Me camera engine — the public surface of lib/camera/.
 *
 * NOTHING IN THE APP IMPORTS THIS MODULE (fence-tested; vite tree-shakes
 * the whole directory out of dist/). It exists for the future
 * owner-approved wiring PR, for missions 2–4 to build against, and for
 * the test/bench suites. Importing it does nothing: no probe, no
 * permission, no timer — construction happens only inside
 * `createCameraEngine`, and only when the flag chain is lit.
 */

export { createCameraEngine } from './engine.js'
export {
  DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, isMasterEnabled, assertShippedDark,
} from './flags.js'
export { CAMERA_UNAVAILABLE, available, unavailable, reasonFromMediaError } from './availability.js'
export { realClock, manualClock, throwingClock, withTimeout, TimeoutError } from './clock.js'
export {
  probeBrowser, probeTrack, probeWebGL2, featureAvailability, rawCapability,
} from './capabilities.js'
export { listCameras, pickCamera, classifyFacing, constraintsFor, FACING } from './devices.js'
export { openSession, SESSION_STATE, OPEN_TIMEOUT_MS } from './session.js'
export { createFrameSource, pickPumpKind, PUMP, STILL_PATH } from './frame-source.js'
export { createPipeline, validateStage, cloneImage, clamp255 } from './pipeline.js'
export { exposureGainStage, lutStage, identityLut, gammaLut, packLutTexture } from './stages.js'
export { estimateShift, MIN_SHIFT_CONFIDENCE, MIN_TILE_VARIANCE } from './align.js'
export { captureBracket, fuseExposures, weightPlane, DEFAULT_EVS, MEASURE_FLOOR } from './hdr.js'
export { stackFrames, NIGHT_DEFAULTS } from './night.js'
export {
  createSegmenterRegistry, validateSegmenter, applyPortrait, renderPortrait, resizeMask,
  portraitBlurStageGl,
} from './portrait.js'
export { createRecorder, negotiateMime, RECORDER_STATE, DEFAULT_MIME_CANDIDATES } from './video.js'
export { muxWebm, readEbml, vintBytes, WEBM_CODEC_IDS, EBML_ID } from './webm-mux.js'
export { assembleFrames, pickAssemblePath, ASSEMBLE_PATH } from './assemble.js'
export { createTimelapse, TIMELAPSE_DEFAULTS } from './timelapse.js'
export { prepareSlowmo, captureSlowmo, assembleSlowmo, SLOWMO_DEFAULTS } from './slowmo.js'
export { captureBurst, releaseBurst, BURST_DEFAULTS, BURST_PATH } from './burst.js'
export {
  createStabilizer, stabilizerStage, stabilizeFrame, stabilizationAvailability,
  EIS_TIER, EIS_DEFAULTS,
} from './stabilize.js'
export { createMetrics, percentile } from './metrics.js'
