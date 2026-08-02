/**
 * Proves the engine factory: the dark stub answers every call with
 * FLAG_DISABLED while touching NOTHING, per-feature flags gate their
 * namespaces individually, availability() merges flag state over device
 * truth (flag wins), and the metrics snapshot measures real spans.
 *
 *   node test/camera-engine.test.js
 */
import { createCameraEngine } from '../src/lib/camera/engine.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { manualClock, throwingClock } from '../src/lib/camera/clock.js'
import { createMetrics, percentile } from '../src/lib/camera/metrics.js'
import { androidChromeLike, throwingMediaDevices, FakeVideoFrame } from './helpers/fake-media.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

const ALL_ON = {
  AI_CAMERA_ENABLED: true,
  CAMERA_ENGINE_ENABLED: true,
  CAMERA_HDR_ENABLED: true,
  CAMERA_NIGHT_ENABLED: true,
  CAMERA_PORTRAIT_ENABLED: true,
  CAMERA_BURST_ENABLED: true,
  CAMERA_VIDEO_ENABLED: true,
  CAMERA_SLOWMO_ENABLED: true,
  CAMERA_TIMELAPSE_ENABLED: true,
  CAMERA_STABILIZATION_ENABLED: true,
  CAMERA_PRO_CONTROLS_ENABLED: true,
}

/* ------------------------------------------------------- 1. the stub ------ */

await checkAsync('default factory: inert stub with THROWING env and clock — nothing is touched', async () => {
  const engine = createCameraEngine({
    env: { navigator: { mediaDevices: throwingMediaDevices() }, get document () { throw new Error('inert: document read') } },
    clock: throwingClock(),
  })
  const opened = await engine.openSession({ facing: 'back' })
  const listed = await engine.listDevices()
  return engine.enabled === false &&
    opened.reason === CAMERA_UNAVAILABLE.FLAG_DISABLED &&
    listed.reason === CAMERA_UNAVAILABLE.FLAG_DISABLED &&
    engine.availability().reason === CAMERA_UNAVAILABLE.FLAG_DISABLED &&
    engine.hdr.availability().reason === CAMERA_UNAVAILABLE.FLAG_DISABLED &&
    engine.segmenters.register({}).reason === CAMERA_UNAVAILABLE.FLAG_DISABLED
})

check('a lit ENGINE flag without the platform MASTER is still the stub (chain rule)', (() => {
  const engine = createCameraEngine({ flags: { CAMERA_ENGINE_ENABLED: true }, clock: throwingClock() })
  return engine.enabled === false
})())

check('unknown flag names THROW at the factory door', (() => {
  try { createCameraEngine({ flags: { CAMERA_HRD_ENABLED: true } }); return false } catch { return true }
})())

/* --------------------------------------------- 2. per-feature gating ------ */

await checkAsync('master on, sub-flags off: sessions work, every FEATURE refuses with ITS flag named', async () => {
  const env = androidChromeLike()
  const engine = createCameraEngine({
    flags: { AI_CAMERA_ENABLED: true, CAMERA_ENGINE_ENABLED: true },
    env, clock: manualClock(),
  })
  const opened = await engine.openSession({ facing: 'back' })
  const hdr = await engine.hdr.captureBracket(opened.session, null)
  const night = engine.night.stack([])
  const burst = await engine.burst.capture(opened.session, null)
  const video = engine.video.createRecorder(opened.session.stream)
  opened.session.release()
  return opened.available === true && engine.enabled === true &&
    hdr.reason === CAMERA_UNAVAILABLE.FLAG_DISABLED && hdr.detail === 'CAMERA_HDR_ENABLED' &&
    night.reason === CAMERA_UNAVAILABLE.FLAG_DISABLED && night.detail === 'CAMERA_NIGHT_ENABLED' &&
    burst.detail === 'CAMERA_BURST_ENABLED' && video.detail === 'CAMERA_VIDEO_ENABLED'
})

