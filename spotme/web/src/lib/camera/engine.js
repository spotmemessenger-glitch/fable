/**
 * Spot Me camera — the engine factory: the single front door.
 *
 * `createCameraEngine()` with shipped defaults returns the INERT STUB —
 * and inert means CONSTRUCTS NOTHING: no capability probe, no device
 * enumeration, no timer armed, no property of `env` so much as read. The
 * fence test proves it by handing the factory a clock and a mediaDevices
 * whose every member throws. Every method on the stub answers
 * UNAVAILABLE(FLAG_DISABLED), async where the live method is async, so
 * callers written against the live shape run unchanged against the dark
 * one.
 *
 * The LIVE engine exists only when the wiring PR passes explicit flags
 * (see docs/ai-camera/activation-guide.md): every capability namespace is
 * gated on ITS OWN flag under the resolved chain, and `availability()`
 * merges flag state with device truth — flag off beats device-capable,
 * because rollback must win arguments with hardware.
 */

import { resolveFlags, isMasterEnabled } from './flags.js'
import { CAMERA_UNAVAILABLE, available, unavailable } from './availability.js'
import { probeBrowser, probeTrack, featureAvailability } from './capabilities.js'
import { listCameras } from './devices.js'
import { openSession } from './session.js'
import { createFrameSource } from './frame-source.js'
import { createPipeline } from './pipeline.js'
import { captureBracket, fuseExposures } from './hdr.js'
import { stackFrames } from './night.js'
import { createSegmenterRegistry, renderPortrait, applyPortrait } from './portrait.js'
import { createRecorder } from './video.js'
import { createTimelapse } from './timelapse.js'
import { prepareSlowmo, captureSlowmo, assembleSlowmo } from './slowmo.js'
import { captureBurst, releaseBurst } from './burst.js'
import { createStabilizer, stabilizerStage, stabilizeFrame, stabilizationAvailability } from './stabilize.js'
import { createMetrics } from './metrics.js'
import { realClock } from './clock.js'

const FEATURE_FLAG = Object.freeze({
  hdr: 'CAMERA_HDR_ENABLED',
  night: 'CAMERA_NIGHT_ENABLED',
  portrait: 'CAMERA_PORTRAIT_ENABLED',
  burst: 'CAMERA_BURST_ENABLED',
  video: 'CAMERA_VIDEO_ENABLED',
  slowmo: 'CAMERA_SLOWMO_ENABLED',
  timelapse: 'CAMERA_TIMELAPSE_ENABLED',
  stabilization: 'CAMERA_STABILIZATION_ENABLED',
  proControls: 'CAMERA_PRO_CONTROLS_ENABLED',
})

/**
 * The live method surface, per namespace, AS DATA — `true` where the live
 * method is async.
 *
 * The stub's whole promise is that a dark call site cannot crash into
 * `undefined`. That is only true if the stub carries every name the live
 * engine carries, and a hand-copied list stops being true the first time a
 * namespace grows a method. So the names live here once, the stub is built
 * FROM them, and `camera-engine.test.js` asserts the live engine's namespace
 * keys match — a namespace that gains a method without updating this table
 * fails the suite instead of failing a user in the dark.
 */
export const FEATURE_METHODS = Object.freeze({
  hdr: Object.freeze({ availability: false, captureBracket: true, fuse: false }),
  night: Object.freeze({ availability: false, stack: false }),
  portrait: Object.freeze({ availability: false, render: true, applyMask: false }),
  video: Object.freeze({ availability: false, createRecorder: false }),
  timelapse: Object.freeze({ availability: false, create: false }),
  slowmo: Object.freeze({ availability: false, prepare: true, capture: false, assemble: true }),
  burst: Object.freeze({ availability: false, capture: true, release: false }),
  stabilization: Object.freeze({
    availability: false, create: false, stage: false, applyFrame: false,
  }),
  proControls: Object.freeze({ availability: false, of: false }),
})

export function createCameraEngine ({ flags = {}, env = null, clock = null } = {}) {
  const resolved = resolveFlags(flags)
  if (!isMasterEnabled(resolved)) return inertEngine(resolved)
  return liveEngine(resolved, env || globalThis, clock)
}

/* --------------------------------------------------------- the stub ------ */

function inertEngine (resolved) {
  const dark = (detail) => unavailable(CAMERA_UNAVAILABLE.FLAG_DISABLED, detail)
  const darkAsync = (detail) => async () => dark(detail)
  const darkSync = (detail) => () => dark(detail)
  /** Every live entry point of the namespace exists here under the same
   *  name, async where the live one is async — see FEATURE_METHODS. */
  const feature = (name, methods) => {
    const stub = {}
    for (const [method, isAsync] of Object.entries(methods)) {
      stub[method] = isAsync ? darkAsync(name) : darkSync(name)
    }
    return Object.freeze(stub)
  }
  return Object.freeze({
    enabled: false,
    flags: resolved,
    availability: darkSync('CAMERA_ENGINE_ENABLED'),
    listDevices: darkAsync('CAMERA_ENGINE_ENABLED'),
    openSession: darkAsync('CAMERA_ENGINE_ENABLED'),
    createFrameSource: darkSync('CAMERA_ENGINE_ENABLED'),
    createPipeline: darkSync('CAMERA_ENGINE_ENABLED'),
    metrics: darkSync('CAMERA_ENGINE_ENABLED'),
    segmenters: Object.freeze({
      register: darkSync('CAMERA_PORTRAIT_ENABLED'),
      unregister: darkSync('CAMERA_PORTRAIT_ENABLED'),
      availability: darkSync('CAMERA_PORTRAIT_ENABLED'),
      current: () => null,
    }),
    hdr: feature('CAMERA_HDR_ENABLED', FEATURE_METHODS.hdr),
    night: feature('CAMERA_NIGHT_ENABLED', FEATURE_METHODS.night),
    portrait: feature('CAMERA_PORTRAIT_ENABLED', FEATURE_METHODS.portrait),
    video: feature('CAMERA_VIDEO_ENABLED', FEATURE_METHODS.video),
    timelapse: feature('CAMERA_TIMELAPSE_ENABLED', FEATURE_METHODS.timelapse),
    slowmo: feature('CAMERA_SLOWMO_ENABLED', FEATURE_METHODS.slowmo),
    burst: feature('CAMERA_BURST_ENABLED', FEATURE_METHODS.burst),
    stabilization: feature('CAMERA_STABILIZATION_ENABLED', FEATURE_METHODS.stabilization),
    proControls: feature('CAMERA_PRO_CONTROLS_ENABLED', FEATURE_METHODS.proControls),
  })
}

