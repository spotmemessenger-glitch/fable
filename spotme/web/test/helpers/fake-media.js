/**
 * One camera-stack stand-in, shared by every camera-*.test.js, because a
 * second copy would drift (the fake-idb lesson).
 *
 * WHAT IT MODELS, AND WHY THAT MUCH. Nothing in Node can prove a camera
 * works. What Node CAN prove is everything around the camera — and those are
 * the parts that fail quietly on real devices: capability honesty, stream
 * teardown, backpressure, constraint application, recorder state. So this
 * fake models the parts those claims rest on:
 *
 *   - MediaStreamTrack with real getCapabilities()/getSettings()/
 *     applyConstraints() semantics, including OverconstrainedError on an
 *     out-of-range exact constraint and IGNORING unknown keys (Chrome does)
 *   - getUserMedia that selects by deviceId/facingMode, records every open
 *     stream so leak assertions are possible, and fails with NAMED errors
 *   - a frame emitter on each track, so MediaStreamTrackProcessor and
 *     requestVideoFrameCallback pumps can be driven deterministically
 *   - VideoFrame/ImageBitmap stand-ins that track close() — dropped-frame
 *     backpressure that forgets to close() is a real GPU-memory leak class
 *   - ImageCapture (takePhoto/grabFrame) and MediaRecorder with honest
 *     isTypeSupported
 *
 * IT IS STILL A FAKE. Torch light, actual exposure, sensor timing and iOS
 * autoplay policy can only be proven on hardware — which is why
 * docs/ai-camera/production-checklist.md keeps a manual device matrix rather
 * than claiming CI covered it.
 */

/* ------------------------------------------------------------ frames ------ */

export class FakeVideoFrame {
  constructor ({ timestamp = 0, width = 640, height = 480, data = null } = {}) {
    this.timestamp = timestamp            // microseconds, like the real one
    this.codedWidth = width
    this.codedHeight = height
    this.displayWidth = width
    this.displayHeight = height
    this.data = data                      // optional ImageData-ish payload
    this.closed = false
  }

  close () { this.closed = true }
}

export class FakeImageBitmap {
  constructor (width = 640, height = 480, data = null) {
    this.width = width
    this.height = height
    this.data = data
    this.closed = false
  }

  close () { this.closed = true }
}

/* ------------------------------------------------------------- track ------ */

export function fakeTrack ({
  deviceId = 'cam0', label = 'Fake camera', facing = null,
  capabilities = {}, settings = {},
} = {}) {
  const caps = { deviceId, ...(facing ? { facingMode: [facing] } : {}), ...capabilities }
  const state = {
    settings: { deviceId, ...(facing ? { facingMode: facing } : {}), width: 1280, height: 720, frameRate: 30, ...settings },
  }
  const frameSubscribers = new Set()
  const endedListeners = new Set()
  const track = {
    kind: 'video',
    id: `${deviceId}-track`,
    label,
    enabled: true,
    readyState: 'live',
    appliedConstraints: [],               // every applyConstraints call, in order
    stop () {
      if (track.readyState === 'ended') return
      track.readyState = 'ended'
      // Real tracks do NOT fire 'ended' on a self stop(); modelled the same.
    },
    getCapabilities: () => ({ ...caps }),
    getSettings: () => ({ ...state.settings }),
    async applyConstraints (constraints = {}) {
      if (track.readyState === 'ended') {
        const e = new Error('track ended'); e.name = 'InvalidStateError'; throw e
      }
      const advanced = constraints.advanced || []
      const flat = [{ ...constraints, advanced: undefined }, ...advanced]
      for (const set of flat) {
        for (const [key, want] of Object.entries(set)) {
          if (want === undefined || key === 'advanced') continue
          const cap = caps[key]
          if (cap === undefined) continue          // Chrome ignores unknown keys
          const exact = (want && typeof want === 'object' && 'exact' in want) ? want.exact : want
          if (Array.isArray(cap)) {
            if (!cap.includes(exact)) throw overconstrained(key)
          } else if (cap && typeof cap === 'object' && 'min' in cap) {
            if (typeof exact !== 'number' || exact < cap.min || exact > cap.max) throw overconstrained(key)
          } else if (typeof cap === 'boolean') {
            if (cap === false && exact === true) throw overconstrained(key)
          }
          state.settings[key] = exact
        }
      }
      track.appliedConstraints.push(structuredClone(constraints))
    },
    addEventListener (type, fn) { if (type === 'ended') endedListeners.add(fn) },
    removeEventListener (type, fn) { if (type === 'ended') endedListeners.delete(fn) },
    /* ---- test-side controls ---- */
    emitFrame (frame) {
      if (track.readyState !== 'live') return frame
      for (const fn of [...frameSubscribers]) fn(frame)
      return frame
    },
    onFrame (fn) { frameSubscribers.add(fn); return () => frameSubscribers.delete(fn) },
    endFromDevice () {                    // e.g. camera unplugged / OS revoked
      track.readyState = 'ended'
      for (const fn of [...endedListeners]) fn({ type: 'ended' })
    },
  }
  return track
}

