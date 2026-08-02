/**
 * Spot Me — AR & Beauty engine factory: the single front door for mission
 * CAM-3, the sibling of createCameraEngine / createVision.
 *
 * `createArBeauty()` with shipped defaults returns the INERT STUB — and inert
 * means CONSTRUCTS NOTHING: no tracker registry, no detector, no property of
 * `env` so much as read. Every method answers UNAVAILABLE(FLAG_DISABLED),
 * async where the live method is async, so a caller written against the live
 * shape runs unchanged against the dark one (shape parity is fence-asserted).
 *
 * The LIVE engine exists only when a reviewed wiring PR passes the lit flag
 * chain (docs/ai-camera/ar-activation.md). What lights up splits sharply:
 *
 *   beauty (tier-0)   ON-DEVICE, pure math with CPU+GLSL twins built to
 *                     matched formulas (deterministic CPU-side tests;
 *                     real-GPU equivalence unproven) and hard naturalness
 *                     caps. Implemented + tested inside the gated module —
 *                     not wired, not user-accessible.
 *   faceTracking      The IFaceTracker seam + the platform Shape-Detection
 *                     box adapter + temporal smoothing. Functional where the
 *                     platform ships FaceDetector; honest refusal elsewhere.
 *                     Untested on real hardware.
 *   advancedBeauty,   LANDMARK-gated. Need a registered face-landmark engine
 *   masks             (MediaPipe — an owner dependency, ADR-014c §4). Absent
 *                     ⇒ NO_LANDMARK_ENGINE, never approximated from boxes.
 *   gestures          Need a hand-landmark engine (same class of owner dep)
 *                     ⇒ NO_HAND_ENGINE.
 *   world             WebXR immersive-ar / P10 native ⇒ DEFERRED_WEBXR; a
 *                     gyro-guess plane fake is refused.
 *
 * `availability()` merges flag state with capability truth, flag winning —
 * because rollback must win arguments with a registered engine or a capable
 * browser.
 */

import { resolveArFlags, isArMasterEnabled } from './flags.js'
import { AR_UNAVAILABLE, available, unavailable } from './availability.js'
import { createTrackerRegistry, trackFaces } from './trackers.js'
import { createFaceSmoother } from './smoothing.js'
import { createShapeDetectionTracker } from './shape-detection.js'
import { beautyTier0Stages, skinToneMask, BEAUTY_LIMITS } from './beauty.js'
import { realClock } from '../camera/clock.js'

const FEATURE_FLAG = Object.freeze({
  faceTracking: 'AR_FACE_TRACKING_ENABLED',
  gestures: 'AR_GESTURES_ENABLED',
  masks: 'AR_MASKS_ENABLED',
  world: 'AR_WORLD_ENABLED',
  beauty: 'BEAUTY_ENABLED',
})

export function createArBeauty ({ flags = {}, env = null, clock = null } = {}) {
  const resolved = resolveArFlags(flags)
  if (!isArMasterEnabled(resolved)) return inertArBeauty(resolved)
  return liveArBeauty(resolved, env || globalThis, clock)
}

/* --------------------------------------------------------- the stub ------ */

function inertArBeauty (resolved) {
  const name = 'AR_BEAUTY_ENABLED'
  const dark = () => unavailable(AR_UNAVAILABLE.FLAG_DISABLED, name)
  const darkSync = () => dark()
  const darkAsync = () => async () => dark()
  return Object.freeze({
    enabled: false,
    flags: resolved,
    availability: darkSync,
    faceTracking: Object.freeze({
      availability: darkSync, register: darkSync, unregister: darkSync,
      useShapeDetection: darkSync, track: darkAsync(), createSmoother: darkSync,
      active: () => null,
    }),
    landmarks: Object.freeze({ availability: darkSync, engine: () => null }),
    beauty: Object.freeze({
      availability: darkSync, stages: darkSync, skinMask: darkSync,
      limits: () => BEAUTY_LIMITS,
      advanced: Object.freeze({ availability: darkSync }),
    }),
    gestures: Object.freeze({ availability: darkSync }),
    masks: Object.freeze({ availability: darkSync }),
    world: Object.freeze({ availability: darkSync }),
  })
}

/* -------------------------------------------------------- the engine ----- */

