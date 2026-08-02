/**
 * Spot Me — Live Voice wire frames. Roadmap V2 §6.2, ADR-011.
 *
 * JavaScript has no types, so — exactly as `transport/ITransportAdapter.js`
 * makes the transport contract checkable — this file makes the streaming frame
 * schemas checkable: a frozen type list, one factory per frame that validates
 * its own shape, and one `assertFrame` the tests run instead of a comment.
 *
 * Four frame types cross the live-voice pipeline (§6.2):
 *   audio-in            captured mic audio, segmented, flowing toward STT.
 *   partial-caption     an interim or final transcript/translation line.
 *   translated-audio-out synthesized speech flowing back to playback.
 *   control             lifecycle + UX signals (start/stop/interrupt/fallback).
 *
 * TWO LESSONS ARE PINNED HERE ON PURPOSE.
 *
 * 1. AUDIO IS BASE64 TEXT, NEVER A Buffer/TypedArray. `makeFrame` in the
 *    transport layer learned this the hard way: socket.io frames each binary
 *    separately after the JSON packet and the decoder then reads text where it
 *    expects bytes and drops the socket with `parse error`. A live audio stream
 *    is the last place that should rediscover it, so `chunk` is asserted to be
 *    a string here.
 *
 * 2. CAPTIONS ARE DECRYPTED CONTENT. A partial-caption carries plaintext the
 *    user is speaking. Roadmap §6.3/§6.4 forbid retaining raw voice or leaking
 *    more than the enabled feature needs, and §6.3 forbids ever claiming full
 *    e2e privacy once a cloud provider sees this. These frames therefore travel
 *    the call's own encrypted transport; they are not a side channel. The schema
 *    carries no user identifiers beyond the opaque session/utterance ids.
 */

/** The four frame types on the live-voice wire. */
export const FRAME_TYPES = Object.freeze({
  AUDIO_IN: 'audio-in',
  PARTIAL_CAPTION: 'partial-caption',
  TRANSLATED_AUDIO_OUT: 'translated-audio-out',
  CONTROL: 'control'
})

/**
 * Control signals. These are the UX-visible truths of §6.3/§6.4: the listener
 * must see when synthesized audio is active, and degradation must be explicit.
 */
export const CONTROL_SIGNALS = Object.freeze({
  START: 'start',                     // begin a live-translation session
  STOP: 'stop',                       // end it
  INTERRUPT: 'interrupt',             // barge-in: abandon the in-flight utterance
  MUTE_ORIGINAL: 'mute-original',     // listener chose translated-only
  UNMUTE_ORIGINAL: 'unmute-original',
  VOICE_ACTIVE_ON: 'voice-active-on',   // AI-generated speech indicator ON (§6.4)
  VOICE_ACTIVE_OFF: 'voice-active-off',
  FALLBACK_CAPTIONS: 'fallback-captions', // AI degraded: captions/original only (§6.2.8)
  DROP: 'drop'                        // utterance dropped (error/timeout)
})

const CONTROL_SET = new Set(Object.values(CONTROL_SIGNALS))

/** Current wire schema version. Bumped when a frame shape changes. */
export const FRAME_SCHEMA_VERSION = 1

/* ------------------------------------------------------------------ shared */

function reqStr (v, field) {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`frame: ${field} required (non-empty string)`)
  return v
}

function reqNum (v, field) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`frame: ${field} must be a finite number`)
  return v
}

/* Every frame shares an envelope: version, type, the opaque session/utterance
 * ids that scope it, a monotonic seq within the utterance, and a capture/emit
 * timestamp in ms. `t` is a number so a receiver can measure lag without
 * parsing. */
function envelope ({ type, sessionId, utteranceId, seq, t }) {
  return {
    v: FRAME_SCHEMA_VERSION,
    type,
    sessionId: reqStr(sessionId, 'sessionId'),
    utteranceId: reqStr(utteranceId, 'utteranceId'),
    seq: reqNum(seq, 'seq'),
    t: t == null ? Date.now() : reqNum(t, 't')
  }
}

/* ------------------------------------------------------------- factories */

/**
 * Captured audio heading toward STT. `chunk` is base64 TEXT (see file header),
 * `final` marks the last chunk of a voice-activity segment so STT can close the
 * utterance without a timer.
 */
