/**
 * Proves the video platform: honest codec negotiation, the recorder state
 * machine with caps and segments, the WebM muxer's actual EBML structure,
 * assembly path selection, timelapse bounds, slow-mo honesty, and the
 * burst memory bound.
 *
 *   node test/camera-video.test.js
 */
import { negotiateMime, createRecorder, RECORDER_STATE } from '../src/lib/camera/video.js'
import { muxWebm, readEbml, vintBytes, EBML_ID } from '../src/lib/camera/webm-mux.js'
import { pickAssemblePath, assembleFrames, ASSEMBLE_PATH } from '../src/lib/camera/assemble.js'
import { createTimelapse } from '../src/lib/camera/timelapse.js'
import { prepareSlowmo, captureSlowmo, assembleSlowmo } from '../src/lib/camera/slowmo.js'
import { captureBurst, releaseBurst, BURST_PATH } from '../src/lib/camera/burst.js'
import { openSession } from '../src/lib/camera/session.js'
import { createFrameSource } from '../src/lib/camera/frame-source.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { manualClock, realClock } from '../src/lib/camera/clock.js'
import {
  androidChromeLike, iosSafariLike, fakeMediaRecorderClass, fakeStream, fakeTrack,
  fakeVideoEncoderClass, FakeVideoFrameCtor, FakeVideoFrame, FakeImageBitmap,
} from './helpers/fake-media.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}
const settle = () => new Promise((r) => setTimeout(r, 0))

/* ------------------------------------------------ 1. mime negotiation ----- */

check('negotiation walks the candidate list and reports what the browser ACTUALLY records', (() => {
  const chromeLike = { MediaRecorder: fakeMediaRecorderClass({ supported: ['video/webm;codecs=vp9', 'video/webm'] }) }
  const safariLike = { MediaRecorder: fakeMediaRecorderClass({ supported: ['video/mp4'] }) }
  const a = negotiateMime(chromeLike)
  const b = negotiateMime(safariLike)
  return a.available && a.mimeType === 'video/webm;codecs=vp9' &&
    b.available && b.mimeType === 'video/mp4'
})())

check('no MediaRecorder at all → NO_RECORDER; no supported type → NO_RECORDER with the count', (() => {
  const none = negotiateMime({})
  const unsupported = negotiateMime({ MediaRecorder: fakeMediaRecorderClass({ supported: [] }) })
  return none.reason === CAMERA_UNAVAILABLE.NO_RECORDER &&
    unsupported.reason === CAMERA_UNAVAILABLE.NO_RECORDER && /candidate/.test(unsupported.detail)
})())

/* ------------------------------------------- 2. recorder state machine ---- */

function recorderRig ({ maxDurationMs = null, maxBytes = null } = {}) {
  const Recorder = fakeMediaRecorderClass({ supported: ['video/webm;codecs=vp9', 'video/webm'] })
  const env = { MediaRecorder: Recorder }
  const clock = manualClock()
  const stream = fakeStream(fakeTrack({}))
  const made = createRecorder(stream, { env, clock, maxDurationMs, maxBytes })
  return { rec: made.recorder, made, inner: Recorder.instances.at(-1), clock }
}

check('lifecycle: idle → recording → paused → recording → stopped, each guarded', (() => {
  const { rec } = recorderRig()
  const wrongPause = rec.pause()
  const started = rec.start()
  const paused = rec.pause()
  const wrongStart = rec.start()
  const resumed = rec.resume()
  return wrongPause.available === false && started.available && rec.state() === RECORDER_STATE.PAUSED === false &&
    paused.available && resumed.available && wrongStart.available === false &&
    rec.state() === RECORDER_STATE.RECORDING
})())

