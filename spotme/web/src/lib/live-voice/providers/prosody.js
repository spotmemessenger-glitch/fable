/**
 * Spot Me — prosody controls → ElevenLabs voice settings. Roadmap V2 §6.2.6,
 * WS3 design §5, ADR-011b.
 *
 * The product speaks in emotions — emotion, intonation, prosody, pace, energy —
 * and ElevenLabs speaks in knobs — stability, similarity_boost, style,
 * use_speaker_boost, speed. This module is the ONE documented mapping between
 * the two, pure and deterministic, so the TTS adapter never hand-rolls magic
 * numbers and a test can pin the exact wire values for a given expressive
 * intent.
 *
 * THE MAPPING, AND WHY (per the ElevenLabs voice-settings model):
 *
 *   emotion    → style. "Style exaggeration" is ElevenLabs' emotive-delivery
 *                control; a flat 0 reads neutral, 1 is maximally expressive.
 *   intonation → stability, INVERTED. Low stability lets pitch and cadence
 *                vary (lively intonation); high stability flattens delivery.
 *                Emotion also erodes stability, weighted lower — an emotional
 *                read with rigid pitch is a contradiction the model resolves
 *                badly.
 *   pace       → speed, CLAMPED to ElevenLabs' documented valid range
 *                [0.7, 1.2]. The pacing controller (§5.3 bounded time-scaling)
 *                may request more; the wire never carries an illegal value.
 *   energy     → use_speaker_boost (presence/projection) at >= 0.5, and a
 *                small style floor so a high-energy read is never fully flat.
 *   (fidelity) → similarity_boost. How tightly to match the enrolled clone's
 *                timbre; defaults high because identity preservation is the
 *                flagship promise (§5.1).
 *
 * Every output is clamped into the provider's legal range HERE, at the seam,
 * so no caller can push an out-of-range value onto the wire.
 */

/** ElevenLabs' documented legal range for the `speed` voice setting. */
export const SPEED_RANGE = Object.freeze({ min: 0.7, max: 1.2 })

/** Neutral prosody — the settings used when no expressive intent is given. */
export const NEUTRAL_PROSODY = Object.freeze({
  emotion: 0.25, intonation: 0.4, pace: 1.0, energy: 0.5, similarity: 0.75
})

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v) => clamp(v, 0, 1)
const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** Round to 3 decimals so wire payloads are stable across platforms. */
const r3 = (v) => Math.round(v * 1000) / 1000

/**
 * Map expressive intent to ElevenLabs voice settings.
 *
 * @param {{emotion?: number, intonation?: number, pace?: number,
 *          energy?: number, similarity?: number}} [prosody]
 *        All 0..1 except `pace` (a rate multiplier, 1.0 = natural).
 * @returns {{stability: number, similarity_boost: number, style: number,
 *            use_speaker_boost: boolean, speed: number}}
 */
export function mapProsodyToVoiceSettings (prosody = {}) {
  const emotion = clamp01(num(prosody.emotion, NEUTRAL_PROSODY.emotion))
  const intonation = clamp01(num(prosody.intonation, NEUTRAL_PROSODY.intonation))
  const pace = num(prosody.pace, NEUTRAL_PROSODY.pace)
  const energy = clamp01(num(prosody.energy, NEUTRAL_PROSODY.energy))
  const similarity = clamp01(num(prosody.similarity, NEUTRAL_PROSODY.similarity))

  // Lively intonation and strong emotion both need freedom to vary; stability
  // is the inverse of that freedom. Weighted 0.6/0.25 so intonation dominates,
  // floored at 0.1 — total instability makes ElevenLabs drift off-voice, which
  // would break the identity promise the clone exists for.
  const stability = clamp(1 - 0.6 * intonation - 0.25 * emotion, 0.1, 1)

  // High energy should never sound fully flat: style gets a small energy floor.
  const style = clamp01(Math.max(emotion, 0.15 * energy))

  return {
    stability: r3(stability),
    similarity_boost: r3(similarity),
    style: r3(style),
    use_speaker_boost: energy >= 0.5,
    speed: r3(clamp(pace, SPEED_RANGE.min, SPEED_RANGE.max))
  }
}

/**
 * The inverse-ish sanity check used by tests and the readiness surface: are
 * these settings legal on the ElevenLabs wire? (Range guard only — semantic
 * quality is the benchmark plan's job, not a predicate's.)
 */
export function isLegalVoiceSettings (vs) {
  if (!vs || typeof vs !== 'object') return false
  const in01 = (x) => typeof x === 'number' && x >= 0 && x <= 1
  return in01(vs.stability) && in01(vs.similarity_boost) && in01(vs.style) &&
    typeof vs.use_speaker_boost === 'boolean' &&
    typeof vs.speed === 'number' && vs.speed >= SPEED_RANGE.min && vs.speed <= SPEED_RANGE.max
}
