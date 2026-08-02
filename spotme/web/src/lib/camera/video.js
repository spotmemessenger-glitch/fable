/**
 * Spot Me camera — the MediaRecorder wrapper: honest codec negotiation, a
 * guarded state machine, segments, and hard caps.
 *
 * WHY WRAP AT ALL. Raw MediaRecorder throws InvalidStateError on the wrong
 * transition, silently records whatever mime it likes when unset, and will
 * happily fill the disk. This wrapper: negotiates the mime by ASKING
 * isTypeSupported down a candidate list (never assumes — iOS records mp4,
 * Chromium webm, and the result names which); refuses wrong-state calls
 * with a named envelope instead of an exception; counts bytes and clocks
 * ACTIVE duration (pauses excluded) against caps that stop the recording
 * with `stoppedBy` telling the user which limit hit; and cuts segments on
 * request so long recordings are not one fragile blob.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { realClock } from './clock.js'

export const DEFAULT_MIME_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
  'video/mp4;codecs=avc1.42E01E',
  'video/mp4',
])

export const RECORDER_STATE = Object.freeze({
  IDLE: 'idle', RECORDING: 'recording', PAUSED: 'paused', STOPPED: 'stopped',
})

/** Ask the browser which of these it can ACTUALLY record. */
export function negotiateMime (env = globalThis, candidates = DEFAULT_MIME_CANDIDATES) {
  const Recorder = env.MediaRecorder
  if (typeof Recorder !== 'function') return unavailable(CAMERA_UNAVAILABLE.NO_RECORDER, 'MediaRecorder missing')
  if (typeof Recorder.isTypeSupported !== 'function') {
    // Ancient shape: constructor exists, probe does not. Record unspecified.
    return available({ mimeType: '', probed: false })
  }
  for (const mimeType of candidates) {
    if (Recorder.isTypeSupported(mimeType)) return available({ mimeType, probed: true })
  }
  return unavailable(CAMERA_UNAVAILABLE.NO_RECORDER,
    `none of ${candidates.length} candidate types supported`)
}

