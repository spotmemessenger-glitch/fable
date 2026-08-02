/**
 * Spot Me — noise suppression / echo cancellation via WebRTC constraints.
 * WS3 design §3.2 step 1, ADR-011b. CONFIGURATION, NOT DSP.
 *
 * The browser's audio capture stack already ships production-grade acoustic
 * echo cancellation, noise suppression and auto-gain — they are getUserMedia
 * constraints, and turning them on correctly IS the noise-suppression story
 * for MVP (the mission says so explicitly). This module is the single place
 * the translation tap's constraints are defined, so the capture the STT
 * provider hears is clean WITHOUT touching how the CALL acquires its own
 * audio (`src/lib/rooms.js startCall/acceptCall` keep their `{ audio: true }`
 * exactly as shipped — the tap CLONES the call's track; it never re-opens the
 * microphone with different constraints mid-call).
 *
 * 48 kHz mono mirrors the design's capture spec (§3.2 step 1); ElevenLabs
 * Scribe accepts it directly, so no client-side resample is needed.
 */

/** The constraints a DEDICATED translation capture would request. */
export const LIVE_VOICE_AUDIO_CONSTRAINTS = Object.freeze({
  echoCancellation: true,   // the far end's translated audio must not re-enter STT
  noiseSuppression: true,   // browser NS front-ends the STT provider
  autoGainControl: true,    // level-stabilised speech transcribes better
  channelCount: 1,          // mono — STT input; halves uplink
  sampleRate: 48_000        // native capture rate; provider accepts it
})

/**
 * Apply the constraints to an ALREADY-CLONED audio track (best effort —
 * `applyConstraints` is not universally supported and failure is not fatal:
 * the clone still carries the call's own processed audio). Never called on
 * the call's original track.
 *
 * @param {MediaStreamTrack|{applyConstraints?: Function}} track  the CLONE
 * @returns {Promise<{applied: boolean, reason?: string}>}
 */
export async function applyLiveVoiceConstraints (track) {
  if (!track || typeof track.applyConstraints !== 'function') {
    return { applied: false, reason: 'applyConstraints unsupported' }
  }
  try {
    await track.applyConstraints(LIVE_VOICE_AUDIO_CONSTRAINTS)
    return { applied: true }
  } catch (e) {
    return { applied: false, reason: String(e?.message || e) }
  }
}
