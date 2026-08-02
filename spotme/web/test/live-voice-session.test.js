/**
 * LiveVoiceSession — per-direction pipelines, shared STT, captions-before-
 * speech, barge-in, reconnect, ladder wiring, latency accounting, group
 * fan-out as REAL session logic (ADR-011b; mission item 3). Deterministic:
 * stubs + manual clock.
 *
 *   node test/live-voice-session.test.js
 */
import { createLiveVoiceSession, NEUTRAL_VOICE_ID } from '../src/lib/live-voice/live-session.js'
import { createStubStreamingStt, createStubStreamingMt, createStubStreamingTts, makeManualClock } from '../src/lib/live-voice/stub-adapters.js'
import { createDegradationLadder } from '../src/lib/live-voice/quality/degradation-ladder.js'
import { FRAME_TYPES, assertFrame } from '../src/lib/live-voice/frames.js'
import { SESSION_STATES } from '../src/lib/live-voice/session-state.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const A = { id: 'A', listenLang: 'en', speakLang: 'en', voiceId: 'VOICEaaaa1111', consented: true }
const B = { id: 'B', listenLang: 'ta', speakLang: 'ta', voiceId: 'VOICEbbbb2222', consented: true }
const C = { id: 'C', listenLang: 'hi' }

function build ({ participants = [A, B], flags = { liveTranslation: true, voiceClone: true, liveCaptions: true }, ladder = null, group = false } = {}) {
  const clock = makeManualClock(0)
  const deliveries = []
  const scheduled = new Map() // participantId -> chunks
  const session = createLiveVoiceSession({
    sessionId: 'sess1',
    participants,
    adapters: {
      stt: createStubStreamingStt({ clock }),
      mt: createStubStreamingMt({ clock }),
      tts: createStubStreamingTts({ clock })
    },
    flags: group ? { ...flags, groupTranslation: true } : flags,
    clock: clock.now,
    ladder: ladder || undefined,
    deliver: (d) => deliveries.push(d),
    playbackFor: (id) => ({ schedule: (chunk) => { const arr = scheduled.get(id) || []; arr.push(chunk); scheduled.set(id, arr); return Promise.resolve() } })
  })
  return { session, deliveries, scheduled, clock }
}

/* -------- 1:1 happy path -------- */
await checkAsync('A speaks → B receives captions then clone-voiced audio', async () => {
  const { session, deliveries } = build()
  const r = await session.speech('A', { script: 'hello there my friend', sourceLang: 'en' })
  const toB = deliveries.filter((d) => d.to.includes('B'))
  const types = toB.map((d) => d.frame.type)
  const firstCaption = types.indexOf(FRAME_TYPES.PARTIAL_CAPTION)
  const firstAudio = types.indexOf(FRAME_TYPES.TRANSLATED_AUDIO_OUT)
  for (const d of toB) assertFrame(d.frame)
  return r.mode === 'voice' && r.legs[0].completed === true &&
    firstCaption >= 0 && firstAudio > firstCaption && // captions LEAD audio
    toB.every((d) => !d.to.includes('A')) &&
    r.legs[0].voice === 'clone'
})
await checkAsync('audio schedules only to the listener, in the clone voice id', async () => {
  const { session, scheduled, deliveries } = build()
  await session.speech('A', { script: 'hi', sourceLang: 'en' })
  const audioFrames = deliveries.filter((d) => d.frame.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT)
  return (scheduled.get('B') || []).length === 3 && !scheduled.has('A') &&
    audioFrames.every((d) => d.frame.voiceId === A.voiceId)
})
await checkAsync('both directions run independently (B replies in ta → A hears en)', async () => {
  const { session, deliveries } = build()
  await session.speech('A', { script: 'good morning', sourceLang: 'en' })
  await session.speech('B', { script: 'vanakkam nanba', sourceLang: 'ta' })
  const toA = deliveries.filter((d) => d.to.includes('A') && d.frame.type === FRAME_TYPES.PARTIAL_CAPTION)
  const last = toA[toA.length - 1]
  return last && last.frame.targetLang === 'en' && last.frame.translatedText === '⟨en⟩ vanakkam nanba' &&
    session.cursor().A === 1 && session.cursor().B === 1
})

