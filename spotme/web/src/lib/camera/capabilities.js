/**
 * Spot Me camera — the honest capability probe.
 *
 * Two layers, because the platform answers two different questions:
 *
 *   probeBrowser(env)   — what APIs does this BROWSER have? Static feature
 *                         detection, no permission prompt, no camera touched.
 *   probeTrack(track)   — what can this DEVICE's live track actually do?
 *                         Reads MediaTrackCapabilities, which only exists
 *                         once a stream is open.
 *
 * Every answer is DATA in the availability vocabulary: `{available:true,
 * ...facts}` or `{available:false, reason}`. Nothing here guesses. A control
 * absent from MediaTrackCapabilities is reported absent — Chrome on one
 * Android phone exposes torch+zoom+exposureCompensation, the same Chrome on
 * another exposes none of them, and iOS Safari exposes almost nothing; the
 * caller learns which world it is in rather than being handed a slider that
 * silently does nothing.
 *
 * NOTHING HAPPENS ON IMPORT, and probeBrowser never opens a stream.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'

/** Browser-level API surface. Pure feature tests on `env`. */
export function probeBrowser (env = globalThis) {
  const md = env.navigator?.mediaDevices
  const has = (v) => typeof v === 'function'
  return Object.freeze({
    mediaDevices: Boolean(md),
    getUserMedia: has(md?.getUserMedia),
    enumerateDevices: has(md?.enumerateDevices),
    /** ImageCapture drives real photo capture (takePhoto/grabFrame).
     *  Chromium yes; iOS Safari no — the still path degrades honestly. */
    imageCapture: typeof env.ImageCapture === 'function',
    /** MediaStreamTrackProcessor is the zero-copy frame pump (Chromium). */
    trackProcessor: typeof env.MediaStreamTrackProcessor === 'function',
    /** requestVideoFrameCallback pump needs a video element to hang off. */
    videoFrameCallback: typeof env.HTMLVideoElement === 'function' &&
      typeof env.HTMLVideoElement.prototype?.requestVideoFrameCallback === 'function',
    webCodecs: Object.freeze({
      videoEncoder: typeof env.VideoEncoder === 'function',
      videoDecoder: typeof env.VideoDecoder === 'function',
    }),
    mediaRecorder: typeof env.MediaRecorder === 'function',
    offscreenCanvas: typeof env.OffscreenCanvas === 'function',
    createImageBitmap: typeof env.createImageBitmap === 'function',
    /** DOM present at all — the canvas-draw still fallback needs it. */
    document: typeof env.document !== 'undefined',
  })
}

/** True when a WebGL2 context can actually be created — probed against a
 *  supplied canvas (or an OffscreenCanvas) because `typeof` cannot tell a
 *  blocklisted GPU from a working one. */
export function probeWebGL2 (env = globalThis, canvas = null) {
  try {
    const target = canvas ||
      (typeof env.OffscreenCanvas === 'function' ? new env.OffscreenCanvas(1, 1) : null) ||
      (env.document ? env.document.createElement('canvas') : null)
    if (!target) return unavailable(CAMERA_UNAVAILABLE.NO_WEBGL2, 'no canvas to probe')
    const gl = target.getContext?.('webgl2')
    if (!gl) return unavailable(CAMERA_UNAVAILABLE.NO_WEBGL2, 'context creation refused')
    return available({ maxTextureSize: gl.getParameter?.(gl.MAX_TEXTURE_SIZE) ?? null })
  } catch (e) {
    return unavailable(CAMERA_UNAVAILABLE.NO_WEBGL2, String(e?.message || e))
  }
}

/** A range capability ({min,max,step?}) → facts, or an honest absence. */
function rangeCap (caps, key) {
  const value = caps?.[key]
  if (!value || typeof value.min !== 'number' || typeof value.max !== 'number' ||
      !(value.max > value.min)) {
    return unavailable(CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES, key)
  }
  const facts = { min: value.min, max: value.max }
  if (typeof value.step === 'number') facts.step = value.step
  return available(facts)
}

/** A mode-list capability (['manual','continuous']) → facts, or absence. */
function modesCap (caps, key) {
  const modes = caps?.[key]
  if (!Array.isArray(modes) || modes.length === 0) {
    return unavailable(CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES, key)
  }
  return available({ modes: [...modes] })
}

/**
 * What this live track's device can do. Every control the engine's features
 * lean on, answered individually so a device with zoom but no torch reports
 * exactly that.
 *
 * `highFpsThreshold` marks where "high-fps" honestly begins for slow-motion:
 * 100 fps is the floor under which 4x slow-mo of 25 fps output cannot exist.
 */
