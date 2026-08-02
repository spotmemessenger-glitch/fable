/**
 * Proves the IFaceTracker seam: contract validation, the registry (with the
 * landmark-engine slot honestly EMPTY), the result runner's crash safety,
 * and the Shape-Detection adapter's per-platform truth.
 *
 *   node test/ar-trackers.test.js
 */
import {
  LANDMARK_NAMES, validateFaceTracker, createTrackerRegistry, trackFaces,
} from '../src/lib/ar/trackers.js'
import { shapeDetectionAvailability, createShapeDetectionTracker } from '../src/lib/ar/shape-detection.js'
import { AR_UNAVAILABLE } from '../src/lib/ar/availability.js'
import { manualClock } from '../src/lib/camera/clock.js'
import { facePose, fixtureLandmarkTracker, fixtureBoxTracker, envWithFaceDetector, RECORDED_BOX_SEQUENCE } from './helpers/ar-fixtures.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* ------------------------------------------------ 1. contract validation - */

const goodBoxTracker = fixtureBoxTracker([[]])
const goodLandmarkTracker = fixtureLandmarkTracker([[]])

check('a boxes-only tracker validates', validateFaceTracker(goodBoxTracker) === null)
check('a landmark tracker validates', validateFaceTracker(goodLandmarkTracker) === null)
check('missing id is refused', validateFaceTracker({ ...goodBoxTracker, id: '' }) !== null)
check('capabilities.boxes !== true is refused (a face tracker that cannot box faces is not one)',
  validateFaceTracker({ ...goodBoxTracker, capabilities: { boxes: false, landmarks: null } }) !== null)
check('an EMPTY landmarks array is refused — declare null or real names',
  validateFaceTracker({ ...goodBoxTracker, capabilities: { boxes: true, landmarks: [] } }) !== null)
check('an unknown landmark name is refused', (() => {
  const problem = validateFaceTracker({ ...goodBoxTracker, capabilities: { boxes: true, landmarks: ['thirdEye'] } })
  return /thirdEye/.test(problem || '')
})())
check('missing track() is refused', validateFaceTracker({ ...goodBoxTracker, track: null }) !== null)
check('the canonical landmark vocabulary is frozen and covers eyes/mouth/jaw/cheeks',
  Object.isFrozen(LANDMARK_NAMES) &&
  ['leftEyeTop', 'rightEyeBottom', 'mouthLeft', 'upperLipTop', 'lowerLipBottom', 'jawLeft', 'leftCheek', 'foreheadCenter']
    .every((n) => LANDMARK_NAMES.includes(n)))

/* -------------------------------------------------------- 2. registry ---- */

{
  const registry = createTrackerRegistry()
  check('an empty registry answers NO_FACE_TRACKER', (() => {
    const a = registry.availability()
    return a.available === false && a.reason === AR_UNAVAILABLE.NO_FACE_TRACKER
  })())
  check('the landmark SLOT is honestly empty: NO_LANDMARK_ENGINE naming the owner decision', (() => {
    const a = registry.landmarkAvailability()
    return a.available === false && a.reason === AR_UNAVAILABLE.NO_LANDMARK_ENGINE &&
      /owner dependency decision/i.test(a.detail) && /MediaPipe/i.test(a.detail)
  })())

  const boxReg = registry.register(fixtureBoxTracker([[]], { id: 'boxes' }))
  check('registering a valid box engine succeeds', boxReg.available === true && boxReg.engine === 'boxes')
  check('a registered box engine still leaves the landmark slot EMPTY (never approximated)',
    registry.landmarkAvailability().available === false && registry.landmarkEngine() === null)
  check('duplicate ids are refused', registry.register(fixtureBoxTracker([[]], { id: 'boxes' })).available === false)
  check('an invalid engine is refused with the problem named', (() => {
    const r = registry.register({ id: 'bad', capabilities: { boxes: true, landmarks: null } })
    return r.available === false && /track/.test(r.detail)
  })())

  registry.register(fixtureLandmarkTracker([[]], { id: 'landmarks' }))
  check('with both engines, active() prefers the landmark-richer one',
    registry.active().id === 'landmarks')
  check('…and the landmark slot reports it', (() => {
    const a = registry.landmarkAvailability()
    return a.available === true && a.engine === 'landmarks' && a.landmarks.includes('mouthLeft')
  })())
  check('availability lists every engine and the active one', (() => {
    const a = registry.availability()
    return a.available === true && a.engines.join(',') === 'boxes,landmarks' && a.active === 'landmarks'
  })())
  check('list() exposes frozen capability snapshots', (() => {
    const listed = registry.list()
    return listed.length === 2 && Object.isFrozen(listed[0]) && Object.isFrozen(listed[0].capabilities)
  })())

  let released = false
  registry.register({ ...fixtureBoxTracker([[]], { id: 'releasable' }), release: () => { released = true } })
  check('unregister releases the engine', registry.unregister('releasable').available === true && released === true)
  check('unregistering an unknown id is a named refusal', registry.unregister('ghost').available === false)
}

/* --------------------------------------------- 3. the result runner ------ */