function overconstrained (constraint) {
  const e = new Error(`constraint ${constraint} not satisfiable`)
  e.name = 'OverconstrainedError'
  e.constraint = constraint
  return e
}

export function fakeStream (tracks) {
  const list = Array.isArray(tracks) ? tracks : [tracks]
  return {
    id: `stream-${list.map((t) => t.id).join('+')}`,
    active: true,
    getTracks: () => [...list],
    getVideoTracks: () => list.filter((t) => t.kind === 'video'),
    getAudioTracks: () => list.filter((t) => t.kind === 'audio'),
  }
}

/* ----------------------------------------------------- mediaDevices ------- */

/**
 * @param devices [{deviceId, label, facing, capabilities, settings}]
 * @param failWith error NAME getUserMedia should throw ('NotAllowedError'…)
 */
export function fakeMediaDevices ({ devices = [], failWith = null } = {}) {
  const openStreams = []                  // every stream ever returned
  const calls = []                        // every getUserMedia constraints arg
  const md = {
    calls,
    openStreams,
    async enumerateDevices () {
      return devices.map((d) => ({
        kind: 'videoinput', deviceId: d.deviceId, groupId: d.groupId || d.deviceId,
        label: d.label || '',
      }))
    },
    async getUserMedia (constraints = {}) {
      calls.push(structuredClone(constraints))
      if (failWith) { const e = new Error(failWith); e.name = failWith; throw e }
      const video = constraints.video
      if (!video) { const e = new Error('no video requested'); e.name = 'TypeError'; throw e }
      const want = typeof video === 'object' ? video : {}
      const wantId = want.deviceId?.exact ?? want.deviceId
      const wantFacing = want.facingMode?.exact ?? want.facingMode?.ideal ?? want.facingMode
      let device = null
      if (wantId) device = devices.find((d) => d.deviceId === wantId) || null
      else if (wantFacing) device = devices.find((d) => d.facing === wantFacing) || null
      if (!device) device = devices[0] || null
      if (!device || (wantId && device.deviceId !== wantId)) {
        const e = new Error('no matching camera'); e.name = 'NotFoundError'; throw e
      }
      const track = fakeTrack(device)
      // Requested dimensions land in settings the way a real UA negotiates:
      // in-range values stick, out-of-range ideals fall back to defaults.
      for (const key of ['width', 'height', 'frameRate']) {
        const v = want[key]?.exact ?? want[key]?.ideal ?? (typeof want[key] === 'number' ? want[key] : undefined)
        if (v !== undefined) { try { await track.applyConstraints({ [key]: v }) } catch { /* out of range: keep default */ } }
      }
      const stream = fakeStream(track)
      stream.track = track
      openStreams.push(stream)
      return stream
    },
    /** Leak check: every video track of every stream ever handed out. */
    liveTrackCount: () => openStreams.reduce(
      (n, s) => n + s.getTracks().filter((t) => t.readyState === 'live').length, 0),
  }
  return md
}

/** A mediaDevices whose every method throws — the inertness probe. */
export function throwingMediaDevices (label = 'inert') {
  const boom = (what) => () => { throw new Error(`${label}: mediaDevices.${what} must never be called`) }
  return { getUserMedia: boom('getUserMedia'), enumerateDevices: boom('enumerateDevices') }
}

/* ------------------------------------------------------ ImageCapture ------ */

export function fakeImageCaptureClass ({ photoWidth = 4032, photoHeight = 3024 } = {}) {
  return class FakeImageCapture {
    constructor (track) { this.track = track }
    async takePhoto () {
      if (this.track.readyState !== 'live') { const e = new Error('ended'); e.name = 'InvalidStateError'; throw e }
      // A Blob whose size scales with the fake sensor, so tests can tell the
      // full-resolution photo path from a stream-sized frame grab.
      return new Blob([new Uint8Array(Math.floor((photoWidth * photoHeight) / 1000))], { type: 'image/jpeg' })
    }

    async grabFrame () {
      if (this.track.readyState !== 'live') { const e = new Error('ended'); e.name = 'InvalidStateError'; throw e }
      const s = this.track.getSettings()
      return new FakeImageBitmap(s.width, s.height)
    }
  }
}

