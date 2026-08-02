/**
 * Spot Me camera — slow motion: real high-fps capture, re-timed playback.
 *
 * THE HONESTY LINE, drawn hard: slow motion exists ONLY where the device
 * can capture genuinely fast (track frameRate ≥ 100fps by default —
 * capabilities.js's highFps). A device topping out at 30/60fps gets
 * UNAVAILABLE(NO_HIGH_FPS_MODE) with the measured ceiling in the detail.
 * The tempting fallback — play ordinary footage slower and interpolate —
 * shows the user smeared frames pretending to be captured time, and this
 * engine does not ship it. (Optical-flow interpolation, if ever wanted, is
 * a mission-2 model behind its own flag, not a silent degrade here.)
 *
 * FLOW: prepare (verify + apply the high fps constraint) → capture (buffer
 * frames off the FrameSource under a byte budget) → assemble (stretch
 * timestamps by slowFactor through assemble.js). Re-timing is arithmetic
 * on REAL captured frames: 240fps played at 30fps = 8× slower, every
 * frame genuine.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { assembleFrames } from './assemble.js'
import { realClock } from './clock.js'

export const SLOWMO_DEFAULTS = Object.freeze({
  minCaptureFps: 100,
  budgetBytes: 384 * 1024 * 1024,
  maxSeconds: 10,
})

/** Verify the device can do it, then ask the track for its fastest mode.
 *  Returns what was ACTUALLY granted — a device may negotiate down, and
 *  the achievable slow factor is computed from granted, not requested. */
export async function prepareSlowmo (session, { minCaptureFps = SLOWMO_DEFAULTS.minCaptureFps, playbackFps = 30 } = {}) {
  const caps = session.capabilities()
  if (!caps.highFps?.available) {
    return caps.highFps || unavailable(CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE)
  }
  if (caps.highFps.max < minCaptureFps) {
    return unavailable(CAMERA_UNAVAILABLE.NO_HIGH_FPS_MODE,
      `device tops out at ${caps.highFps.max}fps (< ${minCaptureFps})`)
  }
  const applied = await session.pro.setFrameRate(caps.highFps.max)
  if (!applied.available) return applied
  const grantedFps = session.settings()?.frameRate ?? caps.highFps.max
  return available({
    captureFps: grantedFps,
    playbackFps,
    slowFactor: grantedFps / playbackFps,
  })
}

/**
 * Buffer frames for a slow-mo take. Frames are COPIED via
 * createImageBitmap (the FrameSource closes its own after delivery) and
 * held under `budgetBytes` (w×h×4 estimate per frame) — when the budget
 * fills, capture stops itself and the result says RESOURCE_LIMIT.
 */
export function captureSlowmo (frameSource, {
  captureFps, budgetBytes = SLOWMO_DEFAULTS.budgetBytes,
  maxSeconds = SLOWMO_DEFAULTS.maxSeconds, env = globalThis, clock = null,
} = {}) {
  const clk = clock || realClock(env)
  if (typeof env.createImageBitmap !== 'function') {
    return unavailable(CAMERA_UNAVAILABLE.NO_FRAME_PUMP, 'createImageBitmap missing — cannot retain frames')
  }
  const frames = []                        // {source, timestampMs}
  let bytes = 0
  let stoppedBy = null
  let done = null
  const finished = new Promise((resolve) => { done = resolve })
  const startedAt = clk.now()

  const sub = frameSource.subscribeFrames(async (delivery) => {
    if (stoppedBy) return
    const estimate = (delivery.width || 0) * (delivery.height || 0) * 4
    if (bytes + estimate > budgetBytes) { finish('RESOURCE_LIMIT'); return }
    if ((clk.now() - startedAt) / 1000 > maxSeconds) { finish('maxSeconds'); return }
    try {
      const copy = await env.createImageBitmap(delivery.frame)
      frames.push({ source: copy, timestampMs: delivery.mediaTs ?? delivery.ts })
      bytes += estimate
    } catch { /* one bad frame is not a dead take */ }
  })
  if (!sub.available) return sub

  function finish (reason) {
    if (stoppedBy) return
    stoppedBy = reason
    sub.unsubscribe()
    done()
  }

  return available({
    stop: async () => {
      finish('user')
      await finished
      return available({
        frames,
        captured: frames.length,
        estimatedBytes: bytes,
        stoppedBy,
        captureFps,
      })
    },
  })
}

/** Stretch time: captured timestamps × slowFactor, encoded at playbackFps. */
export async function assembleSlowmo (captured, {
  slowFactor, playbackFps = 30, codec = 'vp8', env = globalThis, clock = null,
} = {}) {
  if (!captured?.frames?.length) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'no captured frames')
  if (!(slowFactor > 1)) return unavailable(CAMERA_UNAVAILABLE.FAILED, 'slowFactor must exceed 1')
  const t0 = captured.frames[0].timestampMs
  const timed = captured.frames.map((f) => ({
    source: f.source,
    timestampMs: (f.timestampMs - t0) * slowFactor,
  }))
  const first = captured.frames[0].source
  const out = await assembleFrames(timed, {
    width: first.width || first.codedWidth,
    height: first.height || first.codedHeight,
    fps: playbackFps,
    codec,
    env,
    clock,
  })
  if (!out.available) return out
  return available({ ...out, slowFactor, playbackFps })
}
