/**
 * Spot Me — energy voice-activity detection with hangover. WS3 design §3.2
 * step 1, §8.2 ("client VAD gates silence uplink"), ADR-011b.
 *
 * PURE AND FRAME-DRIVEN. The detector consumes `{ energy, t }` frames — the
 * energy extractor is INJECTED (in the browser it is an AnalyserNode/
 * AudioWorklet RMS; in tests it is an array) — so the state machine is
 * deterministic and testable without any audio API. It does three jobs:
 *
 *   OPEN a segment when energy crosses `openThreshold` for `openFrames`
 *   consecutive frames (debounce — a door slam is not speech).
 *   HOLD it open through short dips via `hangoverMs` (natural inter-word
 *   silence must not chop an utterance into confetti).
 *   CLOSE it when silence outlasts the hangover, or when the segment hits
 *   `maxSegmentMs` (the design's max-segment timer — a monologue still has to
 *   translate before it ends).
 *
 * Segments are the unit EVERYTHING downstream keys on: each closed segment is
 * one STT sub-post (elevenlabs-stt.js), one caption unit, one latency-budget
 * `capture` mark. The VAD is therefore the pipeline's metronome, and its
 * output is a plain event list a test can assert exactly.
 */

export const VAD_DEFAULTS = Object.freeze({
  openThreshold: 0.12,   // normalized 0..1 energy to open
  closeThreshold: 0.08,  // lower close bound (hysteresis: open high, close low)
  openFrames: 2,         // consecutive hot frames to open (debounce)
  hangoverMs: 240,       // silence tolerated inside a segment
  maxSegmentMs: 8_000,   // force-close ceiling (the max-segment timer)
  frameMs: 20            // assumed frame cadence when `t` is not supplied
})

/**
 * Create a VAD instance. `push({energy, t})` returns an event or null:
 *   { type: 'open',  t }
 *   { type: 'close', t, durationMs, reason: 'silence'|'max-segment'|'flush' }
 * `flush()` closes any open segment (end of stream / mute).
 */
export function createVad (opts = {}) {
  const cfg = { ...VAD_DEFAULTS, ...opts }
  let open = false
  let hotRun = 0
  let openedAt = 0
  let lastVoiceAt = 0
  let lastT = null
  let segments = 0

  function frameTime (t) {
    if (typeof t === 'number' && Number.isFinite(t)) { lastT = t; return t }
    lastT = lastT == null ? 0 : lastT + cfg.frameMs
    return lastT
  }

  return {
    get open () { return open },
    get segments () { return segments },

    push (frame = {}) {
      const t = frameTime(frame.t)
      const energy = typeof frame.energy === 'number' ? frame.energy : 0
      if (!open) {
        if (energy >= cfg.openThreshold) {
          hotRun += 1
          if (hotRun >= cfg.openFrames) {
            open = true
            hotRun = 0
            openedAt = t
            lastVoiceAt = t
            return { type: 'open', t }
          }
        } else {
          hotRun = 0
        }
        return null
      }
      // open
      if (energy >= cfg.closeThreshold) lastVoiceAt = t
      if (t - openedAt >= cfg.maxSegmentMs) {
        open = false
        segments += 1
        return { type: 'close', t, durationMs: t - openedAt, reason: 'max-segment' }
      }
      if (t - lastVoiceAt >= cfg.hangoverMs) {
        open = false
        segments += 1
        return { type: 'close', t, durationMs: t - openedAt, reason: 'silence' }
      }
      return null
    },

    flush () {
      if (!open) return null
      open = false
      segments += 1
      const t = lastT == null ? 0 : lastT
      return { type: 'close', t, durationMs: t - openedAt, reason: 'flush' }
    }
  }
}
