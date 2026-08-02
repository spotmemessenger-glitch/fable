/**
 * Spot Me AR/beauty — the IFaceTracker seam and its engine registry.
 *
 * WHAT SHIPS HERE AND WHAT DOES NOT. The SEAM is real and tested: a
 * validated adapter contract, a registry one createArBeauty instance owns,
 * and a result runner that turns engine misbehaviour into named envelopes
 * instead of crashes. TWO engine classes plug in:
 *
 *   - box engines: the platform Shape-Detection adapter
 *     (shape-detection.js) — REAL where the browser ships FaceDetector.
 *   - the landmark-mesh engine SLOT: MediaPipe face-landmarker. That is a
 *     new dependency + self-hosted model assets, which this repo's
 *     zero-dep rule reserves for the OWNER to approve (ADR-014c §4). The
 *     slot therefore stays EMPTY here: `landmarkAvailability()` answers
 *     NO_LANDMARK_ENGINE, and nothing in lib/ar approximates landmarks
 *     from boxes — a guessed mouth line whitening someone's chin is the
 *     exact fake this module refuses.
 *
 * IFaceTracker — the adapter contract every engine implements:
 *
 *   {
 *     id:           'shape-detection' | 'mediapipe-face-landmarker' | …
 *     capabilities: {
 *       boxes:      true,
 *       landmarks:  null            — boxes only, OR
 *                   ['leftEye', …]  — the CANONICAL names it really emits
 *     }
 *     track: async (frame) → {
 *       faces: [{ box: {x,y,width,height},
 *                 landmarks?: { name: {x,y} },   // only declared names
 *                 conf: 0..1 | null }],          // null = engine reports none
 *       ts: number                               // engine clock ms
 *     }
 *     release?: () => void
 *   }
 *
 * PRIVACY INVARIANT (ar-threat-model.md): tracker output is transient
 * per-frame geometry. Nothing here persists it, derives a template from it,
 * or matches faces across sessions — `trackId`s (smoothing.js) are
 * monotonic per-smoother integers that die with the instance.
 */

import { AR_UNAVAILABLE, available, unavailable } from './availability.js'
import { isValidBox, isValidPoint } from './armath.js'

/**
 * The canonical landmark vocabulary this module computes from. A landmark
 * engine declares the SUBSET it truly emits; consumers state which names
 * they need and go UNAVAILABLE(MISSING_LANDMARKS) otherwise. The MediaPipe
 * face-landmarker adapter (owner decision) will map mesh indices onto these
 * names — the mapping belongs to that adapter, not to consumers.
 */
export const LANDMARK_NAMES = Object.freeze([
  'leftEye', 'rightEye',
  'leftEyeInner', 'leftEyeOuter', 'leftEyeTop', 'leftEyeBottom',
  'rightEyeInner', 'rightEyeOuter', 'rightEyeTop', 'rightEyeBottom',
  'noseTip',
  'mouthLeft', 'mouthRight', 'upperLipTop', 'lowerLipBottom',
  'chin', 'jawLeft', 'jawRight', 'leftCheek', 'rightCheek',
  'foreheadCenter',
])

/** Validate an IFaceTracker shape. Returns a problem string or null. */
export function validateFaceTracker (tracker) {
  if (!tracker || typeof tracker !== 'object') return 'tracker must be an object'
  if (typeof tracker.id !== 'string' || !tracker.id) return 'tracker.id required'
  const caps = tracker.capabilities
  if (!caps || typeof caps !== 'object') return 'tracker.capabilities required'
  if (caps.boxes !== true) return 'tracker.capabilities.boxes must be true (a face tracker that cannot box faces is not one)'
  if (caps.landmarks !== null) {
    if (!Array.isArray(caps.landmarks) || caps.landmarks.length === 0) {
      return 'tracker.capabilities.landmarks must be null or a non-empty array of canonical names'
    }
    for (const name of caps.landmarks) {
      if (!LANDMARK_NAMES.includes(name)) return `unknown landmark name: ${name}`
    }
  }
  if (typeof tracker.track !== 'function') return 'tracker.track(frame) required'
  return null
}

/**
 * The registry one createArBeauty instance owns. No module-level state:
 * two engines (or a test and the app) can never fight over a global.
 * Multiple engines may register (box engine + landmark engine); `active()`
 * prefers the richest — most landmarks, then boxes-only, insertion order
 * breaking ties.
 */
