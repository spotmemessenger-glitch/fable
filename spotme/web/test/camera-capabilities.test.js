/**
 * Proves the capability probe answers HONESTLY on three simulated platforms.
 *
 * The camera engine's contract is qr-scan.js's contract writ large: where a
 * platform cannot do something, say UNAVAILABLE with a machine-readable
 * reason — never a degraded fake. So this matrix pins, per platform, exactly
 * which features report real and which report which reason:
 *
 *   Android-Chrome-like  full caps: torch, zoom, exposure, 240fps, ImageCapture
 *   iOS-Safari-like      minimal: no ImageCapture, no exposure, 60fps ceiling
 *   desktop-like         middle: ImageCapture but no torch/exposure, 60fps
 *
 *   node --test-reporter=spec test/camera-capabilities.test.js  (plain node)
 */
import {
  probeBrowser, probeTrack, probeWebGL2, featureAvailability, rawCapability,
} from '../src/lib/camera/capabilities.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { androidChromeLike, iosSafariLike, desktopLike } from './helpers/fake-media.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

async function openBack (env) {
  const stream = await env.navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
  return stream.getVideoTracks()[0]
}

/* ------------------------------------------------ 1. browser probe -------- */

{
  const android = probeBrowser(androidChromeLike())
  const ios = probeBrowser(iosSafariLike())
  const desktop = probeBrowser(desktopLike())

  check('Android-like: ImageCapture, WebCodecs, track processor all present',
    android.imageCapture && android.webCodecs.videoEncoder && android.trackProcessor)
  check('iOS-like: NO ImageCapture, NO WebCodecs, NO track processor — and the probe says so',
    !ios.imageCapture && !ios.webCodecs.videoEncoder && !ios.trackProcessor)
  check('desktop-like: ImageCapture and WebCodecs present',
    desktop.imageCapture && desktop.webCodecs.videoEncoder)
  check('all three report MediaRecorder', android.mediaRecorder && ios.mediaRecorder && desktop.mediaRecorder)
  check('a bare Node environment reports nothing, not an exception', (() => {
    const p = probeBrowser({})
    return p.mediaDevices === false && p.imageCapture === false && p.webCodecs.videoEncoder === false
  })())
}

/* ------------------------------------------------ 2. track probe ---------- */

await checkAsync('Android back camera: torch, zoom range, exposure compensation, 240fps ALL real', async () => {
  const caps = probeTrack(await openBack(androidChromeLike()))
  return caps.torch.available === true &&
    caps.zoom.available === true && caps.zoom.min === 1 && caps.zoom.max === 8 &&
    caps.exposureCompensation.available === true && caps.exposureCompensation.min === -3 &&
    caps.iso.available === true &&
    caps.highFps.available === true && caps.highFps.max === 240
})

await checkAsync('iOS back camera: torch/zoom/exposure each UNAVAILABLE with NOT_IN_TRACK_CAPABILITIES', async () => {
  const caps = probeTrack(await openBack(iosSafariLike()))
  return [caps.torch, caps.zoom, caps.exposureCompensation, caps.iso].every(
    (c) => c.available === false && c.reason === CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES)
})

await checkAsync('iOS 60fps ceiling: high-fps is UNAVAILABLE and NAMES the measured ceiling', async () => {
  const caps = probeTrack(await openBack(iosSafariLike()))
  return caps.highFps.available === false &&
    caps.highFps.reason === CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE &&
    /60fps/.test(caps.highFps.detail)
})

await checkAsync('desktop webcam: no torch, no exposure control, 60fps — honestly reported', async () => {
  const env = desktopLike()
  const stream = await env.navigator.mediaDevices.getUserMedia({ video: {} })
  const caps = probeTrack(stream.getVideoTracks()[0])
  return caps.torch.available === false && caps.exposureCompensation.available === false &&
    caps.frameRate.available === true && caps.frameRate.max === 60 && caps.highFps.available === false
})