/* --------------------------------------------- MediaStreamTrackProcessor -- */

export function fakeTrackProcessorClass () {
  return class FakeMediaStreamTrackProcessor {
    constructor ({ track }) {
      const queue = []
      let wake = null
      let done = false
      track.onFrame((frame) => { queue.push(frame); wake?.(); wake = null })
      this.readable = {
        getReader: () => ({
          async read () {
            for (;;) {
              if (queue.length) return { value: queue.shift(), done: false }
              if (done || track.readyState !== 'live') return { value: undefined, done: true }
              await new Promise((r) => { wake = r })
            }
          },
          releaseLock () {},
          async cancel () { done = true; wake?.() },
        }),
      }
    }
  }
}

/* ----------------------------------------------------- MediaRecorder ------ */

export function fakeMediaRecorderClass ({ supported = ['video/webm;codecs=vp9', 'video/webm'] } = {}) {
  class FakeMediaRecorder {
    static isTypeSupported (type) { return supported.includes(type) }
    constructor (stream, options = {}) {
      this.stream = stream
      this.mimeType = options.mimeType || supported[0] || ''
      this.videoBitsPerSecond = options.videoBitsPerSecond
      this.state = 'inactive'
      this.ondataavailable = null
      this.onstop = null
      this.onerror = null
      this.starts = 0
    }

    start (timeslice) {
      if (this.state !== 'inactive') { const e = new Error('bad state'); e.name = 'InvalidStateError'; throw e }
      this.state = 'recording'; this.timeslice = timeslice; this.starts++
    }

    pause () { if (this.state !== 'recording') { const e = new Error('bad state'); e.name = 'InvalidStateError'; throw e } this.state = 'paused' }
    resume () { if (this.state !== 'paused') { const e = new Error('bad state'); e.name = 'InvalidStateError'; throw e } this.state = 'recording' }
    requestData () { this.emitChunk(0) }
    stop () {
      if (this.state === 'inactive') { const e = new Error('bad state'); e.name = 'InvalidStateError'; throw e }
      this.state = 'inactive'
      this.emitChunk(256)                 // the final flush every recorder does
      this.onstop?.()
    }

    /** Test-side: simulate the UA delivering `bytes` of encoded media. */
    emitChunk (bytes) {
      const data = new Blob([new Uint8Array(bytes)], { type: this.mimeType })
      this.ondataavailable?.({ data })
    }
  }
  return FakeMediaRecorder
}

/* ------------------------------------------------- platform presets ------- */

const backCaps = {
  torch: true,
  zoom: { min: 1, max: 8, step: 0.1 },
  focusMode: ['continuous', 'manual'],
  focusDistance: { min: 0.1, max: 10, step: 0.1 },
  exposureMode: ['continuous', 'manual'],
  exposureCompensation: { min: -3, max: 3, step: 1 / 3 },
  exposureTime: { min: 100, max: 100000 },
  iso: { min: 50, max: 3200 },
  whiteBalanceMode: ['continuous', 'manual'],
  colorTemperature: { min: 2000, max: 8000, step: 100 },
  frameRate: { min: 1, max: 240 },
  width: { min: 1, max: 4032 },
  height: { min: 1, max: 3024 },
}
const frontCaps = {
  focusMode: ['continuous'],
  frameRate: { min: 1, max: 60 },
  width: { min: 1, max: 2316 },
  height: { min: 1, max: 1746 },
}
const minimalCaps = (fps) => ({
  frameRate: { min: 1, max: fps },
  width: { min: 1, max: 1920 },
  height: { min: 1, max: 1080 },
})

function baseDocument () {
  return {
    createElement (tag) {
      if (tag === 'video') return fakeVideoElement()
      if (tag === 'canvas') return fakeCanvas()
      return {}
    },
  }
}

