/**
 * Spot Me — Creative Studio video render drivers.
 *
 * Two honest paths, probed rather than assumed, LABELED in the output:
 *
 *   webcodecs      VideoEncoder → VP8/VP9 chunks → our own WebM muxer
 *                  (webm.js). Frame-exact and faster than realtime; audio is
 *                  PASSTHROUGH — Opus packets remuxed from a source WebM
 *                  without re-encoding when the source yields a clean track.
 *   mediarecorder  canvas.captureStream + MediaRecorder. Realtime (a 30 s
 *                  story takes 30 s), frame timing is best-effort, and audio
 *                  is NOT carried (wiring WebAudio into the stream is a
 *                  follow-up) — all three facts are recorded in the result's
 *                  metadata so no caller can mistake the fallback for the
 *                  real encoder.
 *
 * The probe and driver-selection logic are pure(ish) and Node-tested with
 * injected globals; actual encoding runs in a browser.
 */

import { renderFrame, frameSchedule, totalDurationMs, validateTimeline } from './composer.js'
import { muxWebM } from './webm.js'

/**
 * What can this environment encode? `env` is injectable for tests; defaults
 * to the live globals. isConfigSupported is awaited per codec so the answer
 * reflects the device, not wishful feature detection.
 */
export async function probeEncoders (env = globalThis) {
  const out = {
    webcodecs: { available: false, codec: null },
    mediarecorder: { available: false, mime: null }
  }
  try {
    if (typeof env.VideoEncoder === 'function' && env.VideoEncoder.isConfigSupported) {
      for (const [codec, id] of [['vp9', 'vp09.00.10.08'], ['vp8', 'vp8']]) {
        try {
          const res = await env.VideoEncoder.isConfigSupported({
            codec: id, width: 1280, height: 720, bitrate: 2_000_000, framerate: 30
          })
          if (res?.supported) { out.webcodecs = { available: true, codec, codecString: id }; break }
        } catch { /* try the next codec */ }
      }
    }
  } catch { /* no WebCodecs */ }
  try {
    const MR = env.MediaRecorder
    if (typeof MR === 'function' && typeof MR.isTypeSupported === 'function') {
      for (const mime of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) {
        if (MR.isTypeSupported(mime)) { out.mediarecorder = { available: true, mime }; break }
      }
    }
  } catch { /* no MediaRecorder */ }
  return out
}

/** Which driver a render will take, given a probe. Pure — unit-tested. */
export function selectDriver (probe) {
  if (probe?.webcodecs?.available) return 'webcodecs'
  if (probe?.mediarecorder?.available) return 'mediarecorder'
  return null
}

/* -------------------------------------------------------------- rendering */

/**
 * Render a timeline to a WebM Blob.
 *
 * deps: assets (Map<id, image>), audioBytes? (Uint8Array of a WebM whose Opus
 * track should ride along), decodeVideoFrame? (async (ref, tsMs) → image, the
 * browser-side seek hook for video segments), makeCanvas?, env?, onProgress?
 *
 * → { blob, metadata: { encoder, codec, width, height, fps, durationMs,
 *      frames, audio: 'passthrough'|'none', audioNote?, realtime } }
 */
export async function renderTimeline (timelineRaw, deps = {}) {
  const timeline = validateTimeline(timelineRaw)
  const env = deps.env || globalThis
  const probe = await probeEncoders(env)
  const driver = selectDriver(probe)
  if (!driver) throw new Error('render: no video encoder in this environment (need WebCodecs or MediaRecorder)')
  if (driver === 'webcodecs') return renderWithWebCodecs(timeline, deps, probe, env)
  return renderWithMediaRecorder(timeline, deps, probe, env)
}

/** Decode segment frames for a timestamp (video segments via injected hook). */
async function frameInputs (timeline, tMs, deps) {
  const frames = new Map()
  for (const seg of timeline.segments) {
    if (seg.type !== 'video') continue
    if (!deps.decodeVideoFrame) throw new Error('render: timeline has video segments but no decodeVideoFrame hook')
    frames.set(seg.ref, await deps.decodeVideoFrame(seg.ref, seg.startMs + tMs))
  }
  return frames
}