await (async () => {
  const face = facePose('neutral')
  const good = await trackFaces(fixtureLandmarkTracker([[face]]), { width: 320, height: 240 })
  check('a well-formed engine result passes through with engine named and ts stamped',
    good.available === true && good.faces.length === 1 && good.engine === 'fixture-landmarks' &&
    typeof good.ts === 'number' && good.faces[0].landmarks.mouthLeft.x < good.faces[0].landmarks.mouthRight.x)

  const thrower = { id: 'thrower', capabilities: { boxes: true, landmarks: null }, track: async () => { throw new Error('model exploded') } }
  const threw = await trackFaces(thrower, {})
  check('a THROWING engine becomes FAILED with the engine named — capture never crashes',
    threw.available === false && threw.reason === AR_UNAVAILABLE.FAILED && /thrower.*model exploded/.test(threw.detail))

  const malformed = { id: 'liar', capabilities: { boxes: true, landmarks: null }, track: async () => ({ faces: [{ box: { x: 0, y: 0, width: -5, height: 10 }, conf: null }], ts: 1 }) }
  const bad = await trackFaces(malformed, {})
  check('a malformed box is refused with the engine named',
    bad.available === false && /liar/.test(bad.detail))

  const undeclared = { id: 'sneaky', capabilities: { boxes: true, landmarks: null }, track: async () => ({ faces: [{ box: { x: 0, y: 0, width: 10, height: 10 }, conf: null, landmarks: { mouthLeft: { x: 1, y: 1 } } }], ts: 1 }) }
  const sneaky = await trackFaces(undeclared, {})
  check('landmarks from an engine that DECLARED none are refused — capabilities are a promise',
    sneaky.available === false && /declares no landmarks/.test(sneaky.detail))

  const badConf = { id: 'confused', capabilities: { boxes: true, landmarks: null }, track: async () => ({ faces: [{ box: { x: 0, y: 0, width: 10, height: 10 }, conf: 7 }], ts: 1 }) }
  check('conf outside 0..1 is refused', (await trackFaces(badConf, {})).available === false)
  check('no tracker at all answers NO_FACE_TRACKER',
    (await trackFaces(null, {})).reason === AR_UNAVAILABLE.NO_FACE_TRACKER)
})()

/* ------------------------------------- 4. Shape-Detection per-platform --- */

await (async () => {
  const safariLike = {}                                    // no FaceDetector — Safari/Firefox truth
  const probe = shapeDetectionAvailability(safariLike)
  check('Safari/Firefox-like env: honest NO_PLATFORM_FACE_DETECTOR with the reason spelled out',
    probe.available === false && probe.reason === AR_UNAVAILABLE.NO_PLATFORM_FACE_DETECTOR &&
    /Safari and Firefox do not/.test(probe.detail))
  check('…and the factory answers the same, constructing nothing',
    createShapeDetectionTracker({ env: safariLike, clock: manualClock() }).available === false)

  const calls = []
  const env = envWithFaceDetector(RECORDED_BOX_SEQUENCE, calls)
  check('Chromium/Android-like env: the API is detected', shapeDetectionAvailability(env).available === true)

  const clock = manualClock(1000)
  const made = createShapeDetectionTracker({ env, clock, maxDetectedFaces: 3 })
  check('the adapter builds and passes platform options through',
    made.available === true && calls[0].constructed.maxDetectedFaces === 3 && calls[0].constructed.fastMode === true)
  check('the adapter IS a valid IFaceTracker', validateFaceTracker(made.tracker) === null)
  check('the adapter promises boxes ONLY — platform landmarks are not guaranteed, so none are promised',
    made.tracker.capabilities.landmarks === null)

  const frame = { width: 320, height: 240 }
  const tracked = await trackFaces(made.tracker, frame)
  check('track() maps DetectedFace.boundingBox to the seam box shape', (() => {
    const face = tracked.faces[0]
    const expected = RECORDED_BOX_SEQUENCE[0][0]
    return tracked.available === true && face.box.x === expected.x && face.box.width === expected.width
  })())
  check('conf is NULL — the platform reports no confidence and none is invented',
    tracked.faces[0].conf === null)
  check('ts comes from the injected clock', tracked.ts === 1000)
  check('the frame is handed to the platform detector untouched', calls[1].detect === frame)

  const dropout = await trackFaces(made.tracker, frame)     // frame 2
  check('a platform result with N faces yields N seam faces', dropout.faces.length === 1)

  check('a missing clock is refused, not defaulted — determinism is the contract',
    createShapeDetectionTracker({ env }).available === false)

  const brokenEnv = { FaceDetector: class { constructor () { throw new Error('no hardware detector') } } }
  const broken = createShapeDetectionTracker({ env: brokenEnv, clock })
  check('a throwing platform constructor becomes FAILED with the cause',
    broken.available === false && broken.reason === AR_UNAVAILABLE.FAILED && /no hardware detector/.test(broken.detail))

  const detectThrows = { FaceDetector: class { async detect () { throw new Error('detach') } } }
  const t2 = createShapeDetectionTracker({ env: detectThrows, clock })
  const failed = await trackFaces(t2.tracker, frame)
  check('a throwing detect() becomes FAILED through the runner, engine named',
    failed.available === false && /shape-detection.*detach/.test(failed.detail))
})()

/* ------------------------------------------------------------- report ---- */

console.log('\n========================================')
console.log('  ar trackers — seam, registry, per-platform truth')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