/* -------- voice-clone flag OFF → neutral labelled voice -------- */
await checkAsync('VOICE_CLONE off → neutral voice id, labelled generic', async () => {
  const { session, deliveries } = build({ flags: { liveTranslation: true, voiceClone: false, liveCaptions: true } })
  const r = await session.speech('A', { script: 'hello', sourceLang: 'en' })
  const audio = deliveries.find((d) => d.frame.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT)
  return r.legs[0].voice === 'generic' && audio.frame.voiceId === NEUTRAL_VOICE_ID && audio.voice === 'generic'
})
await checkAsync('unenrolled speaker (no clone) → neutral voice even with the flag on', async () => {
  const { session } = build({ participants: [{ ...A, voiceId: null }, B] })
  const r = await session.speech('A', { script: 'hello', sourceLang: 'en' })
  return r.legs[0].voice === 'generic'
})

/* -------- barge-in -------- */
await checkAsync('new speech from the same speaker cancels the in-flight utterance', async () => {
  const { session } = build()
  const p1 = session.speech('A', { script: 'this one will be superseded by the next', sourceLang: 'en' })
  const p2 = session.speech('A', { script: 'short', sourceLang: 'en' })
  const [r1, r2] = await Promise.all([p1, p2])
  return r1.legs[0].interrupted === true && r2.legs[0].completed === true
})
await checkAsync('explicit bargeIn cancels and reports; false when idle', async () => {
  const { session } = build()
  const p = session.speech('A', { script: 'to be cut', sourceLang: 'en' })
  const did = session.bargeIn('A', 'listener-spoke')
  const r = await p
  return did === true && r.legs[0].interrupted === true && session.bargeIn('A') === false
})

/* -------- reconnect (§8.5) -------- */
await checkAsync('suspend cancels in-flight, DEGRADED; resume re-activates with cursors', async () => {
  const { session } = build()
  await session.speech('A', { script: 'first utterance done', sourceLang: 'en' })
  const p = session.speech('A', { script: 'dropped mid-flight', sourceLang: 'en' })
  const st = session.suspend('network-drop')
  const r = await p
  const blocked = await session.speech('A', { script: 'x', sourceLang: 'en' }).then(() => false, (e) => /not active/.test(e.message))
  const resumed = session.resume()
  const after = await session.speech('A', { script: 'back online', sourceLang: 'en' })
  return st === SESSION_STATES.DEGRADED && r.legs[0].interrupted === true &&
    blocked === true && resumed.state === SESSION_STATES.ACTIVE &&
    resumed.cursors.A === 1 && after.legs[0].completed === true && session.cursor().A === 2
})

/* -------- latency accounting -------- */
await checkAsync('per-utterance budgets aggregate into p50/p95 metrics', async () => {
  const { session } = build()
  for (let i = 0; i < 5; i++) await session.speech('A', { script: `utterance number ${i}`, sourceLang: 'en' })
  const m = session.metrics()
  return m.utterances === 5 && m.stages.total.count === 5 &&
    typeof m.stages.total.p50 === 'number' && typeof m.stages.stt_final.p95 === 'number' &&
    m.overBudget === 0
})

/* -------- ladder wiring -------- */
await checkAsync('over-budget utterances breach the ladder → captions-only mode next', async () => {
  const clock = makeManualClock(0)
  const ladder = createDegradationLadder({ clock: { now: clock.now }, demoteAfter: 2, windowMs: 100000, promoteAfterMs: 100000 })
  const deliveries = []
  const session = createLiveVoiceSession({
    sessionId: 's', participants: [A, B],
    adapters: {
      stt: createStubStreamingStt({ clock, finalMs: 3000 }), // blows the 2.5s budget
      mt: createStubStreamingMt({ clock }),
      tts: createStubStreamingTts({ clock })
    },
    flags: { liveTranslation: true, voiceClone: true },
    clock: clock.now, ladder, deliver: (d) => deliveries.push(d)
  })
  await session.speech('A', { script: 'slow one', sourceLang: 'en' })
  await session.speech('A', { script: 'slow two', sourceLang: 'en' })
  const tierAfter = session.ladder().tier
  const r3 = await session.speech('A', { script: 'now degraded', sourceLang: 'en' })
  return tierAfter === 'captions-only' && r3.mode === 'captions' &&
    r3.legs[0].fallback === true && // orchestrator refused audio (no voiceId passed)
    session.metrics().overBudget >= 2
})