export function fakeVideoElement () {
  const rvfcCallbacks = []
  return {
    videoWidth: 0, videoHeight: 0, srcObject: null, playing: false,
    setAttribute () {},
    async play () {
      this.playing = true
      const t = this.srcObject?.getVideoTracks?.()[0]
      if (t) { const s = t.getSettings(); this.videoWidth = s.width; this.videoHeight = s.height }
    },
    pause () { this.playing = false },
    requestVideoFrameCallback (cb) { rvfcCallbacks.push(cb); return rvfcCallbacks.length },
    cancelVideoFrameCallback () {},
    /** Test-side: present one frame, like the compositor would. */
    emitFrame (now = 0, metadata = {}) {
      const cbs = rvfcCallbacks.splice(0)
      for (const cb of cbs) cb(now, { mediaTime: now / 1000, presentedFrames: 1, width: this.videoWidth, height: this.videoHeight, ...metadata })
    },
  }
}

export function fakeCanvas () {
  const canvas = {
    width: 0,
    height: 0,
    drawn: [],
    getContext (kind) {
      if (kind !== '2d') return null
      return {
        drawImage: (src, ...rest) => { canvas.drawn.push({ src, rest }) },
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        putImageData () {},
      }
    },
    toBlob (cb, type = 'image/png', _q) { cb(new Blob([new Uint8Array(canvas.width * canvas.height ? 512 : 0)], { type })) },
  }
  return canvas
}

function makeEnv ({ devices, features }) {
  const mediaDevices = fakeMediaDevices({ devices })
  const env = {
    navigator: { mediaDevices },
    document: baseDocument(),
    performance: { now: () => Date.now() },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id),
    createImageBitmap: async (src) => {
      const w = src?.videoWidth || src?.width || src?.codedWidth || 640
      const h = src?.videoHeight || src?.height || src?.codedHeight || 480
      return new FakeImageBitmap(w, h, src?.data ?? null)
    },
    Blob,
  }
  if (features.imageCapture) env.ImageCapture = fakeImageCaptureClass(features.imageCapture)
  if (features.trackProcessor) env.MediaStreamTrackProcessor = fakeTrackProcessorClass()
  if (features.webCodecs) { env.VideoEncoder = function VideoEncoder () {}; env.VideoDecoder = function VideoDecoder () {} }
  if (features.mediaRecorder) env.MediaRecorder = fakeMediaRecorderClass({ supported: features.mediaRecorder })
  if (features.rvfc) {
    env.HTMLVideoElement = function HTMLVideoElement () {}
    env.HTMLVideoElement.prototype.requestVideoFrameCallback = function () {}
  }
  return env
}

/** Android-Chrome-like: two cameras, full pro capabilities on the back one,
 *  ImageCapture, WebCodecs, track processor, webm recording. */
export function androidChromeLike () {
  return makeEnv({
    devices: [
      { deviceId: 'front-1', label: 'camera2 1, facing front', facing: 'user', capabilities: frontCaps },
      { deviceId: 'back-1', label: 'camera2 0, facing back', facing: 'environment', capabilities: backCaps },
      { deviceId: 'back-wide-1', label: 'camera2 2, facing back', facing: 'environment', capabilities: { ...backCaps, zoom: { min: 0.5, max: 2, step: 0.1 } } },
    ],
    features: {
      imageCapture: { photoWidth: 4032, photoHeight: 3024 },
      trackProcessor: true,
      webCodecs: true,
      mediaRecorder: ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'],
      rvfc: true,
    },
  })
}

/** iOS-Safari-like: two cameras, ALMOST NO track capabilities, no
 *  ImageCapture, no WebCodecs, mp4 recording only. The honesty benchmark. */
export function iosSafariLike () {
  return makeEnv({
    devices: [
      { deviceId: 'ios-front', label: 'Front Camera', facing: 'user', capabilities: minimalCaps(60) },
      { deviceId: 'ios-back', label: 'Back Camera', facing: 'environment', capabilities: minimalCaps(60) },
    ],
    features: { mediaRecorder: ['video/mp4'], rvfc: true },
  })
}

/** Desktop-Chromium-like: one webcam, no facing hint, no torch/exposure,
 *  ImageCapture + WebCodecs present. The middle of the matrix. */
export function desktopLike () {
  return makeEnv({
    devices: [
      { deviceId: 'webcam-1', label: 'FaceTime HD Camera', capabilities: minimalCaps(60) },
    ],
    features: {
      imageCapture: { photoWidth: 1920, photoHeight: 1080 },
      trackProcessor: true,
      webCodecs: true,
      mediaRecorder: ['video/webm;codecs=vp9', 'video/webm'],
      rvfc: true,
    },
  })
}
