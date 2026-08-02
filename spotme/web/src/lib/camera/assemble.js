/**
 * Spot Me camera — one assembler for "turn this frame list into a video
 * file", shared by timelapse and slow-motion because they are the SAME
 * problem with different frame lists and timestamps.
 *
 * TWO REAL PATHS, feature-detected, the used one labeled in the result:
 *
 *   'webcodecs-webm'   VideoEncoder → VP8/VP9 chunks → our WebM muxer.
 *                      Fast (encodes as fast as the codec runs), exact
 *                      timestamps. Needs VideoEncoder + VideoFrame.
 *   'canvas-replay'    draw each frame to a canvas whose captureStream
 *                      feeds MediaRecorder at the target fps. REAL TIME —
 *                      a 10-second output takes 10 seconds to produce, and
 *                      the result SAYS so (realtimeMs). Needs DOM canvas +
 *                      captureStream + MediaRecorder. This is the iOS path.
 *
 * Neither available → UNAVAILABLE(NO_RECORDER, 'no assembly path').
 * Nothing here interpolates, drops or invents frames.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { muxWebm } from './webm-mux.js'
import { realClock } from './clock.js'

export const ASSEMBLE_PATH = Object.freeze({
  WEBCODECS: 'webcodecs-webm',
  CANVAS_REPLAY: 'canvas-replay',
})

export function pickAssemblePath (env = globalThis) {
  if (typeof env.VideoEncoder === 'function' && typeof env.VideoFrame === 'function') {
    return ASSEMBLE_PATH.WEBCODECS
  }
  if (env.document && typeof env.MediaRecorder === 'function') return ASSEMBLE_PATH.CANVAS_REPLAY
  return null
}

/**
 * @param frames [{ source: ImageBitmap|VideoFrame|canvas-drawable,
 *                  timestampMs }]  — OUTPUT timestamps, already re-timed
 *                  by the caller (timelapse compresses time, slow-mo
 *                  stretches it; this function honours what it is given).
 * @param opts   { width, height, fps, codec, bitrate, env, clock }
 */
export async function assembleFrames (frames, {
  width, height, fps = 30, codec = 'vp8', bitrate = 6_000_000,
  env = globalThis, clock = null,
} = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, 'no frames to assemble')
  }
  if (!width || !height) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'assembleFrames needs width/height')
  const path = pickAssemblePath(env)
  if (!path) {
    return unavailable(CAMERA_UNAVAILABLE.NO_RECORDER,
      'no assembly path: needs WebCodecs (VideoEncoder+VideoFrame) or canvas+MediaRecorder')
  }
  const clk = clock || realClock(env)
  const t0 = clk.now()
  const out = path === ASSEMBLE_PATH.WEBCODECS
    ? await assembleWebCodecs(frames, { width, height, fps, codec, bitrate, env })
    : await assembleCanvasReplay(frames, { width, height, fps, env, clock: clk })
  if (!out.available) return out
  return available({ ...out, path, realtimeMs: clk.now() - t0, frames: frames.length })
}

async function assembleWebCodecs (frames, { width, height, fps, codec, bitrate, env }) {
  const chunks = []
  let failed = null
  const encoder = new env.VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      chunks.push({ data, timestampMs: chunk.timestamp / 1000, keyframe: chunk.type === 'key' })
    },
    error: (e) => { failed = e },
  })
  try {
    encoder.configure({
      codec: codec === 'vp9' ? 'vp09.00.10.08' : codec === 'av1' ? 'av01.0.04M.08' : 'vp8',
      width, height, bitrate, framerate: fps,
    })
    for (let i = 0; i < frames.length; i++) {
      const frame = new env.VideoFrame(frames[i].source, {
        timestamp: Math.round(frames[i].timestampMs * 1000),      // µs
        duration: Math.round(1e6 / fps),
      })
      encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps)) === 0 })
      frame.close()
      if (failed) break
    }
    if (!failed) await encoder.flush()
  } catch (e) {
    failed = failed || e
  } finally {
    try { encoder.close() } catch { /* already closed */ }
  }
  if (failed) return unavailable(CAMERA_UNAVAILABLE.FAILED, `encode: ${failed?.message || failed}`)
  if (chunks.length === 0) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'encoder produced no chunks')
  let webm
  try {
    webm = muxWebm({ codec, width, height, frames: chunks })
  } catch (e) {
    return unavailable(CAMERA_UNAVAILABLE.FAILED, `mux: ${e.message}`)
  }
  return available({
    blob: new Blob([webm], { type: 'video/webm' }),
    mimeType: 'video/webm',
    durationMs: chunks.length ? chunks[chunks.length - 1].timestampMs - chunks[0].timestampMs : 0,
  })
}

async function assembleCanvasReplay (frames, { width, height, fps, env, clock }) {
  const doc = env.document
  const canvas = doc.createElement('canvas')
  canvas.width = width
  canvas.height = height
  if (typeof canvas.captureStream !== 'function') {
    return unavailable(CAMERA_UNAVAILABLE.NO_RECORDER, 'canvas.captureStream missing')
  }
  const ctx = canvas.getContext('2d')
  const stream = canvas.captureStream(fps)
  let mimeType = ''
  if (typeof env.MediaRecorder.isTypeSupported === 'function') {
    for (const candidate of ['video/webm;codecs=vp9', 'video/webm', 'video/mp4']) {
      if (env.MediaRecorder.isTypeSupported(candidate)) { mimeType = candidate; break }
    }
  }
  const recorder = new env.MediaRecorder(stream, mimeType ? { mimeType } : {})
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data) }
  const done = new Promise((resolve) => { recorder.onstop = resolve })
  recorder.start()
  // Present frames in REAL TIME at the target fps — captureStream records
  // the wall clock, so this is the only honest pacing.
  const frameMs = 1000 / fps
  await new Promise((resolve) => {
    let i = 0
    const tick = () => {
      if (i >= frames.length) { resolve(); return }
      try { ctx.drawImage(frames[i].source, 0, 0, width, height) } catch { /* skip undrawable */ }
      i++
      clock.setTimeout(tick, frameMs)
    }
    tick()
  })
  recorder.stop()
  await done
  for (const track of stream.getTracks?.() || []) { try { track.stop() } catch { /* done */ } }
  const blob = new Blob(chunks, { type: mimeType || 'video/webm' })
  if (blob.size === 0) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'replay recorder produced no data')
  return available({ blob, mimeType: blob.type, durationMs: Math.round(frames.length * frameMs) })
}
