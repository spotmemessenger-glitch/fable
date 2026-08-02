/**
 * Spot Me camera — burst: a paced frame-grab loop under a hard memory
 * bound.
 *
 * A burst is N frames the user gets to CHOOSE FROM, so latency between
 * frames matters more than per-frame quality — bursts ride grabFrame (a
 * stream-resolution bitmap in tens of ms), never takePhoto (a full photo
 * pipeline round-trip per shot). Where ImageCapture exists the loop grabs
 * directly (each grab returns a bitmap WE own); otherwise it copies off
 * the FrameSource. Both paths are labeled.
 *
 * THE MEMORY BOUND IS THE FEATURE. Bitmaps are uncompressed GPU-adjacent
 * memory (w×h×4); a 12-frame 1080p burst is ~100 MB. `budgetBytes` stops
 * the loop with truncated:true + RESOURCE_LIMIT before the tab dies —
 * a burst that OOMs the page captured nothing.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { realClock } from './clock.js'

export const BURST_DEFAULTS = Object.freeze({
  count: 10,
  intervalMs: 100,
  budgetBytes: 192 * 1024 * 1024,
})

export const BURST_PATH = Object.freeze({
  GRAB_FRAME: 'grabFrame',
  FRAME_PUMP: 'frame-pump',
})

/**
 * @returns envelope { frames: [{bitmap, ts}], captured, truncated,
 *          truncatedBy, path, estimatedBytes } — caller owns the bitmaps
 *          and must close() them.
 */
export async function captureBurst (session, frameSource, {
  count = BURST_DEFAULTS.count,
  intervalMs = BURST_DEFAULTS.intervalMs,
  budgetBytes = BURST_DEFAULTS.budgetBytes,
  env = globalThis, clock = null,
} = {}) {
  const clk = clock || realClock(env)
  const track = session.track()
  if (!track || track.readyState !== 'live') return unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION)

  const frames = []
  let bytes = 0
  let truncatedBy = null
  const t0 = clk.now()

  const withinBudget = (bitmap) => {
    const estimate = (bitmap?.width || 0) * (bitmap?.height || 0) * 4
    if (bytes + estimate > budgetBytes) return false
    bytes += estimate
    return true
  }

  if (typeof env.ImageCapture === 'function' &&
      typeof env.ImageCapture.prototype?.grabFrame === 'function') {
    const capture = new env.ImageCapture(track)
    for (let i = 0; i < count; i++) {
      let bitmap
      try { bitmap = await capture.grabFrame() } catch (e) {
        if (frames.length === 0) return unavailable(CAMERA_UNAVAILABLE.FAILED, `grabFrame: ${e?.message || e}`)
        truncatedBy = 'grabFailed'
        break
      }
      if (!withinBudget(bitmap)) { try { bitmap.close?.() } catch { /* done */ } truncatedBy = 'budgetBytes'; break }
      frames.push({ bitmap, ts: clk.now() })
      if (i < count - 1) await new Promise((resolve) => clk.setTimeout(resolve, intervalMs))
    }
    return result(BURST_PATH.GRAB_FRAME)
  }

  // Frame-pump path: copy deliveries at the burst pace.
  if (typeof env.createImageBitmap !== 'function') {
    return unavailable(CAMERA_UNAVAILABLE.NO_FRAME_PUMP, 'neither ImageCapture nor createImageBitmap')
  }
  let finish
  const donePromise = new Promise((resolve) => { finish = resolve })
  const sub = frameSource.subscribeFrames(async (delivery) => {
    if (frames.length >= count || truncatedBy) return
    let bitmap
    try { bitmap = await env.createImageBitmap(delivery.frame) } catch { return }
    if (!withinBudget(bitmap)) { try { bitmap.close?.() } catch { /* done */ } truncatedBy = 'budgetBytes'; finish(); return }
    frames.push({ bitmap, ts: delivery.ts })
    if (frames.length >= count) finish()
  }, { fps: 1000 / intervalMs })
  if (!sub.available) return sub
  // Bound the wait: a stalled pump must not hang the burst forever.
  const guard = clk.setTimeout(() => { truncatedBy = truncatedBy || 'timeout'; finish() },
    count * intervalMs * 4 + 2_000)
  await donePromise
  clk.clearTimeout(guard)
  sub.unsubscribe()
  return result(BURST_PATH.FRAME_PUMP)

  function result (path) {
    return available({
      frames,
      captured: frames.length,
      truncated: truncatedBy !== null || frames.length < count,
      truncatedBy,
      path,
      estimatedBytes: bytes,
      elapsedMs: clk.now() - t0,
    })
  }
}

/** The cleanup half of the contract — every burst caller must end here. */
export function releaseBurst (burst) {
  for (const frame of burst?.frames || []) { try { frame.bitmap?.close?.() } catch { /* done */ } }
  return available({ released: burst?.frames?.length || 0 })
}