await checkAsync('stop() delivers blob + bytes + ACTIVE duration (pause time excluded)', async () => {
  const { rec, inner, clock } = recorderRig()
  rec.start()
  await clock.advance(4_000)
  inner.emitChunk(10_000)
  rec.pause()
  await clock.advance(60_000)               // a minute of pause must not count
  rec.resume()
  await clock.advance(1_000)
  rec.stop()
  const out = await rec.stopped()
  return out.available && out.durationMs === 5_000 && out.bytes === 10_256 &&
    out.blob instanceof Blob && out.stoppedBy === 'user'
})

await checkAsync('maxDuration cap stops the recording and NAMES the limit', async () => {
  const { rec, clock } = recorderRig({ maxDurationMs: 10_000 })
  rec.start()
  await clock.advance(10_001)
  const out = await rec.stopped()
  return out.available && out.stoppedBy === 'maxDuration' && rec.state() === RECORDER_STATE.STOPPED
})

await checkAsync('…and PAUSED time does not burn the duration budget', async () => {
  const { rec, clock } = recorderRig({ maxDurationMs: 10_000 })
  rec.start()
  await clock.advance(5_000)
  rec.pause()
  await clock.advance(600_000)
  rec.resume()
  await clock.advance(4_000)
  const still = rec.state()
  rec.stop()
  await rec.stopped()
  return still === RECORDER_STATE.RECORDING
})

await checkAsync('maxBytes cap stops on the chunk that crosses it', async () => {
  const { rec, inner, clock } = recorderRig({ maxBytes: 5_000 })
  rec.start()
  await clock.advance(1_000)
  inner.emitChunk(3_000)
  inner.emitChunk(3_000)                    // crosses 5 000
  const out = await rec.stopped()
  return out.available && out.stoppedBy === 'maxBytes' && out.bytes >= 6_000
})

await checkAsync('rotate() cuts segments; the final blob is every segment in order', async () => {
  const { rec, inner, clock } = recorderRig()
  rec.start()
  await clock.advance(1_000)
  inner.emitChunk(1_000)
  rec.rotate()
  await clock.advance(1_000)
  inner.emitChunk(2_000)
  rec.stop()
  const out = await rec.stopped()
  return out.available && out.segments.length === 2 &&
    out.segments[0].bytes === 1_000 && out.segments[1].bytes === 2_256 &&
    out.blob.size === 3_256
})

/* -------------------------------------------------------- 3. WebM mux ----- */

check('vint sizing honours the EBML all-ones reservation: 126 fits 1 byte, 127 needs 2', (() => {
  const v126 = vintBytes(126)
  const v127 = vintBytes(127)
  return v126.length === 1 && v126[0] === 0xFE &&
    v127.length === 2 && v127[0] === 0x40 && v127[1] === 0x7F
})())

check('mux output parses back: EBML header + Segment(Info, Tracks, Cluster) with the right codec', (() => {
  const frames = [
    { data: new Uint8Array([1, 1, 1]), timestampMs: 0, keyframe: true },
    { data: new Uint8Array([2, 2]), timestampMs: 33, keyframe: false },
    { data: new Uint8Array([3]), timestampMs: 66, keyframe: false },
  ]
  const bytes = muxWebm({ codec: 'vp9', width: 640, height: 480, frames })
  const tree = readEbml(bytes)
  if (tree.length !== 2 || tree[0].id !== EBML_ID.EBML || tree[1].id !== EBML_ID.Segment) return false
  const segment = tree[1].children
  const docType = tree[0].children.find((n) => n.id === EBML_ID.DocType)
  const tracks = segment.find((n) => n.id === EBML_ID.Tracks)
  const codec = tracks.children[0].children.find((n) => n.id === EBML_ID.CodecID)
  const video = tracks.children[0].children.find((n) => n.id === EBML_ID.Video)
  const widthNode = video.children.find((n) => n.id === EBML_ID.PixelWidth)
  const clusters = segment.filter((n) => n.id === EBML_ID.Cluster)
  return new TextDecoder().decode(docType.data) === 'webm' &&
    new TextDecoder().decode(codec.data) === 'V_VP9' &&
    widthNode.data.reduce((a, b) => a * 256 + b, 0) === 640 &&
    clusters.length === 1 && clusters[0].children.filter((n) => n.id === EBML_ID.SimpleBlock).length === 3
})())

