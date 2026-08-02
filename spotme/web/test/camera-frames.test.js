/**
 * Proves the FrameSource — THE seam missions 2–3 consume: honest pump
 * selection per platform, drop-oldest backpressure that closes every frame
 * exactly once, fps throttling, and a captureStill that LABELS its path.
 *
 *   node test/camera-frames.test.js
 */
import { openSession } from '../src/lib/camera/session.js'
import { createFrameSource, PUMP, STILL_PATH, pickPumpKind } from '../src/lib/camera/frame-source.js'
import { probeBrowser } from '../src/lib/camera/capabilities.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { manualClock } from '../src/lib/camera/clock.js'
import { androidChromeLike, iosSafariLike, FakeVideoFrame } from './helpers/fake-media.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}
/** Let the pump's microtask chain drain. */
const settle = () => new Promise((r) => setTimeout(r, 0))

async function androidSource () {
  const env = androidChromeLike()
  const clock = manualClock(1000)
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  return { env, clock, session, source }
}

/* -------------------------------------------------- 1. pump selection ----- */

check('Android-like picks the track-processor pump (zero-copy VideoFrames)',
  pickPumpKind(probeBrowser(androidChromeLike())) === PUMP.TRACK_PROCESSOR)
check('iOS-like picks the rVFC video pump',
  pickPumpKind(probeBrowser(iosSafariLike())) === PUMP.RVFC)
check('a DOM with neither track processor nor rVFC gets the interval-canvas pump',
  pickPumpKind(probeBrowser({ document: {}, navigator: {} })) === PUMP.INTERVAL_CANVAS)
check('bare Node has NO pump — and that is a named refusal, not a crash',
  pickPumpKind(probeBrowser({})) === null)

await checkAsync('subscribing in a pumpless environment answers NO_FRAME_PUMP', async () => {
  const env = androidChromeLike()
  delete env.MediaStreamTrackProcessor
  delete env.document
  delete env.HTMLVideoElement
  const { session } = await openSession({}, { env, clock: manualClock() })
  const source = createFrameSource(session, { env, clock: manualClock() })
  const sub = source.subscribeFrames(() => {})
  return sub.available === false && sub.reason === CAMERA_UNAVAILABLE.NO_FRAME_PUMP
})

/* ------------------------------------------------- 2. frame delivery ------ */

await checkAsync('track-processor pump delivers frames with seq, ts and media timestamps', async () => {
  const { session, source } = await androidSource()
  const got = []
  const sub = source.subscribeFrames((d) => { got.push(d) })
  await settle()
  session.track().emitFrame(new FakeVideoFrame({ timestamp: 33_000, width: 1280, height: 720 }))
  session.track().emitFrame(new FakeVideoFrame({ timestamp: 66_000, width: 1280, height: 720 }))
  await settle()
  sub.unsubscribe()
  return got.length === 2 && got[0].seq === 0 && got[1].seq === 1 &&
    got[0].mediaTs === 33 && got[1].mediaTs === 66 &&
    got[0].width === 1280 && typeof got[0].ts === 'number'
})

await checkAsync('a SLOW consumer gets drop-oldest: freshest frame next, dropped count visible', async () => {
  const { session, source } = await androidSource()
  const seen = []
  let releaseFirst
  const gate = new Promise((r) => { releaseFirst = r })
  const sub = source.subscribeFrames(async (d) => {
    seen.push({ seq: d.seq, dropped: d.dropped })
    if (seen.length === 1) await gate         // wedge on the first frame
  })
  await settle()
  const frames = [0, 1, 2, 3, 4].map((i) => new FakeVideoFrame({ timestamp: i * 1000 }))
  for (const f of frames) session.track().emitFrame(f)
  await settle()
  releaseFirst()
  await settle()
  sub.unsubscribe()
  // Delivered: frame 0 (in flight), then ONLY frame 4 with 3 drops recorded.
  return seen.length === 2 && seen[0].seq === 0 && seen[1].seq === 4 && seen[1].dropped === 3
})

await checkAsync('EVERY frame is closed exactly once — delivered and dropped alike', async () => {
  const { session, source } = await androidSource()
  let releaseFirst
  const gate = new Promise((r) => { releaseFirst = r })
  let first = true
  const sub = source.subscribeFrames(async () => {
    if (first) { first = false; await gate }
  })
  await settle()
  const frames = [0, 1, 2, 3, 4].map((i) => new FakeVideoFrame({ timestamp: i * 1000 }))
  for (const f of frames) session.track().emitFrame(f)
  await settle()
  releaseFirst()
  await settle()
  sub.unsubscribe()
  source.stop()
  return frames.every((f) => f.closed === true)
})