check('no track at all: every capability answers NO_ACTIVE_SESSION, none throws', (() => {
  const caps = probeTrack(null)
  return Object.entries(caps).every(([key, c]) => key === 'raw' || (c.available === false && c.reason === CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION))
})())

check('RAW is DEFERRED_NATIVE everywhere — the web has no sensor-RAW path, and no path pretends to be one', (() => {
  const raw = rawCapability()
  return raw.available === false && raw.reason === CAMERA_UNAVAILABLE.DEFERRED_NATIVE && /P10/.test(raw.detail)
})())

/* ------------------------------------------- 3. feature availability ------ */

await checkAsync('Android matrix: HDR real, slow-mo real, takePhoto real', async () => {
  const env = androidChromeLike()
  const features = featureAvailability(probeBrowser(env), probeTrack(await openBack(env)))
  return features.hdr.available === true && features.slowmo.available === true &&
    features.stillTakePhoto.available === true && features.video.available === true
})

await checkAsync('iOS matrix: HDR = NO_EXPOSURE_CONTROL, slow-mo = NO_HIGH_FPS_MODE, still = NO_IMAGE_CAPTURE', async () => {
  const env = iosSafariLike()
  const features = featureAvailability(probeBrowser(env), probeTrack(await openBack(env)))
  return features.hdr.reason === CAMERA_UNAVAILABLE.NO_EXPOSURE_CONTROL &&
    features.slowmo.reason === CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE &&
    features.stillTakePhoto.reason === CAMERA_UNAVAILABLE.NO_IMAGE_CAPTURE &&
    features.night.available === true && features.video.available === true
})

await checkAsync('desktop matrix: HDR honestly off (no exposure), timelapse and video on', async () => {
  const env = desktopLike()
  const stream = await env.navigator.mediaDevices.getUserMedia({ video: {} })
  const features = featureAvailability(probeBrowser(env), probeTrack(stream.getVideoTracks()[0]))
  return features.hdr.available === false && features.timelapse.available === true &&
    features.video.available === true && features.stillTakePhoto.available === true
})

check('portrait is NO_SEGMENTER_REGISTERED by default on EVERY platform — a segmenter is never faked', (() => {
  const platforms = [androidChromeLike(), iosSafariLike(), desktopLike()]
  return platforms.every((env) => {
    const f = featureAvailability(probeBrowser(env), null)
    return f.portrait.available === false && f.portrait.reason === CAMERA_UNAVAILABLE.NO_SEGMENTER_REGISTERED
  })
})())

check('without a live track, track-dependent features say NO_ACTIVE_SESSION rather than guessing', (() => {
  const f = featureAvailability(probeBrowser(androidChromeLike()), null)
  return f.hdr.reason === CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION &&
    f.proControls.reason === CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION
})())

check('stabilization is TIER_BASIC — advanced/gyro is not claimed', (() => {
  const f = featureAvailability(probeBrowser(iosSafariLike()), null)
  return f.stabilization.available === true && f.stabilization.tier === 'TIER_BASIC'
})())

/* ------------------------------------------------ 4. WebGL2 probe --------- */

check('WebGL2 probe with no canvas source is UNAVAILABLE, not a throw', (() => {
  const p = probeWebGL2({})
  return p.available === false && p.reason === CAMERA_UNAVAILABLE.NO_WEBGL2
})())

check('WebGL2 probe against a refusing canvas is UNAVAILABLE with detail', (() => {
  const p = probeWebGL2({}, { getContext: () => null })
  return p.available === false && /refused/.test(p.detail)
})())

check('WebGL2 probe against a working context reports available + texture size', (() => {
  const gl = { MAX_TEXTURE_SIZE: 3379, getParameter: (k) => (k === 3379 ? 8192 : null) }
  const p = probeWebGL2({}, { getContext: (kind) => (kind === 'webgl2' ? gl : null) })
  return p.available === true && p.maxTextureSize === 8192
})())

console.log('\n========================================')
console.log('  camera capabilities — three platforms, zero pretending')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
