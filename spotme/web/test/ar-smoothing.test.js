/**
 * Proves the temporal smoothing layer on RECORDED fixture sequences:
 * jitter genuinely shrinks, identity is sticky through dropouts
 * (hysteresis), landmarks smooth alongside boxes, and bad configs fail
 * loudly.
 *
 *   node test/ar-smoothing.test.js
 */
import { createFaceSmoother, SMOOTHER_DEFAULTS } from '../src/lib/ar/smoothing.js'
import { iou } from '../src/lib/ar/armath.js'
import { RECORDED_BOX_SEQUENCE, noisyFaceSequence, facePose } from './helpers/ar-fixtures.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const variance = (xs) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  return xs.reduce((a, x) => a + (x - mean) ** 2, 0) / xs.length
}
// Remove the linear drift so the metric is pure jitter.
const detrend = (xs) => xs.map((x, i) => x - (xs[0] + (xs[xs.length - 1] - xs[0]) * (i / (xs.length - 1))))

/* ------------------------------- 1. the recorded box track (committed) --- */

{
  const smoother = createFaceSmoother()
  const rawX = []
  const outX = []
  const ids = new Set()
  let heldFrames = 0
  for (let f = 0; f < RECORDED_BOX_SEQUENCE.length; f++) {
    const faces = RECORDED_BOX_SEQUENCE[f].map((box) => ({ box, conf: null }))
    const out = smoother.feed({ faces, ts: f * 33 })
    if (faces.length) rawX.push(faces[0].box.x)
    if (out.faces.length) {
      outX.push(out.faces[0].box.x)
      ids.add(out.faces[0].trackId)
      if (out.faces[0].held) heldFrames++
    }
  }
  check('RECORDED sequence: ONE stable trackId across all 14 frames including the dropout',
    ids.size === 1)
  check('the frame-8 dropout is COASTED (held=true), not a track death',
    heldFrames >= 1)
  check('box jitter variance shrinks by at least 40% after EMA (detrended)',
    variance(detrend(outX)) < variance(detrend(rawX)) * 0.6)
}

/* ----------------------------------- 2. seeded landmark jitter shrinks --- */

{
  const frames = noisyFaceSequence({ frames: 40, seed: 11 })
  const smoother = createFaceSmoother()
  const rawNose = []
  const outNose = []
  const ids = new Set()
  for (const frame of frames) {
    const out = smoother.feed(frame)
    rawNose.push(frame.faces[0].landmarks.noseTip.x)
    outNose.push(out.faces[0].landmarks.noseTip.x)
    ids.add(out.faces[0].trackId)
  }
  check('40-frame seeded track keeps one identity', ids.size === 1)
  check('landmark jitter variance shrinks by at least 30% (detrended)',
    variance(detrend(outNose)) < variance(detrend(rawNose)) * 0.7)
  check('smoothed landmarks stay geometrically sane (mouth left of mouth right)', (() => {
    const last = createFaceSmootherRun(frames)
    return last.landmarks.mouthLeft.x < last.landmarks.mouthRight.x
  })())
}

function createFaceSmootherRun (frames) {
  const s = createFaceSmoother()
  let out = null
  for (const frame of frames) out = s.feed(frame)
  return out.faces[0]
}

/* --------------------------------------------- 3. EMA convergence math --- */

{
  const smoother = createFaceSmoother({ alpha: 0.5 })
  const boxA = { x: 0, y: 0, width: 100, height: 100 }
  const boxB = { x: 40, y: 0, width: 100, height: 100 }        // IoU 0.43 — same face
  smoother.feed({ faces: [{ box: boxA, conf: 1 }], ts: 0 })
  const step = smoother.feed({ faces: [{ box: boxB, conf: 1 }], ts: 33 })
  check('EMA halves the gap at alpha 0.5 (x: 0 → 20 exactly)',
    step.faces[0].box.x === 20)
  let last = step
  for (let i = 0; i < 20; i++) last = smoother.feed({ faces: [{ box: boxB, conf: 1 }], ts: 66 + i * 33 })
  check('EMA converges onto a steady input', Math.abs(last.faces[0].box.x - 40) < 0.1)
  check('alpha 1 disables smoothing (raw passthrough)', (() => {
    const s = createFaceSmoother({ alpha: 1 })
    s.feed({ faces: [{ box: boxA, conf: 1 }], ts: 0 })
    return s.feed({ faces: [{ box: boxB, conf: 1 }], ts: 33 }).faces[0].box.x === 40
  })())
}

/* ------------------------------------------- 4. identity hysteresis ------ */

