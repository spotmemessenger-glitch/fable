/**
 * Spot Me camera — the FrameSource: THE seam the platform's later missions
 * (AI vision, AR/beauty) consume. One contract, three honest transports.
 *
 * createFrameSource(session) → {
 *   subscribeFrames(cb, {fps, scale}) — frames with timestamps + backpressure
 *   captureStill(opts)               — a Blob, LABELED with the path used
 *   capabilities()                   — live device truth + pump kind
 *   stats() / stop()
 * }
 *
 * FRAME OWNERSHIP — the rule that keeps GPU memory alive: a delivered frame
 * is valid ONLY until the subscriber's callback resolves; the source closes
 * it afterwards. Subscribers that need pixels later must copy. This is what
 * makes drop-oldest backpressure leak-free: every frame is closed exactly
 * once, whether delivered or dropped.
 *
 * BACKPRESSURE IS DROP-OLDEST. A slow consumer never stalls the camera and
 * never processes stale frames: while its callback runs, newer frames
 * replace the single pending slot (closing what they replace), and the
 * consumer's next frame is always the freshest. The `dropped` count rides
 * along so downstream vision code can SEE the pressure.
 *
 * PUMPS, feature-detected in preference order, the chosen one reported:
 *   'track-processor'  MediaStreamTrackProcessor → VideoFrame (Chromium;
 *                      zero-copy, has media timestamps)
 *   'rvfc'             hidden <video> + requestVideoFrameCallback →
 *                      ImageBitmap (Safari's best path)
 *   'interval-canvas'  <video> + 2D canvas + injectable interval → ImageData
 *                      (the everything-else fallback; labeled, lowest fidelity)
 * None available → UNAVAILABLE(NO_FRAME_PUMP). Nothing pretends to pump.
 */

import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { probeBrowser } from './capabilities.js'
import { realClock } from './clock.js'

export const PUMP = Object.freeze({
  TRACK_PROCESSOR: 'track-processor',
  RVFC: 'rvfc',
  INTERVAL_CANVAS: 'interval-canvas',
})

export const STILL_PATH = Object.freeze({
  TAKE_PHOTO: 'takePhoto',                // real photo pipeline, sensor res
  GRAB_FRAME: 'grabFrame',                // stream-resolution frame
  CANVAS_DRAW: 'canvas-draw',             // last resort, stream resolution
})

export function pickPumpKind (browser) {
  if (browser.trackProcessor) return PUMP.TRACK_PROCESSOR
  if (browser.document && browser.videoFrameCallback) return PUMP.RVFC
  if (browser.document) return PUMP.INTERVAL_CANVAS
  return null
}

