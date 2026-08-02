/**
 * Spot Me camera — timelapse: interval stills, assembled into compressed
 * time.
 *
 * Capture and assembly are separate acts (a timelapse can run for an hour;
 * assembly happens once at the end): `createTimelapse` arms ONE interval
 * timer on the injectable clock and captures stills through the frame
 * source — each still rides whatever still path the platform honestly has
 * (takePhoto/grabFrame/canvas-draw, labeled per frame). Bounds are hard:
 * maxFrames and budgetBytes stop capture with `truncated` + the reason, so
 * an overnight lapse cannot eat the device.
 *
 * Assembly re-times: N frames captured over minutes play back at `fps`
 * (frame k → k/fps seconds), through assemble.js's honest paths.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { assembleFrames } from './assemble.js'
import { realClock } from './clock.js'

export const TIMELAPSE_DEFAULTS = Object.freeze({
  intervalMs: 2_000,
  maxFrames: 1_800,                       // an hour at 2s
  budgetBytes: 256 * 1024 * 1024,
})

export function createTimelapse (frameSource, {
  intervalMs = TIMELAPSE_DEFAULTS.intervalMs,
  maxFrames = TIMELAPSE_DEFAULTS.maxFrames,
  budgetBytes = TIMELAPSE_DEFAULTS.budgetBytes,
  clock = null, env = globalThis, metrics = null,
} = {}) {
  const clk = clock || realClock(env)
  let timer = null
  let capturing = false
  let frames = []                          // {blob|bitmap, width, height, path, ts}
  let bytes = 0
  let truncated = false
  let truncatedBy = null
  let startedAt = null

  const stopCapture = () => {
    if (timer !== null) { clk.clearInterval(timer); timer = null }
    capturing = false
  }

  const tick = async () => {
    if (!capturing) return
    const shot = await frameSource.captureStill()
    if (!capturing) return                 // stopped while the still was in flight
    if (!shot.available) return            // one dark frame is not a dead lapse
    const size = shot.blob?.size || 0
    if (bytes + size > budgetBytes) {
      truncated = true
      truncatedBy = 'budgetBytes'
      stopCapture()
      return
    }
    bytes += size
    frames.push({ blob: shot.blob, width: shot.width ?? null, height: shot.height ?? null, path: shot.path, ts: clk.now() })
    if (frames.length >= maxFrames) {
      truncated = true
      truncatedBy = 'maxFrames'
      stopCapture()
    }
  }

  return {
    start () {
      if (capturing) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'timelapse already running')
      capturing = true
      frames = []
      bytes = 0
      truncated = false
      truncatedBy = null
      startedAt = clk.now()
      timer = clk.setInterval(tick, intervalMs)
      return available({ intervalMs })
    },

    stop () {
      const wasCapturing = capturing
      stopCapture()
      const out = available({
        frames: [...frames],
        captured: frames.length,
        bytes,
        truncated,
        truncatedBy,
        elapsedMs: startedAt === null ? 0 : clk.now() - startedAt,
      })
      if (wasCapturing) metrics?.record('timelapse.capture', out.elapsedMs, { frames: frames.length })
      return out
    },

    state: () => ({ capturing, captured: frames.length, bytes, truncated }),

    /**
     * Frames → video. Each captured blob must first become a drawable
     * (createImageBitmap); re-timed to `fps`. On paths where blobs cannot
     * be decoded (no createImageBitmap) this is an honest refusal.
     */
    async assemble ({ fps = 30, codec = 'vp8', width = null, height = null } = {}) {
      if (frames.length === 0) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'no frames captured')
      if (typeof env.createImageBitmap !== 'function') {
        return unavailable(CAMERA_UNAVAILABLE.NO_RECORDER, 'createImageBitmap missing — cannot decode captured stills')
      }
      const sources = []
      for (const frame of frames) {
        try { sources.push(await env.createImageBitmap(frame.blob)) } catch { /* skip undecodable */ }
      }
      if (sources.length === 0) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'no decodable frames')
      const w = width || sources[0].width
      const h = height || sources[0].height
      const timed = sources.map((source, i) => ({ source, timestampMs: (i * 1000) / fps }))
      const out = await assembleFrames(timed, { width: w, height: h, fps, codec, env, clock: clk })
      for (const s of sources) { try { s.close?.() } catch { /* done */ } }
      return out
    },
  }
}