{
  // Two well-separated faces must keep DISTINCT stable ids.
  const s = createFaceSmoother()
  const left = () => ({ box: { x: 10, y: 10, width: 80, height: 100 }, conf: 1 })
  const right = () => ({ box: { x: 220, y: 12, width: 82, height: 98 }, conf: 1 })
  const first = s.feed({ faces: [left(), right()], ts: 0 })
  const idByX = (out) => [...out.faces].sort((a, b) => a.box.x - b.box.x).map((f) => f.trackId)
  const initial = idByX(first)
  let stable = true
  for (let f = 1; f < 10; f++) {
    // Reverse the array order each frame — ids must follow GEOMETRY, not index.
    const faces = f % 2 ? [right(), left()] : [left(), right()]
    const out = s.feed({ faces, ts: f * 33 })
    if (idByX(out).join(',') !== initial.join(',')) stable = false
  }
  check('two faces keep distinct ids even when the tracker reorders its array', stable && initial[0] !== initial[1])

  // Disappearance: coast exactly holdFrames, then drop; reappearance within
  // the hold keeps the id, after the drop mints a new one.
  const s2 = createFaceSmoother({ holdFrames: 2 })
  const face = () => ({ box: { x: 50, y: 50, width: 100, height: 100 }, conf: 1 })
  const id0 = s2.feed({ faces: [face()], ts: 0 }).faces[0].trackId
  const miss1 = s2.feed({ faces: [], ts: 33 })
  const miss2 = s2.feed({ faces: [], ts: 66 })
  check('a vanished face is coasted with held=true and its geometry intact',
    miss1.faces.length === 1 && miss1.faces[0].held === true && miss1.faces[0].trackId === id0 &&
    miss2.faces.length === 1)
  const back = s2.feed({ faces: [face()], ts: 99 })
  check('reappearing WITHIN the hold window keeps the same trackId (hysteresis)',
    back.faces.length === 1 && back.faces[0].trackId === id0 && back.faces[0].held === false)
  s2.feed({ faces: [], ts: 132 })
  s2.feed({ faces: [], ts: 165 })
  const gone = s2.feed({ faces: [], ts: 198 })
  check('after holdFrames misses the track is dropped', gone.faces.length === 0 && s2.trackCount() === 0)
  const reborn = s2.feed({ faces: [face()], ts: 231 })
  check('a face returning AFTER the drop is a new identity', reborn.faces[0].trackId !== id0)
}

{
  // IoU sanity anchors the matcher's threshold semantics.
  const a = { x: 0, y: 0, width: 100, height: 100 }
  check('iou: identical boxes = 1, disjoint = 0, half-overlap ≈ 1/3',
    iou(a, a) === 1 &&
    iou(a, { x: 500, y: 0, width: 100, height: 100 }) === 0 &&
    Math.abs(iou(a, { x: 50, y: 0, width: 100, height: 100 }) - 1 / 3) < 1e-9)
}

/* ------------------------------------------------- 5. loud config edges -- */

{
  const throws = (fn, re) => { try { fn(); return false } catch (e) { return re.test(e.message) } }
  check('alpha 0 is refused', throws(() => createFaceSmoother({ alpha: 0 }), /alpha/))
  check('alpha > 1 is refused', throws(() => createFaceSmoother({ alpha: 1.2 }), /alpha/))
  check('negative holdFrames is refused', throws(() => createFaceSmoother({ holdFrames: -1 }), /holdFrames/))
  check('an unknown option is refused by NAME (no silent typo)',
    throws(() => createFaceSmoother({ holdFrame: 2 }), /unknown smoother option: holdFrame/))
  check('defaults are frozen and sane',
    Object.isFrozen(SMOOTHER_DEFAULTS) && SMOOTHER_DEFAULTS.alpha > 0 && SMOOTHER_DEFAULTS.holdFrames >= 1)
  check('reset() clears every track', (() => {
    const s = createFaceSmoother()
    s.feed({ faces: [{ box: { x: 0, y: 0, width: 10, height: 10 }, conf: 1 }], ts: 0 })
    s.reset()
    return s.trackCount() === 0
  })())
  check('a landmark face smooths without crashing when landmarks vanish mid-track', (() => {
    const s = createFaceSmoother()
    const withLm = facePose('neutral')
    s.feed({ faces: [withLm], ts: 0 })
    const out = s.feed({ faces: [{ box: { ...withLm.box }, conf: 1 }], ts: 33 })
    // Landmarks persist from the last frame that had them (coasting geometry).
    return out.faces[0].landmarks !== null
  })())
}

/* ------------------------------------------------------------- report ---- */

console.log('\n========================================')
console.log('  ar smoothing — EMA + identity hysteresis on recorded tracks')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