async function renderWithWebCodecs (timeline, deps, probe, env) {
  const { width, height, fps } = timeline
  const schedule = frameSchedule(timeline)
  const chunks = []
  let error = null
  const encoder = new env.VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength)
      chunk.copyTo(data)
      chunks.push({ tsMs: Math.round(chunk.timestamp / 1000), key: chunk.type === 'key', data })
    },
    error: (e) => { error = e }
  })
  encoder.configure({
    codec: probe.webcodecs.codecString,
    width,
    height,
    bitrate: 4_000_000,
    framerate: fps
  })

  for (let i = 0; i < schedule.length; i++) {
    const tMs = schedule[i]
    const frames = await frameInputs(timeline, tMs, deps)
    const img = renderFrame(timeline, tMs, { ...deps, frames })
    const pixels = new ImageData(new Uint8ClampedArray(img.data), width, height)
    // VideoFrame wraps the bitmap; closing the FRAME does not close the
    // SOURCE bitmap — that is a second GPU/CPU-backed resource with its own
    // lifetime. Left open, a 30s/30fps 1080p story leaks ~900 bitmaps per
    // export (review board F-7): real memory, not garbage the GC will find
    // quickly, because VideoFrame keeps a live reference to it.
    const bitmap = await createImageBitmap(pixels)
    const frame = new env.VideoFrame(bitmap, { timestamp: Math.round(tMs * 1000) })
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 })
    frame.close()
    bitmap.close?.()
    if (error) throw error
    deps.onProgress?.(i / schedule.length)
    if (encoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0))
  }
  await encoder.flush()
  encoder.close()
  if (error) throw error

  let audio = null
  let audioState = 'none'
  let audioNote
  if (timeline.audio && deps.audioBytes) {
    const { extractOpusTrack } = await import('./webm.js')
    audio = extractOpusTrack(deps.audioBytes)
    if (audio) {
      audioState = 'passthrough'
    } else {
      audioNote = 'audio source had no clean Opus track — rendered without audio'
    }
  } else if (timeline.audio) {
    audioNote = 'audio asset bytes were not provided — rendered without audio'
  }

  const durationMs = totalDurationMs(timeline)
  const bytes = muxWebM({
    video: { codec: probe.webcodecs.codec, width, height, frames: chunks },
    audio,
    durationMs
  })
  return {
    blob: new Blob([bytes], { type: 'video/webm' }),
    metadata: {
      encoder: 'webcodecs',
      codec: probe.webcodecs.codec,
      width,
      height,
      fps,
      durationMs,
      frames: schedule.length,
      audio: audioState,
      ...(audioNote ? { audioNote } : {}),
      realtime: false
    }
  }
}

async function renderWithMediaRecorder (timeline, deps, probe, env) {
  const { width, height, fps } = timeline
  const canvas = deps.makeCanvas
    ? deps.makeCanvas(width, height)
    : (() => {
        const c = env.document.createElement('canvas')
        c.width = width
        c.height = height
        return c
      })()
  const ctx = canvas.getContext('2d')
  const stream = canvas.captureStream(fps)
  const recorder = new env.MediaRecorder(stream, { mimeType: probe.mediarecorder.mime, videoBitsPerSecond: 4_000_000 })
  const parts = []
  recorder.ondataavailable = (e) => { if (e.data?.size) parts.push(e.data) }
  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = resolve
    recorder.onerror = (e) => reject(e.error || new Error('MediaRecorder failed'))
  })

  const schedule = frameSchedule(timeline)
  const durationMs = totalDurationMs(timeline)
  recorder.start()
  const started = (deps.now || (() => performance.now()))()
  for (let i = 0; i < schedule.length; i++) {
    const tMs = schedule[i]
    const frames = await frameInputs(timeline, tMs, deps)
    const img = renderFrame(timeline, tMs, { ...deps, frames })
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), width, height), 0, 0)
    deps.onProgress?.(i / schedule.length)
    // Realtime pacing: captureStream samples the canvas on the wall clock.
    const wait = tMs - ((deps.now || (() => performance.now()))() - started)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  const finishedAt = (deps.now || (() => performance.now()))()
  recorder.stop()
  await stopped
  return {
    blob: new Blob(parts, { type: probe.mediarecorder.mime.split(';')[0] }),
    metadata: {
      encoder: 'mediarecorder',
      codec: probe.mediarecorder.mime,
      width,
      height,
      fps,
      durationMs,
      // intended vs achieved: the pacing loop above is realtime and CANNOT
      // recover once composition on a given device falls behind (review
      // board F-18) — the fallback is already honestly labeled realtime,
      // but a caller previously had no way to measure how far behind it
      // fell without these two numbers.
      intendedDurationMs: durationMs,
      achievedDurationMs: Math.round(finishedAt - started),
      frames: schedule.length,
      audio: 'none',
      audioNote: timeline.audio
        ? 'MediaRecorder fallback does not carry the audio track — documented limitation'
        : undefined,
      realtime: true
    }
  }
}
