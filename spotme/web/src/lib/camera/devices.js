/**
 * Spot Me camera — which cameras exist, and which one to open.
 *
 * enumerateDevices is the only honest source, and it is a grudging one:
 * before a permission grant most browsers blank the labels, and no browser
 * reports facing direction directly — it lives in label conventions
 * ("facing back", "Back Camera") and, once a track is open, in
 * MediaTrackSettings.facingMode. So classification here is layered:
 * explicit facingMode when a caller has it, label heuristics otherwise,
 * UNKNOWN when neither speaks. UNKNOWN is a real answer (every desktop
 * webcam is one), not a failure.
 *
 * NOTHING HAPPENS ON IMPORT; enumeration only runs when asked, and it never
 * opens a stream.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'

export const FACING = Object.freeze({
  FRONT: 'front',                          // facingMode 'user'
  BACK: 'back',                            // facingMode 'environment'
  UNKNOWN: 'unknown',
})

/** Label conventions across Android Chrome ("camera2 0, facing back"),
 *  iOS ("Back Camera", "Front Camera") and desktop (no hint at all). */
export function classifyFacing (label = '', facingMode = null) {
  if (facingMode === 'user') return FACING.FRONT
  if (facingMode === 'environment') return FACING.BACK
  const l = String(label).toLowerCase()
  if (/\b(back|rear|environment)\b/.test(l)) return FACING.BACK
  if (/\b(front|user|face|selfie)\b/.test(l)) return FACING.FRONT
  return FACING.UNKNOWN
}

/**
 * All video inputs, classified. Returns the availability envelope so a
 * browser without enumerateDevices reports WHY rather than an empty list a
 * caller would misread as "no cameras".
 */
export async function listCameras (env = globalThis) {
  const md = env.navigator?.mediaDevices
  if (typeof md?.enumerateDevices !== 'function') {
    return unavailable(CAMERA_UNAVAILABLE.NO_MEDIA_DEVICES, 'enumerateDevices missing')
  }
  let all
  try { all = await md.enumerateDevices() } catch (e) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, String(e?.message || e))
  }
  const cameras = all
    .filter((d) => d.kind === 'videoinput')
    .map((d) => Object.freeze({
      deviceId: d.deviceId,
      groupId: d.groupId || null,
      label: d.label || '',
      /** Blank labels before a permission grant are normal; flagged so the
       *  caller knows classification is provisional, not settled. */
      labelKnown: Boolean(d.label),
      facing: classifyFacing(d.label),
    }))
  if (cameras.length === 0) return unavailable(CAMERA_UNAVAILABLE.NO_CAMERA_FOUND)
  const multiBack = cameras.filter((c) => c.facing === FACING.BACK).length > 1
  return available({ cameras, multiCamera: cameras.length > 1, multiBack })
}

/**
 * Choose a camera. Explicit deviceId wins; then facing; then the first one.
 * Returns `{device}` or an unavailable envelope — never a silent wrong pick
 * when the caller named a device that does not exist.
 */
export function pickCamera (cameras, { deviceId = null, facing = null } = {}) {
  if (!Array.isArray(cameras) || cameras.length === 0) {
    return unavailable(CAMERA_UNAVAILABLE.NO_CAMERA_FOUND)
  }
  if (deviceId) {
    const device = cameras.find((c) => c.deviceId === deviceId)
    return device ? available({ device, by: 'deviceId' })
      : unavailable(CAMERA_UNAVAILABLE.NO_CAMERA_FOUND, `deviceId ${deviceId} not present`)
  }
  if (facing) {
    const device = cameras.find((c) => c.facing === facing)
    if (device) return available({ device, by: 'facing' })
    // A phone asked for 'back' that only has UNKNOWN cameras: fall through to
    // the first device but SAY the facing preference was not honoured.
    return available({ device: cameras[0], by: 'fallback', requestedFacing: facing })
  }
  return available({ device: cameras[0], by: 'default' })
}

/** The getUserMedia video constraints for a selection + requested geometry.
 *  deviceId is exact (the user picked it); facing is ideal (best effort). */
export function constraintsFor ({ deviceId = null, facing = null, width = null, height = null, frameRate = null } = {}) {
  const video = {}
  if (deviceId) video.deviceId = { exact: deviceId }
  else if (facing === FACING.FRONT) video.facingMode = { ideal: 'user' }
  else if (facing === FACING.BACK) video.facingMode = { ideal: 'environment' }
  if (width) video.width = { ideal: width }
  if (height) video.height = { ideal: height }
  if (frameRate) video.frameRate = { ideal: frameRate }
  return { video: Object.keys(video).length ? video : true, audio: false }
}