check('SimpleBlocks carry track 1, RELATIVE timestamps and the keyframe flag', (() => {
  const frames = [
    { data: new Uint8Array([9]), timestampMs: 0, keyframe: true },
    { data: new Uint8Array([8]), timestampMs: 40, keyframe: false },
  ]
  const bytes = muxWebm({ codec: 'vp8', width: 64, height: 48, frames })
  const segment = readEbml(bytes)[1].children
  const blocks = segment.find((n) => n.id === EBML_ID.Cluster)
    .children.filter((n) => n.id === EBML_ID.SimpleBlock).map((n) => n.data)
  const rel = (b) => (b[1] << 8) | b[2]
  return blocks[0][0] === 0x81 && rel(blocks[0]) === 0 && blocks[0][3] === 0x80 && blocks[0][4] === 9 &&
    blocks[1][0] === 0x81 && rel(blocks[1]) === 40 && blocks[1][3] === 0x00 && blocks[1][4] === 8
})())

check('clusters ROTATE before the int16 relative timestamp overflows', (() => {
  const frames = []
  for (let i = 0; i < 5; i++) frames.push({ data: new Uint8Array([i]), timestampMs: i * 20_000, keyframe: i === 0 })
  const bytes = muxWebm({ codec: 'vp8', width: 64, height: 48, frames })
  const clusters = readEbml(bytes)[1].children.filter((n) => n.id === EBML_ID.Cluster)
  const okRelative = clusters.every((c) => {
    const base = c.children.find((n) => n.id === EBML_ID.Timestamp).data.reduce((a, b) => a * 256 + b, 0)
    return c.children.filter((n) => n.id === EBML_ID.SimpleBlock)
      .every((b) => ((b.data[1] << 8) | b.data[2]) <= 32_767 && base >= 0)
  })
  return clusters.length >= 2 && okRelative
})())

check('an unknown codec or empty frame list throws by NAME', (() => {
  let a = false; let b = false
  try { muxWebm({ codec: 'h264', width: 1, height: 1, frames: [{ data: new Uint8Array(1), timestampMs: 0, keyframe: true }] }) } catch (e) { a = /unsupported webm codec/.test(e.message) }
  try { muxWebm({ codec: 'vp8', width: 1, height: 1, frames: [] }) } catch (e) { b = /needs frames/.test(e.message) }
  return a && b
})())

/* ---------------------------------------------------- 4. assembly paths --- */

check('path pick: WebCodecs where real, canvas-replay where DOM+recorder, none in bare Node', (() => {
  const webcodecs = { VideoEncoder: function () {}, VideoFrame: function () {} }
  const ios = iosSafariLike()
  return pickAssemblePath(webcodecs) === ASSEMBLE_PATH.WEBCODECS &&
    pickAssemblePath(ios) === ASSEMBLE_PATH.CANVAS_REPLAY &&
    pickAssemblePath({}) === null
})())

await checkAsync('WebCodecs assembly: frames encoded with GIVEN timestamps, muxed, LABELED', async () => {
  const env = { VideoEncoder: fakeVideoEncoderClass(), VideoFrame: FakeVideoFrameCtor }
  const frames = [0, 1, 2, 3].map((i) => ({ source: new FakeImageBitmap(64, 48), timestampMs: i * 100 }))
  const out = await assembleFrames(frames, { width: 64, height: 48, fps: 10, env, clock: manualClock() })
  if (!(out.available && out.path === ASSEMBLE_PATH.WEBCODECS && out.blob instanceof Blob)) return false
  const bytes = new Uint8Array(await out.blob.arrayBuffer())
  const clusters = readEbml(bytes)[1].children.filter((n) => n.id === EBML_ID.Cluster)
  const rel = clusters[0].children.filter((n) => n.id === EBML_ID.SimpleBlock).map((b) => (b.data[1] << 8) | b.data[2])
  return out.durationMs === 300 && rel.join(',') === '0,100,200,300'
})

