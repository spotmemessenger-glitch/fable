/**
 * Spot Me camera — the stream lifecycle: open, switch, release.
 *
 * A session is ONE open camera stream plus everything the engine knows about
 * it. The invariants, in order of how expensive they are to get wrong:
 *
 *   RELEASE IS ABSOLUTE. `release()` stops every track, always, exactly once
 *   in effect and safely many times in practice. A dropped reference leaves
 *   the camera light on until GC, which reads to a user as "this app is
 *   still watching me" — the qr-scan.js lesson, load-bearing here.
 *
 *   NO CAPTURE WITHOUT AN EXPLICIT OPEN. Nothing in this module runs at
 *   import, and nothing opens a stream except `openSession`, which the
 *   engine only exposes behind the flag chain.
 *
 *   EVERY WAIT IS BOUNDED. getUserMedia on a wedged driver can hang forever;
 *   every hardware wait goes through withTimeout and fails with a name.
 *
 * WARM RESTART. Closing and reopening the same camera pays full sensor
 * bring-up (measured in hundreds of ms on phones). Switching cameras first
 * OPENS the new stream, then stops the old one — on multi-camera phones the
 * overlap hides most of the cost; where the platform refuses two opens
 * (single pipeline), the open fails, we release the old stream and retry
 * cold, honestly reporting `strategy: 'cold'` with both timings in metrics.
 */

import { CAMERA_UNAVAILABLE, available, unavailable, reasonFromMediaError } from './availability.js'
import { probeTrack } from './capabilities.js'
import { constraintsFor, classifyFacing } from './devices.js'
import { realClock, withTimeout } from './clock.js'

export const OPEN_TIMEOUT_MS = 10_000     // permission prompt time included
export const SWITCH_TIMEOUT_MS = 8_000

export const SESSION_STATE = Object.freeze({
  LIVE: 'live',
  SWITCHING: 'switching',
  RELEASED: 'released',
})

function stopStream (stream) {
  if (!stream) return
  for (const track of stream.getTracks()) { try { track.stop() } catch { /* already gone */ } }
}

/**
 * Open a camera session.
 *
 * @param selection {deviceId?, facing?, width?, height?, frameRate?}
 * @returns availability envelope; on success `{available:true, session}`.
 */
export async function openSession (selection = {}, { env = globalThis, clock = null, metrics = null } = {}) {
  const md = env.navigator?.mediaDevices
  if (typeof md?.getUserMedia !== 'function') {
    return unavailable(CAMERA_UNAVAILABLE.NO_MEDIA_DEVICES)
  }
  const clk = clock || realClock(env)
  const t0 = clk.now()
  let stream
  try {
    stream = await withTimeout(
      md.getUserMedia(constraintsFor(selection)),
      selection.openTimeoutMs ?? OPEN_TIMEOUT_MS, 'camera open', clk)
  } catch (err) {
    return unavailable(reasonFromMediaError(err), String(err?.message || err))
  }
  const openedInMs = clk.now() - t0
  const session = makeSession({ stream, selection, env, clock: clk, metrics })
  metrics?.record('session.open', openedInMs, { strategy: 'cold' })
  return available({ session, openedInMs, strategy: 'cold' })
}