await checkAsync('availability() merge: flag OFF beats a capable device; flag ON shows device truth', async () => {
  const env = androidChromeLike()
  const engine = createCameraEngine({
    flags: { AI_CAMERA_ENABLED: true, CAMERA_ENGINE_ENABLED: true, CAMERA_NIGHT_ENABLED: true },
    env, clock: manualClock(),
  })
  const opened = await engine.openSession({ facing: 'back' })
  const map = engine.availability(opened.session)
  opened.session.release()
  // The device CAN do HDR (Android back cam) but the flag is off → FLAG_DISABLED.
  return map.hdr.reason === CAMERA_UNAVAILABLE.FLAG_DISABLED &&
    map.night.available === true &&
    map.raw.reason === CAMERA_UNAVAILABLE.DEFERRED_NATIVE
})

await checkAsync('portrait availability behind a lit flag is the REGISTRY truth (no segmenter → refusal)', async () => {
  const engine = createCameraEngine({
    flags: { AI_CAMERA_ENABLED: true, CAMERA_ENGINE_ENABLED: true, CAMERA_PORTRAIT_ENABLED: true },
    env: androidChromeLike(), clock: manualClock(),
  })
  const before = engine.portrait.availability()
  engine.segmenters.register({ name: 'test-seg', kind: 'ml', segment: async () => ({}) })
  const after = engine.portrait.availability()
  return before.reason === CAMERA_UNAVAILABLE.NO_SEGMENTER_REGISTERED &&
    after.available === true && after.engine === 'test-seg'
})

/* ------------------------------------------------- 3. the lit surface ----- */

await checkAsync('all-on engine: open → frame source → still + frames + metrics measured end to end', async () => {
  const env = androidChromeLike()
  const clock = manualClock(500)
  const engine = createCameraEngine({ flags: ALL_ON, env, clock })
  const opened = await engine.openSession({ facing: 'back' })
  const source = engine.createFrameSource(opened.session)
  const got = []
  const sub = source.subscribeFrames((d) => { got.push(d.seq) })
  await settle()
  opened.session.track().emitFrame(new FakeVideoFrame({ timestamp: 0, width: 1280, height: 720 }))
  await settle()
  const still = await source.captureStill()
  sub.unsubscribe()
  opened.session.release()
  const snap = engine.metrics()
  return still.available && still.path === 'takePhoto' && got.length === 1 &&
    snap.series['session.open']?.count === 1 &&
    snap.series['still.capture']?.count === 1 &&
    snap.series['frames.firstFrame']?.count === 1
})

await checkAsync('slow-mo through the engine respects device truth (Android yes, gated by flag not fakery)', async () => {
  const env = androidChromeLike()
  const engine = createCameraEngine({ flags: ALL_ON, env, clock: manualClock() })
  const opened = await engine.openSession({ facing: 'back' })
  const prepared = await engine.slowmo.prepare(opened.session, { playbackFps: 30 })
  opened.session.release()
  return prepared.available === true && prepared.slowFactor === 8
})

/* ----------------------------------------------------------- 4. metrics --- */

check('metrics: percentiles are nearest-rank on the retained window', (() => {
  const m = createMetrics(manualClock())
  for (let i = 1; i <= 100; i++) m.record('x', i)
  const s = m.snapshot().series.x
  return s.count === 100 && s.p50 === 50 && s.p90 === 90 && s.p99 === 99 && s.min === 1 && s.max === 100
})())

check('metrics: the ring is BOUNDED — count keeps history, window does not grow', (() => {
  const m = createMetrics()
  for (let i = 0; i < 2_000; i++) m.record('x', i)
  const s = m.snapshot().series.x
  return s.count === 2_000 && s.window === 512
})())

check('metrics: counters count and reset clears', (() => {
  const m = createMetrics()
  m.count('frames.dropped', 3)
  m.count('frames.dropped')
  const before = m.snapshot().counters['frames.dropped']
  m.reset()
  return before === 4 && Object.keys(m.snapshot().series).length === 0
})())

check('percentile helper: empty → null, single sample → itself', (() =>
  percentile([], 50) === null && percentile([7], 99) === 7)())

console.log('\n========================================')
console.log('  camera engine — dark stub, per-feature gates, measured surface')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