await checkAsync('assembly with NO path is a named refusal, not a hang', async () => {
  const out = await assembleFrames([{ source: {}, timestampMs: 0 }], { width: 8, height: 8, env: {}, clock: manualClock() })
  return out.available === false && out.reason === CAMERA_UNAVAILABLE.NO_RECORDER
})

/* --------------------------------------------------------- 5. timelapse --- */

await checkAsync('timelapse captures on the interval, stop() reports frames with their still path', async () => {
  const env = androidChromeLike()
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const lapse = createTimelapse(source, { intervalMs: 1_000, clock, env })
  lapse.start()
  await clock.advance(3_500)
  const out = lapse.stop()
  return out.available && out.captured === 3 && out.frames.every((f) => f.path === 'takePhoto') &&
    out.truncated === false && out.elapsedMs === 3_500
})

await checkAsync('maxFrames bound STOPS capture and says so', async () => {
  const env = androidChromeLike()
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const lapse = createTimelapse(source, { intervalMs: 1_000, maxFrames: 2, clock, env })
  lapse.start()
  await clock.advance(10_000)
  const out = lapse.stop()
  return out.captured === 2 && out.truncated === true && out.truncatedBy === 'maxFrames'
})

await checkAsync('byte budget bound stops capture with budgetBytes named', async () => {
  const env = androidChromeLike()                      // takePhoto blobs ≈ 12 KB
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const lapse = createTimelapse(source, { intervalMs: 1_000, budgetBytes: 30_000, clock, env })
  lapse.start()
  await clock.advance(10_000)
  const out = lapse.stop()
  return out.truncated === true && out.truncatedBy === 'budgetBytes' && out.captured === 2
})

await checkAsync('timelapse assembly re-times to fps and rides the canvas-replay path here', async () => {
  const env = androidChromeLike()                      // no VideoFrame ⇒ replay path
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const lapse = createTimelapse(source, { intervalMs: 1_000, clock, env })
  lapse.start()
  await clock.advance(4_000)
  lapse.stop()
  const pending = lapse.assemble({ fps: 10 })
  await settle()
  await clock.advance(2_000)
  const out = await pending
  return out.available && out.path === ASSEMBLE_PATH.CANVAS_REPLAY && out.frames === 4 &&
    out.blob instanceof Blob && out.blob.size > 0
})

/* ----------------------------------------------------------- 6. slow-mo --- */

await checkAsync('slow-mo prepare on Android: 240fps granted, slowFactor 8 at 30fps playback', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: 'back' }, { env, clock: manualClock() })
  const prepared = await prepareSlowmo(session, { playbackFps: 30 })
  return prepared.available && prepared.captureFps === 240 && prepared.slowFactor === 8 &&
    session.settings().frameRate === 240
})

await checkAsync('slow-mo on iOS: NO_HIGH_FPS_MODE with the 60fps ceiling named — never interpolated', async () => {
  const env = iosSafariLike()
  const { session } = await openSession({ facing: 'back' }, { env, clock: manualClock() })
  const prepared = await prepareSlowmo(session)
  return prepared.available === false && prepared.reason === CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE &&
    /60fps/.test(prepared.detail)
})