export function createRecorder (stream, {
  env = globalThis, clock = null, mimeCandidates = DEFAULT_MIME_CANDIDATES,
  videoBitsPerSecond = 8_000_000, maxDurationMs = null, maxBytes = null,
  timesliceMs = 1_000, metrics = null,
} = {}) {
  const negotiated = negotiateMime(env, mimeCandidates)
  if (!negotiated.available) return negotiated
  const clk = clock || realClock(env)

  let recorder
  try {
    recorder = new env.MediaRecorder(stream, {
      ...(negotiated.mimeType ? { mimeType: negotiated.mimeType } : {}),
      videoBitsPerSecond,
    })
  } catch (e) {
    return unavailable(CAMERA_UNAVAILABLE.NO_RECORDER, String(e?.message || e))
  }

  let state = RECORDER_STATE.IDLE
  let stopping = false                     // re-entry guard: the stop() flush
  let bytes = 0                            // emits a final chunk that must not
                                           // re-trigger a cap stop
  let activeMs = 0
  let resumedAt = null
  let capTimer = null
  let stoppedBy = 'user'
  let segments = []                        // closed segments
  let currentChunks = []
  let currentBytes = 0
  let segmentStartedMs = 0
  let resolveStopped = null
  const stoppedPromise = new Promise((resolve) => { resolveStopped = resolve })

  const durationMs = () => activeMs + (state === RECORDER_STATE.RECORDING && resumedAt !== null ? clk.now() - resumedAt : 0)

  const closeSegment = () => {
    if (currentChunks.length === 0) return
    const blob = new Blob(currentChunks, { type: recorder.mimeType || negotiated.mimeType })
    segments.push({ blob, bytes: currentBytes, startMs: segmentStartedMs, endMs: durationMs() })
    currentChunks = []
    currentBytes = 0
    segmentStartedMs = durationMs()
  }

  recorder.ondataavailable = (event) => {
    const size = event?.data?.size || 0
    if (!size) return
    bytes += size
    currentBytes += size
    currentChunks.push(event.data)
    if (maxBytes !== null && bytes >= maxBytes && state === RECORDER_STATE.RECORDING && !stopping) {
      stoppedBy = 'maxBytes'
      api.stop()
    }
  }
  recorder.onstop = () => {
    closeSegment()
    if (resumedAt !== null) { activeMs += clk.now() - resumedAt; resumedAt = null }
    state = RECORDER_STATE.STOPPED
    const blob = new Blob(segments.flatMap((s) => [s.blob]), { type: recorder.mimeType || negotiated.mimeType })
    const result = available({
      blob,
      mimeType: recorder.mimeType || negotiated.mimeType,
      bytes,
      durationMs: activeMs,
      segments,
      stoppedBy,
    })
    metrics?.record('video.record', activeMs, { stoppedBy, bytes })
    resolveStopped(result)
  }
  recorder.onerror = (event) => {
    if (state === RECORDER_STATE.STOPPED) return
    state = RECORDER_STATE.STOPPED
    resolveStopped(unavailable(CAMERA_UNAVAILABLE.FAILED, String(event?.error?.message || 'recorder error')))
  }

  const armCapTimer = () => {
    if (maxDurationMs === null) return
    const remaining = maxDurationMs - durationMs()
    if (remaining <= 0) { stoppedBy = 'maxDuration'; api.stop(); return }
    capTimer = clk.setTimeout(() => { stoppedBy = 'maxDuration'; api.stop() }, remaining)
  }
  const disarmCapTimer = () => { if (capTimer !== null) { clk.clearTimeout(capTimer); capTimer = null } }

  const wrongState = (wanted) => unavailable(CAMERA_UNAVAILABLE.FAILED,
    `recorder is ${state}, needs ${wanted}`)

  const api = {
    state: () => state,
    mimeType: () => recorder.mimeType || negotiated.mimeType,
    bytes: () => bytes,
    durationMs,
    stopped: () => stoppedPromise,

    start () {
      if (state !== RECORDER_STATE.IDLE) return wrongState(RECORDER_STATE.IDLE)
      try { recorder.start(timesliceMs) } catch (e) {
        return unavailable(CAMERA_UNAVAILABLE.FAILED, String(e?.message || e))
      }
      state = RECORDER_STATE.RECORDING
      resumedAt = clk.now()
      segmentStartedMs = 0
      armCapTimer()
      return available({ mimeType: api.mimeType() })
    },

    pause () {
      if (state !== RECORDER_STATE.RECORDING) return wrongState(RECORDER_STATE.RECORDING)
      try { recorder.pause() } catch (e) { return unavailable(CAMERA_UNAVAILABLE.FAILED, String(e?.message || e)) }
      activeMs += clk.now() - resumedAt
      resumedAt = null
      disarmCapTimer()                     // paused time never counts against the cap
      state = RECORDER_STATE.PAUSED
      return available({ durationMs: activeMs })
    },

    resume () {
      if (state !== RECORDER_STATE.PAUSED) return wrongState(RECORDER_STATE.PAUSED)
      try { recorder.resume() } catch (e) { return unavailable(CAMERA_UNAVAILABLE.FAILED, String(e?.message || e)) }
      state = RECORDER_STATE.RECORDING
      resumedAt = clk.now()
      armCapTimer()
      return available({})
    },

    /** Cut a segment boundary: flush pending data, close the segment. */
    rotate () {
      if (state !== RECORDER_STATE.RECORDING) return wrongState(RECORDER_STATE.RECORDING)
      try { recorder.requestData() } catch { /* flush is best-effort */ }
      closeSegment()
      return available({ segments: segments.length })
    },

    stop () {
      if (state === RECORDER_STATE.STOPPED || stopping) return wrongState('not-stopped')
      stopping = true
      if (state === RECORDER_STATE.IDLE) {
        state = RECORDER_STATE.STOPPED
        const empty = available({ blob: new Blob([], { type: negotiated.mimeType }), bytes: 0, durationMs: 0, segments: [], stoppedBy })
        resolveStopped(empty)
        return empty
      }
      disarmCapTimer()
      try { recorder.stop() } catch (e) {
        state = RECORDER_STATE.STOPPED
        const failed = unavailable(CAMERA_UNAVAILABLE.FAILED, String(e?.message || e))
        resolveStopped(failed)
        return failed
      }
      return available({ stopping: true })
    },
  }
  return available({ recorder: api, mimeType: negotiated.mimeType, probed: negotiated.probed })
}