export function makeAudioInFrame ({ sessionId, utteranceId, seq, t, chunk, codec = 'opus', sampleRate = 48000, final = false }) {
  reqStr(chunk, 'chunk')            // base64 text, NOT binary — pinned lesson.
  reqStr(codec, 'codec')
  reqNum(sampleRate, 'sampleRate')
  return Object.freeze({
    ...envelope({ type: FRAME_TYPES.AUDIO_IN, sessionId, utteranceId, seq, t }),
    codec, sampleRate, chunk, final: final === true
  })
}

/**
 * An interim or final caption line. Carries both source transcript and, once
 * translated, the target text — so a UI can show original + translation and the
 * `partial` flag tells it when a line will still change.
 */
export function makePartialCaptionFrame ({ sessionId, utteranceId, seq, t, sourceLang, targetLang = null, text, translatedText = null, partial = true }) {
  reqStr(sourceLang, 'sourceLang')
  reqStr(text, 'text')
  if (targetLang != null) reqStr(targetLang, 'targetLang')
  if (translatedText != null && typeof translatedText !== 'string') throw new Error('frame: translatedText must be a string or null')
  return Object.freeze({
    ...envelope({ type: FRAME_TYPES.PARTIAL_CAPTION, sessionId, utteranceId, seq, t }),
    sourceLang, targetLang, text, translatedText, partial: partial === true
  })
}

/**
 * Synthesized translated speech heading to playback. `chunk` is base64 TEXT.
 * `firstAudio` marks the first chunk of the utterance — the frame whose arrival
 * time is the "translated voice first-audio latency" the budget measures (§6.5).
 * `voiceId` is the speaker's CONSENTED profile (ADR-011 voice-clone reuse note).
 */
export function makeTranslatedAudioOutFrame ({ sessionId, utteranceId, seq, t, chunk, codec = 'mp3', targetLang, voiceId, firstAudio = false, final = false }) {
  reqStr(chunk, 'chunk')            // base64 text, NOT binary.
  reqStr(codec, 'codec')
  reqStr(targetLang, 'targetLang')
  reqStr(voiceId, 'voiceId')
  return Object.freeze({
    ...envelope({ type: FRAME_TYPES.TRANSLATED_AUDIO_OUT, sessionId, utteranceId, seq, t }),
    codec, targetLang, voiceId, chunk,
    firstAudio: firstAudio === true, final: final === true
  })
}

/**
 * A lifecycle/UX signal. `signal` must be one of CONTROL_SIGNALS — an unknown
 * signal is a bug, not a forward-compatible unknown, so it throws here rather
 * than travelling and being ignored at the far end.
 */
export function makeControlFrame ({ sessionId, utteranceId = 'session', seq = 0, t, signal, reason = null }) {
  reqStr(signal, 'signal')
  if (!CONTROL_SET.has(signal)) {
    throw new Error(`frame: unknown control signal "${signal}" — use one of ${[...CONTROL_SET].join(', ')}`)
  }
  if (reason != null && typeof reason !== 'string') throw new Error('frame: reason must be a string or null')
  return Object.freeze({
    ...envelope({ type: FRAME_TYPES.CONTROL, sessionId, utteranceId, seq, t }),
    signal, reason
  })
}

/* ------------------------------------------------------------- validation */

const FRAME_TYPE_SET = new Set(Object.values(FRAME_TYPES))

/** True iff `x` is one of the four known frame types. */
export function isFrameType (x) {
  return typeof x === 'string' && FRAME_TYPE_SET.has(x)
}

/**
 * Throw unless `frame` is a well-formed frame of a known type. Re-validates by
 * running the matching factory, so "valid" means exactly "the factory would
 * have produced it" — one definition of validity, not two that can drift.
 */
export function assertFrame (frame, label = 'frame') {
  if (!frame || typeof frame !== 'object') throw new Error(`${label}: not an object`)
  if (frame.v !== FRAME_SCHEMA_VERSION) throw new Error(`${label}: schema version ${frame.v} != ${FRAME_SCHEMA_VERSION}`)
  if (!isFrameType(frame.type)) throw new Error(`${label}: unknown type "${frame.type}"`)
  switch (frame.type) {
    case FRAME_TYPES.AUDIO_IN: makeAudioInFrame(frame); return
    case FRAME_TYPES.PARTIAL_CAPTION: makePartialCaptionFrame(frame); return
    case FRAME_TYPES.TRANSLATED_AUDIO_OUT: makeTranslatedAudioOutFrame(frame); return
    case FRAME_TYPES.CONTROL: makeControlFrame(frame); return
    default: throw new Error(`${label}: unhandled type "${frame.type}"`)
  }
}
