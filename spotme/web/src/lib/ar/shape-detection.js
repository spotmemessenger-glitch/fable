/**
 * Spot Me AR/beauty — the Shape-Detection adapter: the one face-tracking
 * engine the WEB PLATFORM itself provides.
 *
 * `FaceDetector` (Shape Detection API) is real in Chromium on Android and
 * ChromeOS (hardware-backed where the SoC has a detector), absent in
 * Safari and Firefox. This adapter feature-detects and answers the truth:
 * where the API exists you get a working IFaceTracker; where it does not
 * you get UNAVAILABLE(NO_PLATFORM_FACE_DETECTOR) with the reason spelled
 * out — never a stand-in.
 *
 * HONESTY NOTES, measured against the spec and shipping behaviour:
 *   - capabilities.landmarks is NULL. Chromium's detector can attach
 *     coarse eye/mouth points on SOME devices, sometimes, with no
 *     guarantee; a tier-1 beauty op aimed by a maybe-point would whiten
 *     chins. This adapter therefore promises boxes only, and the
 *     landmark-mesh slot stays an owner decision (trackers.js).
 *   - conf is NULL. DetectedFace carries no confidence; inventing one
 *     (e.g. box size) would be a fake score consumers might rank by.
 */

import { AR_UNAVAILABLE, available, unavailable } from './availability.js'

/** Pure feature test on `env`. No detector constructed, nothing probed. */
export function shapeDetectionAvailability (env = globalThis) {
  if (typeof env.FaceDetector !== 'function') {
    return unavailable(AR_UNAVAILABLE.NO_PLATFORM_FACE_DETECTOR,
      'FaceDetector (Shape Detection API) is absent — Chromium/Android ships it; Safari and Firefox do not')
  }
  return available({ api: 'FaceDetector' })
}

/**
 * Build the adapter. Returns an availability envelope:
 *   { available: true, tracker }   — a valid IFaceTracker (boxes only)
 *   { available: false, reason }   — NO_PLATFORM_FACE_DETECTOR or FAILED
 *
 * @param opts.env               feature-detected environment
 * @param opts.clock             injectable clock — stamps result.ts
 * @param opts.maxDetectedFaces  passed through to the platform (default 5)
 * @param opts.fastMode          platform speed/accuracy trade (default true)
 */
export function createShapeDetectionTracker ({ env = globalThis, clock, maxDetectedFaces = 5, fastMode = true } = {}) {
  const probe = shapeDetectionAvailability(env)
  if (!probe.available) return probe
  if (!clock || typeof clock.now !== 'function') {
    return unavailable(AR_UNAVAILABLE.FAILED, 'createShapeDetectionTracker needs an injectable clock')
  }
  let detector
  try {
    detector = new env.FaceDetector({ maxDetectedFaces, fastMode })
  } catch (e) {
    return unavailable(AR_UNAVAILABLE.FAILED, `FaceDetector construction: ${e?.message || e}`)
  }

  const tracker = Object.freeze({
    id: 'shape-detection',
    capabilities: Object.freeze({ boxes: true, landmarks: null }),
    async track (frame) {
      // Platform errors propagate; trackFaces() turns them into FAILED
      // envelopes with this engine named.
      const detected = await detector.detect(frame)
      const faces = (detected || []).map((d) => ({
        box: {
          x: d.boundingBox.x,
          y: d.boundingBox.y,
          width: d.boundingBox.width,
          height: d.boundingBox.height,
        },
        conf: null,                       // the platform reports none — say so
      }))
      return { faces, ts: clock.now() }
    },
    release () { detector = null },
  })
  return available({ tracker })
}
