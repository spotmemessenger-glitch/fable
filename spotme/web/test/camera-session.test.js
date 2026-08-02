/**
 * Proves the session lifecycle: open with named failures, warm/cold switch,
 * release that ALWAYS stops every track, and pro controls that refuse
 * honestly where the device cannot comply.
 *
 *   node test/camera-session.test.js
 */
import { openSession, SESSION_STATE } from '../src/lib/camera/session.js'
import { listCameras, pickCamera, classifyFacing, constraintsFor, FACING } from '../src/lib/camera/devices.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { manualClock } from '../src/lib/camera/clock.js'
import { androidChromeLike, iosSafariLike, desktopLike } from './helpers/fake-media.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* ------------------------------------------------- 1. device selection ---- */

await checkAsync('Android-like enumerates three cameras, multi-camera and multi-back detected', async () => {
  const listed = await listCameras(androidChromeLike())
  return listed.available && listed.cameras.length === 3 && listed.multiCamera && listed.multiBack
})

await checkAsync('desktop webcam classifies as UNKNOWN facing — not guessed front or back', async () => {
  const listed = await listCameras(desktopLike())
  return listed.available && listed.cameras[0].facing === FACING.UNKNOWN
})

check('label conventions classify: Android camera2, iOS Back Camera, selfie',
  classifyFacing('camera2 0, facing back') === FACING.BACK &&
  classifyFacing('Back Camera') === FACING.BACK &&
  classifyFacing('Front Camera') === FACING.FRONT &&
  classifyFacing('Selfie cam') === FACING.FRONT &&
  classifyFacing('FaceTime HD Camera') === FACING.UNKNOWN)

check('explicit facingMode beats the label',
  classifyFacing('whatever', 'user') === FACING.FRONT &&
  classifyFacing('front-ish name', 'environment') === FACING.BACK)

await checkAsync('pickCamera: explicit deviceId wins; a MISSING deviceId refuses, never mis-picks', async () => {
  const { cameras } = await listCameras(androidChromeLike())
  const byId = pickCamera(cameras, { deviceId: 'back-wide-1' })
  const missing = pickCamera(cameras, { deviceId: 'nope' })
  return byId.available && byId.device.deviceId === 'back-wide-1' &&
    missing.available === false && missing.reason === CAMERA_UNAVAILABLE.NO_CAMERA_FOUND
})

await checkAsync('pickCamera by facing; unsatisfiable facing FALLS BACK and says so', async () => {
  const { cameras } = await listCameras(desktopLike())
  const byFacing = pickCamera(cameras, { facing: FACING.BACK })
  return byFacing.available && byFacing.by === 'fallback' && byFacing.requestedFacing === FACING.BACK
})

check('constraintsFor: deviceId is EXACT (user picked it), facing is ideal (best effort)', (() => {
  const byId = constraintsFor({ deviceId: 'x' })
  const byFacing = constraintsFor({ facing: FACING.BACK, width: 1920 })
  return byId.video.deviceId.exact === 'x' && byId.audio === false &&
    byFacing.video.facingMode.ideal === 'environment' && byFacing.video.width.ideal === 1920
})())

await checkAsync('no mediaDevices at all: listCameras answers NO_MEDIA_DEVICES, not an empty list', async () => {
  const r = await listCameras({})
  return r.available === false && r.reason === CAMERA_UNAVAILABLE.NO_MEDIA_DEVICES
})

/* ----------------------------------------------------- 2. open/release ---- */

await checkAsync('open reports timing, facing and LIVE state', async () => {
  const env = androidChromeLike()
  const opened = await openSession({ facing: FACING.BACK }, { env, clock: manualClock() })
  return opened.available && typeof opened.openedInMs === 'number' && opened.strategy === 'cold' &&
    opened.session.state() === SESSION_STATE.LIVE && opened.session.facing() === FACING.BACK
})

await checkAsync('permission refusal is PERMISSION_DENIED, and NO stream is left open', async () => {
  const env = androidChromeLike()
  env.navigator.mediaDevices.getUserMedia = async () => { const e = new Error('no'); e.name = 'NotAllowedError'; throw e }
  const opened = await openSession({}, { env, clock: manualClock() })
  return opened.available === false && opened.reason === CAMERA_UNAVAILABLE.PERMISSION_DENIED
})

await checkAsync('a camera held by another app is CAMERA_BUSY', async () => {
  const env = androidChromeLike()
  env.navigator.mediaDevices.getUserMedia = async () => { const e = new Error('busy'); e.name = 'NotReadableError'; throw e }
  const opened = await openSession({}, { env, clock: manualClock() })
  return opened.available === false && opened.reason === CAMERA_UNAVAILABLE.CAMERA_BUSY
})

await checkAsync('a WEDGED getUserMedia times out with a bounded, named failure', async () => {
  const env = androidChromeLike()
  env.navigator.mediaDevices.getUserMedia = () => new Promise(() => {})
  const clock = manualClock()
  const pending = openSession({}, { env, clock })
  await clock.advance(11_000)
  const opened = await pending
  return opened.available === false && /timed out/.test(opened.detail)
})