await checkAsync('fps throttling delivers at the requested rate, not the camera rate', async () => {
  const { session, source, clock } = await androidSource()
  const got = []
  const sub = source.subscribeFrames((d) => { got.push(d.seq) }, { fps: 10 })   // every 100ms
  await settle()
  for (let i = 0; i < 10; i++) {
    session.track().emitFrame(new FakeVideoFrame({ timestamp: i * 33_000 }))
    await settle()
    await clock.advance(33)                  // ~30fps camera
  }
  sub.unsubscribe()
  // 10 frames over ~330ms at 10fps → at most 4-5 deliveries, and NOT 10.
  return got.length >= 3 && got.length <= 5
})

await checkAsync('two subscribers see the SAME frames independently; one slow does not stall the other', async () => {
  const { session, source } = await androidSource()
  const fast = []
  const slow = []
  const subFast = source.subscribeFrames((d) => { fast.push(d.seq) })
  const subSlow = source.subscribeFrames(async (d) => { slow.push(d.seq); await new Promise((r) => setTimeout(r, 0)) })
  await settle()
  for (let i = 0; i < 3; i++) { session.track().emitFrame(new FakeVideoFrame({ timestamp: i })); await settle() }
  subFast.unsubscribe(); subSlow.unsubscribe()
  return fast.join(',') === '0,1,2' && slow.length >= 1
})

await checkAsync('unsubscribing the LAST consumer stops the pump; a released session stops the source', async () => {
  const { session, source } = await androidSource()
  const sub = source.subscribeFrames(() => {})
  await settle()
  sub.unsubscribe()
  const stats = source.stats()
  session.release()
  const after = source.subscribeFrames(() => {})
  return source._pump() === null && after.available === false &&
    after.reason === CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION && typeof stats.framesIn === 'number'
})

await checkAsync('the rVFC pump on iOS-like delivers ImageBitmaps off the hidden video element', async () => {
  const env = iosSafariLike()
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const got = []
  const sub = source.subscribeFrames((d) => { got.push(d) })
  await settle()
  const video = source._pump().video
  video.emitFrame(16)
  await settle()
  video.emitFrame(33)
  await settle()
  sub.unsubscribe()
  return got.length === 2 && got[0].width === 1280 && source.pumpKind() === PUMP.RVFC
})

/* ------------------------------------------------------ 3. captureStill --- */

await checkAsync('Android-like still rides ImageCapture.takePhoto — full photo pipeline, labeled', async () => {
  const { source } = await androidSource()
  const shot = await source.captureStill()
  return shot.available && shot.path === STILL_PATH.TAKE_PHOTO &&
    shot.blob instanceof Blob && shot.blob.size > 10_000 && typeof shot.elapsedMs === 'number'
})

await checkAsync('an ImageCapture WITHOUT takePhoto degrades to grabFrame — and says so', async () => {
  const env = androidChromeLike()
  class GrabOnly {
    constructor (track) { this.track = track }
    async grabFrame () { const s = this.track.getSettings(); return { width: s.width, height: s.height, close () {} } }
  }
  env.ImageCapture = GrabOnly
  const { session } = await openSession({ facing: 'back' }, { env, clock: manualClock() })
  const source = createFrameSource(session, { env, clock: manualClock() })
  const shot = await source.captureStill()
  return shot.available && shot.path === STILL_PATH.GRAB_FRAME && shot.width === 1280 && shot.blob instanceof Blob
})

await checkAsync('iOS-like still is the canvas-draw fallback at STREAM resolution — labeled, not disguised', async () => {
  const env = iosSafariLike()
  const { session } = await openSession({ facing: 'back' }, { env, clock: manualClock() })
  const source = createFrameSource(session, { env, clock: manualClock() })
  const shot = await source.captureStill()
  return shot.available && shot.path === STILL_PATH.CANVAS_DRAW && shot.width === 1280 && shot.blob instanceof Blob
})

await checkAsync('captureStill on a released session answers NO_ACTIVE_SESSION', async () => {
  const { session, source } = await androidSource()
  session.release()
  const shot = await source.captureStill()
  return shot.available === false && shot.reason === CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION
})

console.log('\n========================================')
console.log('  frame source — the platform seam: pumps, backpressure, stills')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