export function createTrackerRegistry () {
  const engines = new Map()                 // id → tracker, insertion-ordered

  const landmarkCount = (t) => (Array.isArray(t.capabilities.landmarks) ? t.capabilities.landmarks.length : 0)

  return {
    register (tracker) {
      const problem = validateFaceTracker(tracker)
      if (problem) return unavailable(AR_UNAVAILABLE.FAILED, problem)
      if (engines.has(tracker.id)) {
        return unavailable(AR_UNAVAILABLE.FAILED, `duplicate tracker id: ${tracker.id}`)
      }
      engines.set(tracker.id, tracker)
      return available({ engine: tracker.id, landmarks: tracker.capabilities.landmarks })
    },

    unregister (id) {
      const had = engines.get(id)
      if (!had) return unavailable(AR_UNAVAILABLE.FAILED, `no tracker registered as ${id}`)
      engines.delete(id)
      try { had.release?.() } catch { /* the engine's problem, not the seam's */ }
      return available({ released: id })
    },

    get: (id) => engines.get(id) || null,

    list: () => [...engines.values()].map((t) => Object.freeze({
      id: t.id,
      capabilities: Object.freeze({
        boxes: t.capabilities.boxes,
        landmarks: t.capabilities.landmarks ? Object.freeze([...t.capabilities.landmarks]) : null,
      }),
    })),

    /** The engine consumers should track with: richest landmarks first. */
    active () {
      let best = null
      for (const t of engines.values()) {
        if (!best || landmarkCount(t) > landmarkCount(best)) best = t
      }
      return best
    },

    /** The landmark-mesh slot: an engine that truly emits named landmarks,
     *  or null. Tier-1 beauty and face gestures gate on this. */
    landmarkEngine () {
      for (const t of engines.values()) {
        if (landmarkCount(t) > 0) return t
      }
      return null
    },

    availability () {
      if (engines.size === 0) {
        return unavailable(AR_UNAVAILABLE.NO_FACE_TRACKER,
          'register an IFaceTracker: the Shape-Detection adapter where the platform has FaceDetector, or the landmark engine (owner dep decision)')
      }
      const active = this.active()
      return available({ engines: [...engines.keys()], active: active.id, landmarks: active.capabilities.landmarks })
    },

    landmarkAvailability () {
      const engine = this.landmarkEngine()
      if (!engine) {
        return unavailable(AR_UNAVAILABLE.NO_LANDMARK_ENGINE,
          'MediaPipe face-landmarker adapter + self-hosted model assets — owner dependency decision (ADR-014c §4); never approximated from boxes')
      }
      return available({ engine: engine.id, landmarks: engine.capabilities.landmarks })
    },
  }
}

/** Validate one face result against the tracker's DECLARED capabilities.
 *  Returns a problem string or null. */
function validateFace (face, tracker) {
  if (!face || typeof face !== 'object') return 'face must be an object'
  if (!isValidBox(face.box)) return 'face.box must be a finite positive rectangle'
  if (face.conf !== null && !(typeof face.conf === 'number' && face.conf >= 0 && face.conf <= 1)) {
    return 'face.conf must be 0..1 or null'
  }
  const declared = tracker.capabilities.landmarks
  if (face.landmarks !== undefined && face.landmarks !== null) {
    if (!declared) return `engine ${tracker.id} declares no landmarks but emitted some`
    for (const [name, point] of Object.entries(face.landmarks)) {
      if (!declared.includes(name)) return `engine ${tracker.id} emitted undeclared landmark: ${name}`
      if (!isValidPoint(point)) return `landmark ${name} is not a finite point`
    }
  }
  return null
}

/**
 * Run one engine over one frame and validate what came back. A throwing or
 * malformed engine becomes FAILED with the engine NAMED — a bad model must
 * never crash the preview loop that hosts it.
 */
export async function trackFaces (tracker, frame) {
  if (!tracker) {
    return unavailable(AR_UNAVAILABLE.NO_FACE_TRACKER, 'no tracker supplied')
  }
  let result
  try {
    result = await tracker.track(frame)
  } catch (e) {
    return unavailable(AR_UNAVAILABLE.FAILED, `tracker ${tracker.id}: ${e?.message || e}`)
  }
  if (!result || !Array.isArray(result.faces) || typeof result.ts !== 'number') {
    return unavailable(AR_UNAVAILABLE.FAILED, `tracker ${tracker.id} returned a malformed result (need {faces, ts})`)
  }
  for (const face of result.faces) {
    const problem = validateFace(face, tracker)
    if (problem) return unavailable(AR_UNAVAILABLE.FAILED, `tracker ${tracker.id}: ${problem}`)
  }
  return available({ faces: result.faces, ts: result.ts, engine: tracker.id })
}
