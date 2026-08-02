/**
 * Proves the createArBeauty factory: INERT by default with full shape parity,
 * per-capability gating once lit, real wiring for the on-device legs (tier-0
 * beauty, the face-tracking box adapter + smoother), and every landmark-/
 * hand-/world-gated leg holding its honest refusal until an owner-approved
 * engine exists.
 *
 *   node test/ar-engine.test.js
 */
import { createArBeauty } from '../src/lib/ar/engine.js'
import { AR_UNAVAILABLE } from '../src/lib/ar/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const manualClock = { now: () => 0 }
const boxTracker = { id: 'fake-box', capabilities: { boxes: true, landmarks: null }, track: async () => ({ faces: [], ts: 0 }) }
const meshTracker = { id: 'fake-mesh', capabilities: { boxes: true, landmarks: ['leftEyeTop', 'mouthLeft'] }, track: async () => ({ faces: [], ts: 0 }) }
const faceDetectorEnv = { FaceDetector: class { async detect () { return [] } } }
const noDetectorEnv = {}
const allOn = {
  AI_CAMERA_ENABLED: true, AR_BEAUTY_ENABLED: true,
  AR_FACE_TRACKING_ENABLED: true, AR_GESTURES_ENABLED: true, AR_MASKS_ENABLED: true,
  AR_WORLD_ENABLED: true, BEAUTY_ENABLED: true, BEAUTY_ADVANCED_ENABLED: true,
}

/* --------------------------------------------------------- inert stub ---- */

{
  const ar = createArBeauty({ flags: {}, env: new Proxy({}, { get () { throw new Error('probed while dark') } }) })
  check('DEFAULT factory is inert: enabled false, no env read', ar.enabled === false)

  check('every capability of the inert stub answers FLAG_DISABLED', await (async () => {
    const answers = [
      ar.availability(),
      ar.faceTracking.availability(), ar.faceTracking.register(boxTracker),
      ar.faceTracking.useShapeDetection(), await ar.faceTracking.track({}),
      ar.landmarks.availability(),
      ar.beauty.availability(), ar.beauty.stages({}), ar.beauty.advanced.availability(),
      ar.gestures.availability(), ar.masks.availability(), ar.world.availability(),
    ]
    return answers.every((a) => a && a.available === false && a.reason === AR_UNAVAILABLE.FLAG_DISABLED)
  })())
}

check('inert and live share the SAME method shape (no dark-stub parity gap)', (() => {
  const dark = createArBeauty({ flags: {} })
  const live = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  const shape = (o) => Object.keys(o).filter((k) => typeof o[k] === 'object' && o[k] !== null)
    .map((ns) => `${ns}:${Object.keys(o[ns]).sort().join(',')}`).sort().join('|')
  return shape(dark) === shape(live)
})())

/* --------------------------------------------------- live, on-device ----- */

check('beauty tier-0 is wired: three valid pipeline stages with GLSL twins', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  const stages = ar.beauty.stages({ smooth: 0.5 })
  return Array.isArray(stages) && stages.length === 3 &&
    stages.every((s) => typeof s.cpu === 'function' && s.glsl?.fragment.includes('#version 300 es'))
})())

check('beauty.limits exposes the naturalness caps', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  return ar.beauty.limits().BRIGHTEN_MAX_LIFT === 0.30
})())

check('faceTracking.useShapeDetection registers the platform box adapter when FaceDetector exists', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  const r = ar.faceTracking.useShapeDetection()
  return r.available === true && ar.faceTracking.active()?.id === 'shape-detection'
})())

check('faceTracking.useShapeDetection is NO_PLATFORM_FACE_DETECTOR without the API', (() => {
  const ar = createArBeauty({ flags: allOn, env: noDetectorEnv, clock: manualClock })
  const r = ar.faceTracking.useShapeDetection()
  return r.available === false && r.reason === AR_UNAVAILABLE.NO_PLATFORM_FACE_DETECTOR
})())

check('a registered box tracker becomes active; track() returns the vocabulary', await (async () => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  ar.faceTracking.register(boxTracker)
  const out = await ar.faceTracking.track({})
  return out.available === true && out.engine === 'fake-box'
})())

check('createSmoother returns a working smoother (feed → faces/ts)', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  const sm = ar.faceTracking.createSmoother()
  const out = sm.feed({ faces: [{ box: { x: 0, y: 0, width: 10, height: 10 }, conf: null }], ts: 1 })
  return Array.isArray(out.faces) && out.faces.length === 1 && typeof out.faces[0].trackId === 'number'
})())

/* --------------------------------------------------------- gating -------- */

check('a dark leaf under a lit master is FLAG_DISABLED (rollback wins)', (() => {
  const ar = createArBeauty({ flags: { ...allOn, BEAUTY_ENABLED: false }, env: faceDetectorEnv, clock: manualClock })
  const a = ar.beauty.availability()
  return a.available === false && a.reason === AR_UNAVAILABLE.FLAG_DISABLED
})())

/* -------------------------------------------- landmark / hand / world ---- */

check('advanced beauty is NO_LANDMARK_ENGINE until a landmark engine is registered', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  const before = ar.beauty.advanced.availability()
  ar.faceTracking.register(meshTracker)
  const after = ar.beauty.advanced.availability()
  return before.reason === AR_UNAVAILABLE.NO_LANDMARK_ENGINE && after.available === true
})())

check('masks report NO_LANDMARK_ENGINE (never a box-anchored fake)', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  return ar.masks.availability().reason === AR_UNAVAILABLE.NO_LANDMARK_ENGINE
})())

check('gestures report NO_HAND_ENGINE (owner dependency, not built)', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  return ar.gestures.availability().reason === AR_UNAVAILABLE.NO_HAND_ENGINE
})())

check('world AR is DEFERRED_WEBXR (no simulated planes)', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  return ar.world.availability().reason === AR_UNAVAILABLE.DEFERRED_WEBXR
})())

check('availability() map reports every capability with the right verdict', (() => {
  const ar = createArBeauty({ flags: allOn, env: faceDetectorEnv, clock: manualClock })
  const m = ar.availability()
  return m.beauty.available === true &&
    m.advancedBeauty.reason === AR_UNAVAILABLE.NO_LANDMARK_ENGINE &&
    m.gestures.reason === AR_UNAVAILABLE.NO_HAND_ENGINE &&
    m.world.reason === AR_UNAVAILABLE.DEFERRED_WEBXR
})())

console.log('\n========================================')
console.log('  ar/beauty engine — inert dark, gated live, seams honest')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