export function createFrameSource (session, { env = null, clock = null, metrics = null } = {}) {
  const environment = env || session.env || globalThis
  const clk = clock || session.clock || realClock(environment)
  const browser = probeBrowser(environment)
  const pumpKind = pickPumpKind(browser)

  const subscribers = new Set()
  let pump = null                         // { stop() } while running
  let stopped = false
  let seq = 0
  let firstFrameAt = null
  let pumpStartedAt = null
  const stats = { framesIn: 0, framesDelivered: 0, framesDropped: 0 }

  /* ------------------------------------------------ frame refcounting ---- */
  function wrap (frame, meta) {
    return { frame, meta, refs: 0, closed: false }
  }
  function addRef (w) { w.refs++ }
  function release (w) {
    w.refs--
    if (w.refs <= 0 && !w.closed) { w.closed = true; try { w.frame?.close?.() } catch { /* gone */ } }
  }

  /* ----------------------------------------------------- distribution ---- */
  function distribute (frame, mediaTs) {
    stats.framesIn++
    const now = clk.now()
    if (firstFrameAt === null) {
      firstFrameAt = now
      if (pumpStartedAt !== null) metrics?.record('frames.firstFrame', now - pumpStartedAt, { pump: pumpKind })
    }
    const w = wrap(frame, {
      ts: now,
      mediaTs: mediaTs ?? null,
      width: frame?.codedWidth || frame?.width || null,
      height: frame?.codedHeight || frame?.height || null,
      seq: seq++,
    })
    addRef(w)                             // pump's own ref while distributing
    for (const sub of [...subscribers]) offer(sub, w)
    release(w)
  }

  function offer (sub, w) {
    // fps throttle: the subscriber asked for at most N deliveries/second.
    if (sub.fps && w.meta.ts - sub.lastTs < 1000 / sub.fps - 1e-6) return
    if (sub.busy) {
      // Drop-oldest: replace the pending slot, close what it replaces.
      if (sub.pending) { release(sub.pending); sub.droppedSinceDelivery++; stats.framesDropped++ }
      sub.pending = w
      addRef(w)
      return
    }
    deliver(sub, w)
  }

  function deliver (sub, w) {
    sub.busy = true
    sub.lastTs = w.meta.ts
    addRef(w)
    const delivery = {
      frame: w.frame,
      ts: w.meta.ts,
      mediaTs: w.meta.mediaTs,
      width: w.meta.width,
      height: w.meta.height,
      seq: w.meta.seq,
      dropped: sub.droppedSinceDelivery,
    }
    sub.droppedSinceDelivery = 0
    stats.framesDelivered++
    Promise.resolve()
      .then(() => sub.cb(delivery))
      .catch(() => { /* a subscriber's error must not stall its siblings */ })
      .then(() => {
        release(w)
        sub.busy = false
        const next = sub.pending
        sub.pending = null
        if (next) {
          // Ref moves from the pending slot to the delivery; no net change.
          deliver(sub, next)
          release(next)
        }
      })
  }

  /* ------------------------------------------------------------ pumps ---- */
  function startPumpIfNeeded () {
    if (pump || stopped) return
    pumpStartedAt = clk.now()
    if (pumpKind === PUMP.TRACK_PROCESSOR) pump = startTrackProcessorPump()
    else if (pumpKind === PUMP.RVFC) pump = startVideoPump(true)
    else if (pumpKind === PUMP.INTERVAL_CANVAS) pump = startVideoPump(false)
  }
  function stopPumpIfIdle () {
    if (pump && subscribers.size === 0) { pump.stop(); pump = null }
  }

  function startTrackProcessorPump () {
    const track = session.track()
    let active = true
    let reader = null
    ;(async () => {
      try {
        const processor = new environment.MediaStreamTrackProcessor({ track })
        reader = processor.readable.getReader()
        while (active) {
          const { value, done } = await reader.read()
          if (done || !active) { value?.close?.(); break }
          // VideoFrame timestamps are microseconds.
          distribute(value, typeof value.timestamp === 'number' ? value.timestamp / 1000 : null)
        }
      } catch { /* track ended mid-read is an ordinary shutdown */ }
    })()
    return {
      stop () {
        active = false
        try { reader?.cancel?.() } catch { /* already done */ }
      },
    }
  }

  /** Both DOM pumps share the hidden video element; rvfc=false uses the
   *  injectable interval + canvas ImageData path. */
  function startVideoPump (useRvfc) {
    const doc = environment.document
    const video = doc.createElement('video')
    video.muted = true
    video.setAttribute?.('playsinline', '')  // iOS: otherwise fullscreen
    video.srcObject = session.stream
    let active = true
    let intervalId = null
    Promise.resolve(video.play?.()).catch(() => { /* autoplay refusal: rvfc still fires on frames */ })

    const onFrame = async () => {
      if (!active) return
      let frame = null
      try {
        if (typeof environment.createImageBitmap === 'function') {
          frame = await environment.createImageBitmap(video)
        } else {
          const canvas = doc.createElement('canvas')
          canvas.width = video.videoWidth || 0
          canvas.height = video.videoHeight || 0
          const ctx = canvas.getContext('2d')
          ctx.drawImage(video, 0, 0)
          const image = ctx.getImageData(0, 0, canvas.width || 1, canvas.height || 1)
          frame = { width: image.width, height: image.height, data: image.data, close () {} }
        }
      } catch { frame = null }
      if (frame && active) distribute(frame, null)
      if (useRvfc && active) video.requestVideoFrameCallback(onFrame)
    }

    if (useRvfc) video.requestVideoFrameCallback(onFrame)
    else {
      const maxFps = () => Math.max(1, ...[...subscribers].map((s) => s.fps || 30))
      intervalId = clk.setInterval(onFrame, Math.round(1000 / Math.min(30, maxFps())))
    }
    return {
      video,                              // exposed for tests to drive emitFrame
      stop () {
        active = false
        if (intervalId !== null) clk.clearInterval(intervalId)
        try { video.pause?.() } catch { /* detached */ }
        try { video.srcObject = null } catch { /* detached */ }
      },
    }
  }

  /* -------------------------------------------------------- the seam ----- */
  const source = {
    pumpKind: () => pumpKind,
    capabilities: () => ({ ...session.capabilities(), pump: pumpKind, still: stillPath() }),
    stats: () => ({ ...stats, firstFrameMs: firstFrameAt !== null && pumpStartedAt !== null ? firstFrameAt - pumpStartedAt : null }),

    subscribeFrames (cb, { fps = null, scale = null } = {}) {
      if (stopped) return unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION, 'frame source stopped')
      if (typeof cb !== 'function') return unavailable(CAMERA_UNAVAILABLE.FAILED, 'callback required')
      if (!pumpKind) {
        return unavailable(CAMERA_UNAVAILABLE.NO_FRAME_PUMP,
          'needs MediaStreamTrackProcessor or a DOM video element')
      }
      const sub = { cb, fps, scale, busy: false, pending: null, lastTs: -Infinity, droppedSinceDelivery: 0 }
      subscribers.add(sub)
      startPumpIfNeeded()
      return available({
        pump: pumpKind,
        unsubscribe () {
          if (!subscribers.delete(sub)) return
          if (sub.pending) { release(sub.pending); sub.pending = null }
          stopPumpIfIdle()
        },
      })
    },

    async captureStill () {
      const track = session.track()
      if (!track || track.readyState !== 'live') {
        return unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION)
      }
      const t0 = clk.now()
      const path = stillPath()
      if (!path) return unavailable(CAMERA_UNAVAILABLE.NO_FRAME_PUMP, 'no still path at all')
      try {
        if (path === STILL_PATH.TAKE_PHOTO) {
          const capture = new environment.ImageCapture(track)
          const blob = await capture.takePhoto()
          const out = available({ blob, path, elapsedMs: clk.now() - t0 })
          metrics?.record('still.capture', out.elapsedMs, { path })
          return out
        }
        if (path === STILL_PATH.GRAB_FRAME) {
          const capture = new environment.ImageCapture(track)
          const bitmap = await capture.grabFrame()
          const blob = await bitmapToBlob(bitmap, environment)
          const out = available({ blob, width: bitmap.width, height: bitmap.height, path, elapsedMs: clk.now() - t0 })
          try { bitmap.close?.() } catch { /* done */ }
          metrics?.record('still.capture', out.elapsedMs, { path })
          return out
        }
        // CANVAS_DRAW: the iOS Safari reality — stream resolution, honestly labeled.
        const blob = await captureViaCanvas()
        const out = available({ ...blob, path, elapsedMs: clk.now() - t0 })
        metrics?.record('still.capture', out.elapsedMs, { path })
        return out
      } catch (err) {
        return unavailable(CAMERA_UNAVAILABLE.FAILED, `${path}: ${err?.message || err}`)
      }
    },

    stop () {
      if (stopped) return
      stopped = true
      for (const sub of subscribers) { if (sub.pending) { release(sub.pending); sub.pending = null } }
      subscribers.clear()
      if (pump) { pump.stop(); pump = null }
    },

    /** Test escape hatch: the live DOM pump (video element), when one runs. */
    _pump: () => pump,
  }

  function stillPath () {
    if (browser.imageCapture && typeof environment.ImageCapture === 'function') {
      // takePhoto is the real photo pipeline; grabFrame is its fallback face.
      return typeof environment.ImageCapture.prototype?.takePhoto === 'function'
        ? STILL_PATH.TAKE_PHOTO : STILL_PATH.GRAB_FRAME
    }
    if (browser.document) return STILL_PATH.CANVAS_DRAW
    return null
  }

  async function captureViaCanvas () {
    const doc = environment.document
    const video = doc.createElement('video')
    video.muted = true
    video.setAttribute?.('playsinline', '')
    video.srcObject = session.stream
    try { await video.play?.() } catch { /* draw whatever is there */ }
    const canvas = doc.createElement('canvas')
    canvas.width = video.videoWidth || session.settings()?.width || 0
    canvas.height = video.videoHeight || session.settings()?.height || 0
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    try { video.srcObject = null } catch { /* detached */ }
    if (!blob) throw new Error('canvas.toBlob returned null')
    return { blob, width: canvas.width, height: canvas.height }
  }

  // A released session must take its frame source down with it — a pump on a
  // dead track spins forever delivering nothing.
  session.onReleased?.(() => source.stop())

  return source
}

async function bitmapToBlob (bitmap, environment) {
  if (typeof environment.OffscreenCanvas === 'function') {
    const canvas = new environment.OffscreenCanvas(bitmap.width, bitmap.height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  }
  const doc = environment.document
  if (!doc) throw new Error('no canvas path to encode the frame')
  const canvas = doc.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('2d').drawImage(bitmap, 0, 0)
  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob returned null'))), 'image/jpeg', 0.92))
}
