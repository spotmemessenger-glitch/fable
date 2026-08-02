/**
 * Live-voice orchestrator — the pipeline skeleton, end-to-end on stubs
 * (ADR-011, §6.2).
 *
 * This is the integration proof for the scaffolding: the STT→MT→(LLM)→TTS→
 * playback wiring, the state machine, the latency budget, and the wire frames
 * are exercised together, deterministically, on stub adapters and a fake clock.
 * No provider, no network, no microphone, no crypto. It asserts the happy path
 * AND the three branches that make the feature safe: barge-in, over-budget
 * fallback-to-captions, and captions-only when there is no consented voice.
 */
import {
  createLiveVoiceOrchestrator
} from '../src/lib/live-voice/orchestrator.js'
import {
  makeManualClock, createStubStreamingStt, createStubStreamingMt,
  createStubStreamingTts, createStubCorrector, createStubPlayback
} from '../src/lib/live-voice/stub-adapters.js'
import { assertFrame, FRAME_TYPES, CONTROL_SIGNALS } from '../src/lib/live-voice/frames.js'
import { UTTERANCE_STATES as U } from '../src/lib/live-voice/session-state.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const VOICE = 'VOICEclone123'          // a CONSENTED profile id (§6.4)

function build (overrides = {}) {
  const clock = makeManualClock(0)
  const orch = createLiveVoiceOrchestrator({
    stt: overrides.stt || createStubStreamingStt({ clock }),
    mt: overrides.mt || createStubStreamingMt({ clock }),
    tts: overrides.tts || createStubStreamingTts({ clock }),
    corrector: 'corrector' in overrides ? overrides.corrector : createStubCorrector({ clock }),
    playback: overrides.playback || createStubPlayback({ clock }),
    clock: clock.now
  })
  return { orch, clock }
}