/* -------------------------------------------------------- the engine ----- */

function liveEngine (resolved, env, clockIn) {
  const clock = clockIn || realClock(env)
  const metrics = createMetrics(clock)
  const segmenters = createSegmenterRegistry()

  /** Feature gate: its flag under the (already-lit) chain, else the same
   *  machine-readable refusal the stub gives. */
  const gate = (feature) => (resolved[FEATURE_FLAG[feature]]
    ? null
    : unavailable(CAMERA_UNAVAILABLE.FLAG_DISABLED, FEATURE_FLAG[feature]))

  const gatedAsync = (feature, fn) => async (...args) => gate(feature) || fn(...args)
  const gatedSync = (feature, fn) => (...args) => gate(feature) || fn(...args)

  const engine = {
    enabled: true,
    flags: resolved,
    metrics: () => metrics.snapshot(),

    listDevices: () => listCameras(env),
    openSession: (selection = {}) => openSession(selection, { env, clock, metrics }),
    createFrameSource: (session, opts = {}) => createFrameSource(session, { env, clock, metrics, ...opts }),
    createPipeline: (opts = {}) => createPipeline({ env, ...opts }),
    segmenters,

    /** Flag state MERGED over device truth, flag winning — see header. */
    availability (session = null) {
      const browser = probeBrowser(env)
      const track = session?.track?.() || null
      const device = featureAvailability(browser, track ? probeTrack(track) : null)
      const merged = {}
      for (const [feature, answer] of Object.entries(device)) {
        const flagName = FEATURE_FLAG[feature]
        merged[feature] = flagName && !resolved[flagName]
          ? unavailable(CAMERA_UNAVAILABLE.FLAG_DISABLED, flagName)
          : answer
      }
      // Portrait truth includes the live registry, not just the static map.
      if (resolved.CAMERA_PORTRAIT_ENABLED) merged.portrait = segmenters.availability()
      return Object.freeze(merged)
    },

    hdr: Object.freeze({
      availability: gatedSync('hdr', (session) => session
        ? (session.capabilities().exposureCompensation?.available
            ? available({}) : unavailable(CAMERA_UNAVAILABLE.NO_EXPOSURE_CONTROL))
        : unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION)),
      captureBracket: gatedAsync('hdr', (session, source, opts) => captureBracket(session, source, { clock, ...opts })),
      fuse: gatedSync('hdr', (images, opts) => fuseExposures(images, opts)),
    }),

    night: Object.freeze({
      availability: gatedSync('night', () => available({})),
      stack: gatedSync('night', (frames, opts) => stackFrames(frames, opts)),
    }),

    portrait: Object.freeze({
      availability: gatedSync('portrait', () => segmenters.availability()),
      render: gatedAsync('portrait', (image, opts) => renderPortrait(segmenters, image, opts)),
      applyMask: gatedSync('portrait', (image, mask, opts) => applyPortrait(image, mask, opts)),
    }),

    video: Object.freeze({
      availability: gatedSync('video', () => available({})),
      createRecorder: gatedSync('video', (stream, opts) => createRecorder(stream, { env, clock, metrics, ...opts })),
    }),

    timelapse: Object.freeze({
      availability: gatedSync('timelapse', () => available({})),
      create: gatedSync('timelapse', (source, opts) => createTimelapse(source, { env, clock, metrics, ...opts })),
    }),

    slowmo: Object.freeze({
      availability: gatedSync('slowmo', (session) => session
        ? session.capabilities().highFps
        : unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION)),
      prepare: gatedAsync('slowmo', (session, opts) => prepareSlowmo(session, opts)),
      capture: gatedSync('slowmo', (source, opts) => captureSlowmo(source, { env, clock, ...opts })),
      assemble: gatedAsync('slowmo', (captured, opts) => assembleSlowmo(captured, { env, clock, ...opts })),
    }),

    burst: Object.freeze({
      availability: gatedSync('burst', () => available({})),
      capture: gatedAsync('burst', (session, source, opts) => captureBurst(session, source, { env, clock, ...opts })),
      release: releaseBurst,
    }),

    stabilization: Object.freeze({
      availability: gatedSync('stabilization', (tier) => stabilizationAvailability(tier)),
      create: gatedSync('stabilization', (opts) => createStabilizer(opts)),
      stage: gatedSync('stabilization', (stabilizer, opts) => stabilizerStage(stabilizer, opts)),
      applyFrame: gatedSync('stabilization', (image, correction, margin) => stabilizeFrame(image, correction, margin)),
    }),

    proControls: Object.freeze({
      availability: gatedSync('proControls', (session) => session
        ? available({ controls: session.capabilities() })
        : unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION)),
      /** The session's pro surface, behind the flag: wiring code asks the
       *  engine, never reaches around it. */
      of: gatedSync('proControls', (session) => available({ pro: session.pro })),
    }),
  }
  return Object.freeze(engine)
}