function liveArBeauty (resolved, env, clockIn) {
  const clock = clockIn || realClock(env)
  const registry = createTrackerRegistry()

  const gate = (feature) => (resolved[FEATURE_FLAG[feature]]
    ? null
    : unavailable(AR_UNAVAILABLE.FLAG_DISABLED, FEATURE_FLAG[feature]))
  const gatedSync = (feature, fn) => (...args) => gate(feature) || fn(...args)
  const gatedAsync = (feature, fn) => async (...args) => gate(feature) || fn(...args)

  const engine = {
    enabled: true,
    flags: resolved,

    /** Per-feature map, flag state merged over capability truth. */
    availability () {
      const map = {}
      map.faceTracking = resolved.AR_FACE_TRACKING_ENABLED ? registry.availability() : gate('faceTracking')
      map.beauty = resolved.BEAUTY_ENABLED ? available({ limits: BEAUTY_LIMITS }) : gate('beauty')
      map.advancedBeauty = !resolved.BEAUTY_ADVANCED_ENABLED
        ? unavailable(AR_UNAVAILABLE.FLAG_DISABLED, 'BEAUTY_ADVANCED_ENABLED')
        : registry.landmarkAvailability()
      map.gestures = resolved.AR_GESTURES_ENABLED
        ? unavailable(AR_UNAVAILABLE.NO_HAND_ENGINE, 'hand-landmark engine is an owner dependency (ADR-014c §4)')
        : gate('gestures')
      map.masks = resolved.AR_MASKS_ENABLED ? registry.landmarkAvailability() : gate('masks')
      map.world = resolved.AR_WORLD_ENABLED
        ? unavailable(AR_UNAVAILABLE.DEFERRED_WEBXR, 'world AR is WebXR/native only — no simulated plane detection')
        : gate('world')
      return Object.freeze(map)
    },

    faceTracking: Object.freeze({
      availability: gatedSync('faceTracking', () => registry.availability()),
      register: gatedSync('faceTracking', (tracker) => registry.register(tracker)),
      unregister: gatedSync('faceTracking', (id) => registry.unregister(id)),
      active: () => registry.active(),
      /** Build + register the platform Shape-Detection box adapter, or the
       *  honest NO_PLATFORM_FACE_DETECTOR where the API is absent. */
      useShapeDetection: gatedSync('faceTracking', (opts = {}) => {
        const built = createShapeDetectionTracker({ env, clock, ...opts })
        if (!built.available) return built
        return registry.register(built.tracker)
      }),
      track: gatedAsync('faceTracking', (frame) => {
        const tracker = registry.active()
        if (!tracker) return registry.availability()
        return trackFaces(tracker, frame)
      }),
      createSmoother: gatedSync('faceTracking', (opts) => createFaceSmoother(opts)),
    }),

    /** The landmark-mesh slot (the MediaPipe seam): a tracker registered
     *  with real landmarks lights it; empty ⇒ NO_LANDMARK_ENGINE. */
    landmarks: Object.freeze({
      availability: gatedSync('faceTracking', () => registry.landmarkAvailability()),
      engine: () => registry.landmarkEngine(),
    }),

    beauty: Object.freeze({
      availability: gatedSync('beauty', () => available({ limits: BEAUTY_LIMITS })),
      stages: gatedSync('beauty', (opts) => beautyTier0Stages(opts)),
      skinMask: gatedSync('beauty', (image) => skinToneMask(image)),
      limits: () => BEAUTY_LIMITS,
      advanced: Object.freeze({
        // Child flag under BEAUTY, then the landmark engine — both must be
        // present, and neither is faked from boxes.
        availability: () => {
          if (!resolved.BEAUTY_ADVANCED_ENABLED) return unavailable(AR_UNAVAILABLE.FLAG_DISABLED, 'BEAUTY_ADVANCED_ENABLED')
          return registry.landmarkAvailability()
        },
      }),
    }),

    gestures: Object.freeze({
      availability: gatedSync('gestures', () => unavailable(AR_UNAVAILABLE.NO_HAND_ENGINE,
        'register a hand-landmark engine (owner dependency, ADR-014c §4)')),
    }),

    masks: Object.freeze({
      // Masks anchor to face landmarks; with no landmark engine the honest
      // answer is NO_LANDMARK_ENGINE, not a box-anchored approximation.
      availability: gatedSync('masks', () => registry.landmarkAvailability()),
    }),

    world: Object.freeze({
      availability: gatedSync('world', () => unavailable(AR_UNAVAILABLE.DEFERRED_WEBXR,
        'world AR needs WebXR immersive-ar or the P10 native layer — no simulated plane detection')),
    }),
  }
  return Object.freeze(engine)
}
