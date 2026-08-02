/**
 * Spot Me — simple energy-based speaker diarization per stream. WS3 design
 * §6.3 ("speaker attribution"), ADR-011b.
 *
 * In this architecture every participant arrives on their OWN stream (the 1:1
 * call has one remote peer; group fan-out is per-speaker pipelines), so
 * diarization here is not the research problem of separating voices inside
 * one waveform — it is the practical one: across N labelled streams, WHO is
 * actively speaking right now, and in which order did speakers hold the
 * floor? That drives caption attribution (`speakerId` on every frame),
 * pin-speaker UI, and cross-talk handling (§6.3: parallel per-speaker
 * pipelines; the mixer ducks per source).
 *
 * Energy + smoothing only, deterministic, injectable frames — the same
 * discipline as vad.js. Each stream gets an exponential moving average of its
 * energy; the dominant stream must beat the runner-up by `dominanceMargin` to
 * TAKE the floor (hysteresis so two people at similar volume don't cause
 * label flapping), and holds it through `holdMs` of quiet.
 */

export const DIARIZER_DEFAULTS = Object.freeze({
  emaAlpha: 0.35,        // smoothing: new = a*sample + (1-a)*old
  activeThreshold: 0.1,  // below this a stream is silent
  dominanceMargin: 0.05, // challenger must beat holder by this much
  holdMs: 400            // floor retained through this much quiet
})

/**
 * Create a diarizer over labelled streams.
 * `push(streamId, { energy, t })` → `{ active, floor, changed }` where
 * `active` is the set of currently-speaking stream ids, `floor` is the
 * dominant speaker (or null), `changed` is true when the floor moved.
 */
export function createDiarizer (opts = {}) {
  const cfg = { ...DIARIZER_DEFAULTS, ...opts }
  const ema = new Map()          // streamId -> smoothed energy
  let floor = null
  let floorSince = 0
  let lastFloorVoiceAt = 0
  const turns = []               // bounded floor-change log
  const MAX_TURNS = 128

  return {
    get floor () { return floor },
    turns: () => turns.slice(),

    push (streamId, frame = {}) {
      if (!streamId || typeof streamId !== 'string') throw new Error('diarizer: streamId required')
      const t = typeof frame.t === 'number' ? frame.t : 0
      const e = typeof frame.energy === 'number' ? frame.energy : 0
      const prev = ema.get(streamId) ?? 0
      const smoothed = cfg.emaAlpha * e + (1 - cfg.emaAlpha) * prev
      ema.set(streamId, smoothed)

      const active = []
      let top = null
      let second = null
      for (const [id, v] of ema) {
        if (v >= cfg.activeThreshold) active.push(id)
        if (!top || v > top.v) { second = top; top = { id, v } } else if (!second || v > second.v) { second = { id, v } }
      }

      let changed = false
      const holderV = floor ? (ema.get(floor) ?? 0) : 0
      if (floor && holderV >= cfg.activeThreshold) lastFloorVoiceAt = t

      if (!floor) {
        if (top && top.v >= cfg.activeThreshold) {
          floor = top.id
          floorSince = t
          lastFloorVoiceAt = t
          changed = true
        }
      } else if (top && top.id !== floor &&
                 top.v >= cfg.activeThreshold &&
                 top.v >= holderV + cfg.dominanceMargin) {
        // A clearly-louder challenger takes the floor (cross-talk resolution).
        floor = top.id
        floorSince = t
        lastFloorVoiceAt = t
        changed = true
      } else if (holderV < cfg.activeThreshold && t - lastFloorVoiceAt >= cfg.holdMs) {
        // The holder went quiet past the hold window.
        floor = (top && top.v >= cfg.activeThreshold) ? top.id : null
        floorSince = floor ? t : floorSince
        if (floor) lastFloorVoiceAt = t
        changed = true
      }

      if (changed) {
        turns.push({ floor, at: t })
        while (turns.length > MAX_TURNS) turns.shift()
      }
      void second
      void floorSince
      return { active: active.sort(), floor, changed }
    },

    reset () {
      ema.clear()
      floor = null
      floorSince = 0
      lastFloorVoiceAt = 0
      turns.length = 0
    }
  }
}