export function probeTrack (track, { highFpsThreshold = 100 } = {}) {
  if (!track || typeof track.getCapabilities !== 'function') {
    const absent = unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION,
      'track missing or lacks getCapabilities')
    return Object.freeze({
      torch: absent, zoom: absent, focusMode: absent, focusDistance: absent,
      exposureMode: absent, exposureCompensation: absent, exposureTime: absent,
      iso: absent, whiteBalanceMode: absent, colorTemperature: absent,
      frameRate: absent, highFps: absent, width: absent, height: absent,
      facingMode: absent, raw: rawCapability(),
    })
  }
  let caps = {}
  try { caps = track.getCapabilities() || {} } catch { caps = {} }

  const torch = Array.isArray(caps.torch)
    // Some engines report torch as [false, true]; presence of true = capable.
    ? (caps.torch.includes(true) ? available({}) : unavailable(CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES, 'torch'))
    : (caps.torch === true ? available({}) : unavailable(CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES, 'torch'))

  const frameRate = rangeCap(caps, 'frameRate')
  const highFps = frameRate.available && frameRate.max >= highFpsThreshold
    ? available({ max: frameRate.max, threshold: highFpsThreshold })
    : unavailable(CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE,
      frameRate.available ? `device tops out at ${frameRate.max}fps (< ${highFpsThreshold})` : 'frameRate not reported')

  return Object.freeze({
    torch,
    zoom: rangeCap(caps, 'zoom'),
    focusMode: modesCap(caps, 'focusMode'),
    focusDistance: rangeCap(caps, 'focusDistance'),
    exposureMode: modesCap(caps, 'exposureMode'),
    exposureCompensation: rangeCap(caps, 'exposureCompensation'),
    exposureTime: rangeCap(caps, 'exposureTime'),
    iso: rangeCap(caps, 'iso'),
    whiteBalanceMode: modesCap(caps, 'whiteBalanceMode'),
    colorTemperature: rangeCap(caps, 'colorTemperature'),
    frameRate,
    highFps,
    width: rangeCap(caps, 'width'),
    height: rangeCap(caps, 'height'),
    facingMode: modesCap(caps, 'facingMode'),
    raw: rawCapability(),
  })
}

/** RAW/DNG capture: the web platform has no sensor-RAW path at all, in any
 *  browser. Stated once, as data, so no caller is tempted to relabel a JPEG.
 *  Real via the Capacitor native adapter in P10 — see ADR-014a §RAW. */
export function rawCapability () {
  return unavailable(CAMERA_UNAVAILABLE.DEFERRED_NATIVE,
    'web platform exposes no sensor-RAW capture; native adapter (P10)')
}

/**
 * The feature → prerequisite map, resolved against a browser probe and an
 * optional track probe. This is what `engine.availability()` returns per
 * feature, and what the capability-matrix test pins per simulated platform.
 */
export function featureAvailability (browser, trackCaps = null) {
  const need = (cond, reason, detail) => (cond ? available({}) : unavailable(reason, detail))
  const track = (key, reason, detail) => {
    if (!trackCaps) return unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION, 'open a session to probe the device')
    return trackCaps[key].available ? available({ ...trackCaps[key] }) : unavailable(reason, detail ?? trackCaps[key].detail)
  }
  return Object.freeze({
    capture: need(browser.getUserMedia, CAMERA_UNAVAILABLE.NO_MEDIA_DEVICES),
    stillTakePhoto: need(browser.imageCapture, CAMERA_UNAVAILABLE.NO_IMAGE_CAPTURE,
      'falls back to grabFrame/canvas — stream resolution, not sensor resolution'),
    hdr: track('exposureCompensation', CAMERA_UNAVAILABLE.NO_EXPOSURE_CONTROL,
      'bracketing needs a real exposureCompensation range'),
    night: need(browser.getUserMedia, CAMERA_UNAVAILABLE.NO_MEDIA_DEVICES),
    portrait: unavailable(CAMERA_UNAVAILABLE.NO_SEGMENTER_REGISTERED,
      'register an ISegmenter engine (owner decision: MediaPipe dep or P10 native depth)'),
    burst: need(browser.getUserMedia, CAMERA_UNAVAILABLE.NO_MEDIA_DEVICES),
    video: need(browser.mediaRecorder, CAMERA_UNAVAILABLE.NO_RECORDER),
    slowmo: !browser.webCodecs.videoEncoder && !browser.mediaRecorder
      ? unavailable(CAMERA_UNAVAILABLE.NO_WEBCODECS, 'no re-timing path (WebCodecs or recorder replay)')
      : track('highFps', CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE),
    timelapse: need(browser.mediaRecorder || browser.webCodecs.videoEncoder,
      CAMERA_UNAVAILABLE.NO_RECORDER, 'no assembly path (WebCodecs or recorder replay)'),
    stabilization: available({ tier: 'TIER_BASIC' }),
    proControls: trackCaps
      ? available({})
      : unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION, 'open a session to probe the device'),
    raw: rawCapability(),
  })
}