/* -------- group (real session logic; media documented as P5-blocked) -------- */
await checkAsync('>2 participants without the group flag refuses', async () => {
  try { build({ participants: [A, B, C] }); return false } catch (e) { return /GROUP_TRANSLATION_ENABLED/.test(e.message) }
})
await checkAsync('3-party: one utterance fans to ta + hi with shared STT, per-listener delivery', async () => {
  const { session, deliveries } = build({ participants: [A, B, C], group: true })
  const r = await session.speech('A', { script: 'hello everyone', sourceLang: 'en' })
  const toB = deliveries.filter((d) => d.to.includes('B') && d.frame.type === FRAME_TYPES.PARTIAL_CAPTION && d.frame.translatedText)
  const toC = deliveries.filter((d) => d.to.includes('C') && d.frame.type === FRAME_TYPES.PARTIAL_CAPTION && d.frame.translatedText)
  return r.legs.length === 2 &&
    toB.some((d) => d.frame.targetLang === 'ta') && toC.some((d) => d.frame.targetLang === 'hi') &&
    toB.every((d) => !d.to.includes('C')) && // lanes don't leak across listeners
    r.legs.every((l) => l.completed === true)
})
await checkAsync('3-party same-language listener gets caption-only lane from shared STT', async () => {
  const { session, deliveries } = build({ participants: [A, B, { id: 'E', listenLang: 'en' }], group: true })
  const r = await session.speech('A', { script: 'shared transcript', sourceLang: 'en' })
  const toE = deliveries.filter((d) => d.to.includes('E'))
  const capLeg = r.legs.find((l) => l.captionsOnly)
  return capLeg && capLeg.transcript === 'shared transcript' &&
    toE.length > 0 && toE.every((d) => d.frame.type === FRAME_TYPES.PARTIAL_CAPTION && d.frame.translatedText == null)
})

/* -------- live language switch -------- */
await checkAsync('setListenLang applies to the NEXT utterance (no restart)', async () => {
  const { session, deliveries } = build()
  await session.speech('A', { script: 'before switch', sourceLang: 'en' })
  session.setListenLang('B', 'ml')
  await session.speech('A', { script: 'after switch', sourceLang: 'en' })
  const captions = deliveries.filter((d) => d.to.includes('B') && d.frame.translatedText)
  const last = captions[captions.length - 1]
  return last.frame.targetLang === 'ml' && last.frame.translatedText === '⟨ml⟩ after switch'
})

/* -------- replay buffer: bounded, last utterance only -------- */
await checkAsync('replay holds ONLY the last utterance per listener', async () => {
  const { session } = build()
  await session.speech('A', { script: 'first', sourceLang: 'en' })
  await session.speech('A', { script: 'second and last', sourceLang: 'en' })
  const r = session.replayFor('B')
  return r && r.utteranceId.endsWith(':u2') && r.audio.length === 3 &&
    r.captions.every((f) => f.text.includes('second') || f.translatedText?.includes('second'))
})

/* -------- end -------- */
await checkAsync('end() cancels, closes adapters, ENDED; replay cleared', async () => {
  const { session } = build()
  await session.speech('A', { script: 'bye', sourceLang: 'en' })
  await session.end('done')
  return session.state === SESSION_STATES.ENDED && session.replayFor('B') === null
})

/* -------- flags-off construction refuses -------- */
await checkAsync('no capability flags → the session refuses to exist', async () => {
  try { build({ flags: {} }); return false } catch (e) { return /nothing enabled/.test(e.message) }
})

/* -------- strict privacy refuses the WHOLE pipeline (no cloud STT either) -------- */
await checkAsync('strict privacy: speech() is refused entirely — no STT, no MT, no frames', async () => {
  const clock = makeManualClock(0)
  const { createTranslationPlatformMt, STRICT_PRIVACY_REFUSAL } = await import('../src/lib/live-voice/mt-stage.js')
  const { fakeTranslationPlatform } = await import('./helpers/fake-translation-provider.js')
  let sttCalls = 0
  const stt = createStubStreamingStt({ clock })
  const realTranscribe = stt.transcribe.bind(stt)
  stt.transcribe = (i, h) => { sttCalls += 1; return realTranscribe(i, h) }
  const deliveries = []
  const session = createLiveVoiceSession({
    sessionId: 's', participants: [A, B],
    adapters: { stt, mt: createTranslationPlatformMt({ platform: fakeTranslationPlatform().platform, privacyMode: 'strict' }), tts: createStubStreamingTts({ clock }) },
    flags: { liveTranslation: true, voiceClone: true, liveCaptions: true },
    clock: clock.now, deliver: (d) => deliveries.push(d)
  })
  const r = await session.speech('A', { script: 'this must never leave', sourceLang: 'en' })
  const captionFrames = deliveries.filter((d) => d.frame.type === FRAME_TYPES.PARTIAL_CAPTION)
  return r.mode === 'refused' && r.reason === STRICT_PRIVACY_REFUSAL &&
    r.legs.length === 0 && sttCalls === 0 && captionFrames.length === 0 &&
    session.strictRefused === true
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live session — directions, barge-in, reconnect, group fan-out')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