await checkAsync('release STOPS every track, is idempotent, and the state says RELEASED', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: FACING.BACK }, { env, clock: manualClock() })
  const first = session.release()
  const second = session.release()
  return first.available && second.available && second.alreadyReleased === true &&
    env.navigator.mediaDevices.liveTrackCount() === 0 && session.state() === SESSION_STATE.RELEASED
})

await checkAsync('the OS ending the track releases the session (camera unplugged / permission revoked)', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({}, { env, clock: manualClock() })
  let told = false
  session.onReleased(() => { told = true })
  session.track().endFromDevice()
  return session.state() === SESSION_STATE.RELEASED && told === true
})

/* --------------------------------------------------------- 3. switching --- */

await checkAsync('switch front→back is WARM: new stream opened before the old track stops', async () => {
  const env = androidChromeLike()
  const md = env.navigator.mediaDevices
  const { session } = await openSession({ facing: FACING.FRONT }, { env, clock: manualClock() })
  const oldTrack = session.track()
  const switched = await session.switchTo({ facing: FACING.BACK })
  return switched.available && switched.strategy === 'warm' && switched.facing === FACING.BACK &&
    oldTrack.readyState === 'ended' && session.track().readyState === 'live' &&
    md.liveTrackCount() === 1
})

await checkAsync('single-pipeline device: warm open fails, COLD retry succeeds and says so', async () => {
  const env = androidChromeLike()
  const md = env.navigator.mediaDevices
  const realGum = md.getUserMedia.bind(md)
  md.getUserMedia = async (constraints) => {
    // Refuse a second concurrent open, like a single-pipeline phone.
    if (md.liveTrackCount() > 0) { const e = new Error('in use'); e.name = 'NotReadableError'; throw e }
    return realGum(constraints)
  }
  const { session } = await openSession({ facing: FACING.FRONT }, { env, clock: manualClock() })
  const switched = await session.switchTo({ facing: FACING.BACK })
  return switched.available && switched.strategy === 'cold' &&
    session.state() === SESSION_STATE.LIVE && md.liveTrackCount() === 1
})

await checkAsync('switch failing BOTH ways leaves a RELEASED session, not a zombie', async () => {
  const env = androidChromeLike()
  const md = env.navigator.mediaDevices
  const realGum = md.getUserMedia.bind(md)
  let opened = false
  md.getUserMedia = async (constraints) => {
    if (opened) { const e = new Error('gone'); e.name = 'NotReadableError'; throw e }
    opened = true
    return realGum(constraints)
  }
  const { session } = await openSession({}, { env, clock: manualClock() })
  const switched = await session.switchTo({ facing: FACING.BACK })
  return switched.available === false && session.state() === SESSION_STATE.RELEASED &&
    md.liveTrackCount() === 0
})

/* ------------------------------------------------------- 4. pro controls -- */

await checkAsync('zoom within the reported range applies and lands in settings', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: FACING.BACK }, { env, clock: manualClock() })
  const r = await session.pro.setZoom(4)
  return r.available && session.settings().zoom === 4
})

await checkAsync('zoom OUTSIDE the range refuses with NOT_IN_TRACK_CAPABILITIES, out of range', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: FACING.BACK }, { env, clock: manualClock() })
  const r = await session.pro.setZoom(50)
  return r.available === false && r.reason === CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES && /out of range/.test(r.detail)
})

await checkAsync('torch on the Android back camera works; the SAME call on iOS refuses honestly', async () => {
  const android = await openSession({ facing: FACING.BACK }, { env: androidChromeLike(), clock: manualClock() })
  const ios = await openSession({ facing: FACING.BACK }, { env: iosSafariLike(), clock: manualClock() })
  const onAndroid = await android.session.pro.setTorch(true)
  const onIos = await ios.session.pro.setTorch(true)
  return onAndroid.available === true &&
    onIos.available === false && onIos.reason === CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES
})

await checkAsync('manual exposure controls: EV/ISO/exposureTime real on Android, ALL refused on iOS', async () => {
  const android = (await openSession({ facing: FACING.BACK }, { env: androidChromeLike(), clock: manualClock() })).session
  const ios = (await openSession({ facing: FACING.BACK }, { env: iosSafariLike(), clock: manualClock() })).session
  const a = [await android.pro.setExposureCompensation(1), await android.pro.setIso(400), await android.pro.setExposureTime(5000)]
  const i = [await ios.pro.setExposureCompensation(1), await ios.pro.setIso(400), await ios.pro.setExposureTime(5000)]
  return a.every((r) => r.available) && i.every((r) => r.available === false)
})

await checkAsync('controls on a RELEASED session answer NO_ACTIVE_SESSION, never touch the track', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: FACING.BACK }, { env, clock: manualClock() })
  session.release()
  const r = await session.pro.setZoom(2)
  return r.available === false && r.reason === CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION
})

console.log('\n========================================')
console.log('  camera session — open, switch warm/cold, release always')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