await checkAsync('slow-mo capture buffers COPIES under budget; assembly stretches timestamps ×slowFactor', async () => {
  const env = androidChromeLike()
  env.VideoEncoder = fakeVideoEncoderClass()
  env.VideoFrame = FakeVideoFrameCtor
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const handle = captureSlowmo(source, { captureFps: 240, env, clock })
  await settle()
  for (let i = 0; i < 4; i++) {
    session.track().emitFrame(new FakeVideoFrame({ timestamp: i * 4_167, width: 64, height: 48 }))
    await settle()
  }
  const captured = await handle.stop()
  if (!(captured.available && captured.captured === 4 && captured.stoppedBy === 'user')) return false
  const out = await assembleSlowmo(captured, { slowFactor: 8, playbackFps: 30, env, clock })
  if (!(out.available && out.slowFactor === 8)) return false
  const bytes = new Uint8Array(await out.blob.arrayBuffer())
  const cluster = readEbml(bytes)[1].children.find((n) => n.id === EBML_ID.Cluster)
  const rel = cluster.children.filter((n) => n.id === EBML_ID.SimpleBlock).map((b) => (b.data[1] << 8) | b.data[2])
  // Captured spacing 4.167ms × 8 = 33ms playback spacing.
  return rel.length === 4 && Math.abs(rel[1] - 33) <= 1 && Math.abs(rel[3] - 100) <= 1
})

await checkAsync('slow-mo capture stops itself at the byte budget with RESOURCE_LIMIT', async () => {
  const env = androidChromeLike()
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const budget = 64 * 48 * 4 * 2 + 100                 // room for two frames
  const handle = captureSlowmo(source, { captureFps: 240, budgetBytes: budget, env, clock })
  await settle()
  for (let i = 0; i < 5; i++) {
    session.track().emitFrame(new FakeVideoFrame({ timestamp: i * 4_167, width: 64, height: 48 }))
    await settle()
  }
  const captured = await handle.stop()
  return captured.available && captured.captured === 2 && captured.stoppedBy === 'RESOURCE_LIMIT'
})

/* ------------------------------------------------------------- 7. burst --- */

await checkAsync('burst rides grabFrame where ImageCapture exists, paced, all frames owned', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: 'back' }, { env, clock: manualClock() })
  const source = createFrameSource(session, { env, clock: manualClock() })
  const out = await captureBurst(session, source, { count: 5, intervalMs: 1, env, clock: realClock() })
  const ok = out.available && out.captured === 5 && out.path === BURST_PATH.GRAB_FRAME &&
    out.truncated === false && out.frames.every((f) => f.bitmap.width === 1280)
  releaseBurst(out)
  return ok && out.frames.every((f) => f.bitmap.closed === true)
})

await checkAsync('burst memory bound: stops at budget with RESOURCE truncation, never OOMs on', async () => {
  const env = androidChromeLike()
  const { session } = await openSession({ facing: 'back' }, { env, clock: manualClock() })
  const source = createFrameSource(session, { env, clock: manualClock() })
  const budget = 1280 * 720 * 4 * 2 + 10               // two frames fit
  const out = await captureBurst(session, source, { count: 10, intervalMs: 1, budgetBytes: budget, env, clock: realClock() })
  releaseBurst(out)
  return out.available && out.captured === 2 && out.truncated === true && out.truncatedBy === 'budgetBytes'
})

await checkAsync('burst without ImageCapture uses the frame pump and LABELS it', async () => {
  const env = androidChromeLike()
  delete env.ImageCapture
  const clock = manualClock()
  const { session } = await openSession({ facing: 'back' }, { env, clock })
  const source = createFrameSource(session, { env, clock })
  const pending = captureBurst(session, source, { count: 3, intervalMs: 0, env, clock: realClock() })
  await settle()
  for (let i = 0; i < 6; i++) {
    await clock.advance(50)
    session.track().emitFrame(new FakeVideoFrame({ timestamp: i * 50_000, width: 640, height: 480 }))
    await settle()
  }
  const out = await pending
  const ok = out.available && out.captured === 3 && out.path === BURST_PATH.FRAME_PUMP
  releaseBurst(out)
  return ok
})

console.log('\n========================================')
console.log('  camera video — recorder, mux, assembly, lapse, slow-mo, burst')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
