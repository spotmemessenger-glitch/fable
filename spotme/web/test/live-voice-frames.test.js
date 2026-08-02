/**
 * Live-voice wire frames — the schema is the contract (ADR-011, §6.2).
 *
 * These frames cross the (future) encrypted call transport carrying decrypted
 * captions and synthesized audio. Two properties matter enough to pin in a test
 * rather than a comment: audio is base64 TEXT not binary (the transport layer's
 * `parse error` lesson, ITransportAdapter.js), and an unknown control signal is
 * a bug that must throw at construction, not travel and be ignored downstream.
 *
 * Pure: no browser, no network, no provider. Runs on the bare test runner.
 */
import {
  FRAME_TYPES, CONTROL_SIGNALS, FRAME_SCHEMA_VERSION,
  makeAudioInFrame, makePartialCaptionFrame, makeTranslatedAudioOutFrame, makeControlFrame,
  assertFrame, isFrameType
} from '../src/lib/live-voice/frames.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

const ids = { sessionId: 's1', utteranceId: 's1:u1', seq: 0, t: 1000 }

/* -------- audio-in -------- */
check('audio-in frame is well-formed and round-trips through assertFrame', () => {
  const f = makeAudioInFrame({ ...ids, chunk: 'AAAA', codec: 'opus', sampleRate: 48000, final: false })
  assertFrame(f)
  return f.type === FRAME_TYPES.AUDIO_IN && f.chunk === 'AAAA' && f.v === FRAME_SCHEMA_VERSION
})
check('audio-in rejects a binary chunk — audio must be base64 TEXT', () =>
  throws(() => makeAudioInFrame({ ...ids, chunk: new Uint8Array([1, 2, 3]) })))
check('audio-in rejects a missing sessionId', () =>
  throws(() => makeAudioInFrame({ utteranceId: 'u', seq: 0, chunk: 'AAAA' })))
check('audio-in rejects a non-finite seq', () =>
  throws(() => makeAudioInFrame({ ...ids, seq: NaN, chunk: 'AAAA' })))

/* -------- partial-caption -------- */
check('partial-caption carries source text and an optional translation', () => {
  const f = makePartialCaptionFrame({ ...ids, sourceLang: 'en', targetLang: 'ta', text: 'hello', translatedText: '⟨ta⟩ hello', partial: true })
  assertFrame(f)
  return f.type === FRAME_TYPES.PARTIAL_CAPTION && f.sourceLang === 'en' && f.translatedText === '⟨ta⟩ hello' && f.partial === true
})
check('partial-caption is valid with source only (translation not yet ready)', () => {
  const f = makePartialCaptionFrame({ ...ids, sourceLang: 'en', text: 'hel', partial: true })
  assertFrame(f)
  return f.targetLang === null && f.translatedText === null
})
check('partial-caption rejects a missing sourceLang', () =>
  throws(() => makePartialCaptionFrame({ ...ids, text: 'x' })))

/* -------- translated-audio-out -------- */
check('translated-audio-out is well-formed with a consented voiceId', () => {
  const f = makeTranslatedAudioOutFrame({ ...ids, chunk: 'BBBB', targetLang: 'ta', voiceId: 'VOICEabc123', firstAudio: true, final: false })
  assertFrame(f)
  return f.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT && f.voiceId === 'VOICEabc123' && f.firstAudio === true
})
check('translated-audio-out rejects a missing voiceId — no voice is invented (§6.4)', () =>
  throws(() => makeTranslatedAudioOutFrame({ ...ids, chunk: 'BBBB', targetLang: 'ta' })))
check('translated-audio-out rejects a binary chunk', () =>
  throws(() => makeTranslatedAudioOutFrame({ ...ids, chunk: new Uint8Array([9]), targetLang: 'ta', voiceId: 'V' })))

/* -------- control -------- */
check('control frame accepts a known signal and round-trips', () => {
  const f = makeControlFrame({ ...ids, signal: CONTROL_SIGNALS.VOICE_ACTIVE_ON })
  assertFrame(f)
  return f.type === FRAME_TYPES.CONTROL && f.signal === 'voice-active-on'
})
check('control frame REJECTS an unknown signal at construction', () =>
  throws(() => makeControlFrame({ ...ids, signal: 'explode' })))
check('the UX-critical signals exist (voice-active + fallback + interrupt)', () =>
  Boolean(CONTROL_SIGNALS.VOICE_ACTIVE_ON && CONTROL_SIGNALS.VOICE_ACTIVE_OFF &&
    CONTROL_SIGNALS.FALLBACK_CAPTIONS && CONTROL_SIGNALS.INTERRUPT && CONTROL_SIGNALS.DROP))

/* -------- assertFrame / isFrameType -------- */
check('assertFrame rejects an object with a wrong schema version', () =>
  throws(() => assertFrame({ v: 999, type: FRAME_TYPES.CONTROL, sessionId: 's', utteranceId: 'u', seq: 0, signal: 'stop' })))
check('assertFrame rejects an unknown frame type', () =>
  throws(() => assertFrame({ v: FRAME_SCHEMA_VERSION, type: 'nope', sessionId: 's', utteranceId: 'u', seq: 0 })))
check('assertFrame rejects a non-object', () => throws(() => assertFrame(null)))
check('isFrameType recognises the four types and rejects others', () =>
  isFrameType(FRAME_TYPES.AUDIO_IN) && isFrameType(FRAME_TYPES.CONTROL) && !isFrameType('other') && !isFrameType(5))

/* -------- immutability -------- */
check('frames are frozen so a receiver cannot mutate one in place', () => {
  const f = makeControlFrame({ ...ids, signal: CONTROL_SIGNALS.STOP })
  return Object.isFrozen(f)
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice frames — schema is contract')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