/* -------- happy path -------- */
await checkAsync('runs end-to-end and lands in COMPLETED', async () => {
  const { orch } = build()
  const r = await orch.processUtterance({ sessionId: 's1', script: 'hello world how are you', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  return r.state === U.COMPLETED && r.completed === true
})
await checkAsync('walks the full state path in order', async () => {
  const { orch } = build()
  const r = await orch.processUtterance({ sessionId: 's1', script: 'a b c', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  const path = r.history.map((h) => h.state).join(' ')
  return path === [U.IDLE, U.LISTENING, U.TRANSCRIBING, U.TRANSLATING, U.CORRECTING, U.SYNTHESIZING, U.PLAYING, U.COMPLETED].join(' ')
})
await checkAsync('produces the transcript, a tagged translation, and audio chunks', async () => {
  const { orch } = build()
  const r = await orch.processUtterance({ sessionId: 's1', script: 'hello world', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  return r.transcript === 'hello world' && r.translation === '⟨ta⟩ hello world' && r.audioChunks.length === 3
})
await checkAsync('every emitted frame is a valid frame, in the right order of types', async () => {
  const { orch } = build()
  const r = await orch.processUtterance({ sessionId: 's1', script: 'hi you', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  for (const f of r.frames) assertFrame(f)
  const types = r.frames.map((f) => f.type)
  const hasCaption = types.includes(FRAME_TYPES.PARTIAL_CAPTION)
  const hasAudio = types.includes(FRAME_TYPES.TRANSLATED_AUDIO_OUT)
  // voice-active must be signalled ON before the first audio frame (§6.4).
  const firstAudioIdx = types.indexOf(FRAME_TYPES.TRANSLATED_AUDIO_OUT)
  const voiceOnIdx = r.frames.findIndex((f) => f.type === FRAME_TYPES.CONTROL && f.signal === CONTROL_SIGNALS.VOICE_ACTIVE_ON)
  return hasCaption && hasAudio && voiceOnIdx >= 0 && voiceOnIdx < firstAudioIdx
})
await checkAsync('stays within the <2.5 s budget on the default stub timings', async () => {
  const { orch } = build()
  const r = await orch.processUtterance({ sessionId: 's1', script: 'a b c d', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  return r.budget.withinBudget === true && r.budget.measuredMs <= 2500 && r.budget.perStage.length === 7
})
await checkAsync('is deterministic — same input, identical result twice', async () => {
  const run = async () => {
    const { orch } = build()
    const r = await orch.processUtterance({ sessionId: 's1', script: 'same input here', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
    return JSON.stringify({ t: r.transcript, x: r.translation, ms: r.budget.measuredMs, a: r.audioChunks })
  }
  const first = await run()
  const second = await run()
  return first === second
})

/* -------- optional correction skipped -------- */
await checkAsync('with no corrector, translating goes straight to synthesizing', async () => {
  const { orch } = build({ corrector: null })
  const r = await orch.processUtterance({ sessionId: 's1', script: 'x y', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  const states = r.history.map((h) => h.state)
  return r.state === U.COMPLETED && !states.includes(U.CORRECTING)
})

/* -------- barge-in -------- */
await checkAsync('barge-in cancels mid-flight → interrupted → dropped, no audio', async () => {
  const { orch } = build()
  const h = orch.start({ sessionId: 's1', script: 'this will be cut off', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  h.cancel('barge-in')
  const r = await h.done
  const states = r.history.map((s) => s.state)
  return r.interrupted === true && r.state === U.DROPPED &&
    states.includes(U.INTERRUPTED) && !r.frames.some((f) => f.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT)
})

/* -------- over-budget fallback -------- */
await checkAsync('over-budget before TTS falls back to captions and drops the audio (§6.2.8)', async () => {
  const clock = makeManualClock(0)
  const orch = createLiveVoiceOrchestrator({
    stt: createStubStreamingStt({ clock, finalMs: 3000 }),   // blow the budget in STT
    mt: createStubStreamingMt({ clock }),
    tts: createStubStreamingTts({ clock }),
    playback: createStubPlayback({ clock }),
    clock: clock.now
  })
  const r = await orch.processUtterance({ sessionId: 's1', script: 'too slow', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  const signals = r.frames.filter((f) => f.type === FRAME_TYPES.CONTROL).map((f) => f.signal)
  return r.fallback === true && r.state === U.DROPPED &&
    r.budget.withinBudget === false &&
    signals.includes(CONTROL_SIGNALS.FALLBACK_CAPTIONS) &&
    !r.frames.some((f) => f.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT)
})

/* -------- no consented voice → captions only -------- */
await checkAsync('no voice profile → captions only, no synthesized audio, no invented voice', async () => {
  const { orch } = build()
  const r = await orch.processUtterance({ sessionId: 's1', script: 'no voice here', sourceLang: 'en', targetLang: 'ta', voiceProfileId: null })
  return r.fallback === true && r.translation === '⟨ta⟩ no voice here' &&
    r.frames.some((f) => f.type === FRAME_TYPES.PARTIAL_CAPTION) &&
    !r.frames.some((f) => f.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT)
})

/* -------- provider throw → drop, never a rejected promise -------- */
await checkAsync('a throwing provider becomes a DROPPED result, not a rejection', async () => {
  const clock = makeManualClock(0)
  const badMt = {
    open () {}, close () {}, status: () => 'idle',
    capabilities: () => ({ partial: true, firstToken: true, cancel: true }),
    translate () { return { cancel () {}, done: Promise.reject(new Error('mt exploded')) } }
  }
  const orch = createLiveVoiceOrchestrator({
    stt: createStubStreamingStt({ clock }), mt: badMt,
    tts: createStubStreamingTts({ clock }), playback: createStubPlayback({ clock }), clock: clock.now
  })
  const r = await orch.processUtterance({ sessionId: 's1', script: 'boom', sourceLang: 'en', targetLang: 'ta', voiceProfileId: VOICE })
  return r.dropped === true && r.state === U.DROPPED && /mt exploded/.test(r.error)
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice orchestrator — e2e on stubs')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