function makeSession ({ stream, selection, env, clock, metrics }) {
  let state = SESSION_STATE.LIVE
  let currentStream = stream
  let releasedListeners = new Set()

  const track = () => currentStream?.getVideoTracks?.()[0] || null

  const requireLive = () => {
    const t = track()
    if (state !== SESSION_STATE.LIVE || !t || t.readyState !== 'live') {
      return unavailable(CAMERA_UNAVAILABLE.NO_ACTIVE_SESSION, `state=${state}`)
    }
    return null
  }

  /** One bounded applyConstraints against a NAMED capability. The honesty
   *  gate for every pro control: absent capability → UNAVAILABLE, never a
   *  slider that silently does nothing. */
  async function applyControl (capKey, constraints, label) {
    const dead = requireLive()
    if (dead) return dead
    const t = track()
    const caps = probeTrack(t)
    if (!caps[capKey]?.available) {
      return caps[capKey] || unavailable(CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES, capKey)
    }
    try {
      await withTimeout(t.applyConstraints({ advanced: [constraints] }), 2_000, label, clock)
      return available({ applied: constraints })
    } catch (err) {
      if (err?.name === 'OverconstrainedError') {
        return unavailable(CAMERA_UNAVAILABLE.NOT_IN_TRACK_CAPABILITIES, `${label}: out of range`)
      }
      return unavailable(CAMERA_UNAVAILABLE.FAILED, `${label}: ${err?.message || err}`)
    }
  }

  const session = {
    get stream () { return currentStream },
    track,
    state: () => state,
    settings () { const t = track(); try { return t ? t.getSettings() : null } catch { return null } },
    facing () {
      const s = session.settings()
      return classifyFacing(track()?.label, s?.facingMode || null)
    },
    deviceId () { return session.settings()?.deviceId || null },
    /** The live device truth, freshly probed — capabilities can change when
     *  constraints move the track to a different sensor mode. */
    capabilities () { return probeTrack(track()) },
    clock,
    env,

    /* -------------------------------------------------- pro controls ----- */
    /** Each is feature-gated per track capability; see applyControl above. */
    pro: {
      setTorch: (on) => applyControl('torch', { torch: Boolean(on) }, 'torch'),
      setZoom: (zoom) => applyControl('zoom', { zoom }, 'zoom'),
      setFocusMode: (focusMode) => applyControl('focusMode', { focusMode }, 'focusMode'),
      setFocusDistance: (focusDistance) => applyControl('focusDistance', { focusMode: 'manual', focusDistance }, 'focusDistance'),
      setExposureMode: (exposureMode) => applyControl('exposureMode', { exposureMode }, 'exposureMode'),
      setExposureCompensation: (ev) => applyControl('exposureCompensation', { exposureCompensation: ev }, 'exposureCompensation'),
      setExposureTime: (exposureTime) => applyControl('exposureTime', { exposureMode: 'manual', exposureTime }, 'exposureTime'),
      setIso: (iso) => applyControl('iso', { exposureMode: 'manual', iso }, 'iso'),
      setWhiteBalanceMode: (whiteBalanceMode) => applyControl('whiteBalanceMode', { whiteBalanceMode }, 'whiteBalanceMode'),
      setColorTemperature: (colorTemperature) =>
        applyControl('colorTemperature', { whiteBalanceMode: 'manual', colorTemperature }, 'colorTemperature'),
      setFrameRate: (frameRate) => applyControl('frameRate', { frameRate }, 'frameRate'),
    },

    /* ------------------------------------------------------- switching --- */
    /**
     * Switch to another camera. Warm strategy: open new BEFORE closing old,
     * so the pipeline gap is one assignment; cold fallback: release first,
     * then open. The result names which strategy actually ran and both
     * timings, so the startup budget in benchmark-report.md is measured,
     * not asserted.
     */
    async switchTo (nextSelection = {}) {
      const dead = requireLive()
      if (dead) return dead
      state = SESSION_STATE.SWITCHING
      const md = env.navigator.mediaDevices
      const t0 = clock.now()
      let nextStream = null
      let strategy = 'warm'
      try {
        nextStream = await withTimeout(
          md.getUserMedia(constraintsFor(nextSelection)), SWITCH_TIMEOUT_MS, 'camera switch (warm)', clock)
      } catch {
        // Single-pipeline device (or anything else): go cold. Release FIRST,
        // then retry once. If that fails too, the session is over — honest
        // RELEASED state, not a zombie claiming to be live.
        strategy = 'cold'
        stopStream(currentStream)
        try {
          nextStream = await withTimeout(
            md.getUserMedia(constraintsFor(nextSelection)), SWITCH_TIMEOUT_MS, 'camera switch (cold)', clock)
        } catch (err) {
          state = SESSION_STATE.RELEASED
          notifyReleased()
          return unavailable(reasonFromMediaError(err), `switch failed cold: ${err?.message || err}`)
        }
      }
      const previous = currentStream
      currentStream = nextStream
      if (strategy === 'warm') stopStream(previous)
      state = SESSION_STATE.LIVE
      const switchedInMs = clock.now() - t0
      metrics?.record('session.switch', switchedInMs, { strategy })
      return available({ switchedInMs, strategy, deviceId: session.deviceId(), facing: session.facing() })
    },

    /* -------------------------------------------------------- release ---- */
    release () {
      if (state === SESSION_STATE.RELEASED) return available({ alreadyReleased: true })
      state = SESSION_STATE.RELEASED
      stopStream(currentStream)
      notifyReleased()
      return available({})
    },
    onReleased (fn) { releasedListeners.add(fn); return () => releasedListeners.delete(fn) },
  }

  function notifyReleased () {
    const listeners = [...releasedListeners]
    releasedListeners = new Set()
    for (const fn of listeners) { try { fn() } catch { /* listener's problem */ } }
  }

  // The OS can end the track underneath us (camera unplugged, permission
  // revoked mid-session). Surface it as a release so consumers unwind.
  const initial = track()
  if (initial?.addEventListener) {
    initial.addEventListener('ended', () => { if (state === SESSION_STATE.LIVE) session.release() })
  }

  return session
}
