/**
 * Degradation + failover + long-session boundedness (ADR-011b; mission
 * item 9). Network loss/delay over fake transports, provider failover
 * MID-UTTERANCE through the chain, translation-platform failover mid-call,
 * and the long-session memory proof: hundreds of utterances, bounded
 * buffers everywhere.
 *
 *   node test/live-voice-degradation.test.js
 */
import { createFailoverChain } from '../src/lib/live-voice/providers/failover.js'
import { createElevenLabsStreamingStt } from '../src/lib/live-voice/providers/elevenlabs-stt.js'
import { createElevenLabsStreamingTts } from '../src/lib/live-voice/providers/elevenlabs-tts.js'
import { createStubStreamingStt, createStubStreamingMt, createStubStreamingTts, makeManualClock } from '../src/lib/live-voice/stub-adapters.js'
import { createLiveVoiceSession } from '../src/lib/live-voice/live-session.js'
import { createTranslationPlatformMt } from '../src/lib/live-voice/mt-stage.js'
import { createJitterBuffer } from '../src/lib/live-voice/quality/jitter-buffer.js'
import { createLatencyAggregator } from '../src/lib/live-voice/metrics.js'
import { fakeProvider, fakeTranslationPlatform } from './helpers/fake-translation-provider.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const seg = (s) => `data:audio/webm;base64,${Buffer.from(s).toString('base64')}`
const A = { id: 'A', listenLang: 'en', speakLang: 'en', voiceId: 'VOICEaaaa1111', consented: true }
const B = { id: 'B', listenLang: 'ta', speakLang: 'ta', voiceId: 'VOICEbbbb2222', consented: true }

/* ============== provider failover MID-UTTERANCE (chain level) ============== */
await checkAsync('STT chain: primary dies on segment 2 → fallback resumes REMAINING segments', async () => {
  let calls = 0
  const dyingFetch = () => {
    calls += 1
    if (calls === 2) return Promise.resolve({ ok: false, status: 500, text: async () => 'mid-utterance death', json: async () => ({}) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ text: `p${calls}`, language_code: 'en' }) })
  }
  let fallbackCalls = 0
  const fallbackFetch = () => { fallbackCalls += 1; return Promise.resolve({ ok: true, status: 200, json: async () => ({ text: `f${fallbackCalls}`, language_code: 'en' }) }) }
  const chain = createFailoverChain('stt', [
    createElevenLabsStreamingStt({ fetchFn: dyingFetch, keyProvider: () => 'k' }),
    createElevenLabsStreamingStt({ fetchFn: fallbackFetch, keyProvider: () => 'k' })
  ])
  await chain.open()
  const partials = []
  const r = await chain.transcribe({ audio: [seg('a'), seg('b'), seg('c')] }, { onPartial: (p) => partials.push(p.text) }).done
  // Segment 1 committed by the primary; segments 2..3 re-issued to fallback.
  return r.text === 'p1 f1 f2' && fallbackCalls === 2 &&
    r.failovers.length === 1 && /mid-utterance death/.test(r.failovers[0].reason) &&
    partials[partials.length - 1] === 'p1 f1 f2'
})
await checkAsync('TTS chain: dead primary → fallback synthesizes only the REMAINDER (no repeat)', async () => {
  const dyingWs = (url) => {
    const ws = { readyState: 1, send () {}, close () { ws.readyState = 3 }, onopen: null, onmessage: null, onerror: null, onclose: null }
    queueMicrotask(() => {
      ws.onopen && ws.onopen()
      queueMicrotask(() => {
        ws.onmessage && ws.onmessage({ data: JSON.stringify({ audio: 'CHUNK1', isFinal: null }) })
        ws.onerror && ws.onerror(new Error('tts died mid-stream'))
      })
    })
    return ws
  }
  const fallbackInputs = []
  const fallbackTts = {
    open: () => Promise.resolve(), close: () => Promise.resolve(), status: () => 'open',
    capabilities: () => ({ partial: true, firstToken: true, cancel: true, provider: 'fallback-tts' }),
    synthesize (input, handlers) {
      fallbackInputs.push(input)
      const chunks = ['REST1', 'REST2']
      const done = (async () => {
        for (let i = 0; i < chunks.length; i++) {
          handlers.onFirstToken && i === 0 && handlers.onFirstToken({ kind: 'audio', chunk: chunks[i] })
          handlers.onPartial({ chunk: chunks[i], index: i, firstAudio: i === 0, final: i === chunks.length - 1 })
        }
        const r = { chunks, voiceId: input.voiceId, final: true }
        handlers.onFinal(r)
        return r
      })()
      return { cancel () {}, done }
    }
  }
  const chain = createFailoverChain('tts', [
    createElevenLabsStreamingTts({ wsFactory: dyingWs, keyProvider: () => 'k' }),
    fallbackTts
  ])
  const partials = []
  const text = 'a long sentence that will be cut over to the fallback voice'
  const r = await chain.synthesize({ text, voiceId: 'VOICEaaaa1111', targetLang: 'ta' }, { onPartial: (p) => partials.push(p) }).done
  const indices = partials.map((p) => p.index)
  return r.provider === 'fallback-tts' && r.resumed === true &&
    fallbackInputs[0].text.length < text.length && fallbackInputs[0].resumedAtChunk === 1 &&
    JSON.stringify(indices) === JSON.stringify([0, 1, 2]) && // continuous indexing across the hop
    partials.filter((p) => p.firstAudio).length === 1
})
await checkAsync('every candidate dead → the chain rejects with the full failover history', async () => {
  const dead = () => createStubStreamingMt({ clock: makeManualClock(0) })
  const d1 = dead(); const d2 = dead()
  d1.translate = () => ({ cancel () {}, done: Promise.reject(new Error('mt1 down')) })
  d2.translate = () => ({ cancel () {}, done: Promise.reject(new Error('mt2 down')) })
  const chain = createFailoverChain('mt', [d1, d2])
  try { await chain.translate({ text: 'x', targetLang: 'ta' }, {}).done; return false } catch (e) {
    return /all 2 candidates failed/.test(e.message) && e.failovers.length === 2
  }
})

/* ============== translation-platform failover mid-call ============== */
await checkAsync('MT provider dies MID-CALL → #51 router fails the session over; captions continue', async () => {
  const clock = makeManualClock(0)
  let googleAlive = true
  const google = fakeProvider('google', { translate: async ({ text, targetLang }) => { if (!googleAlive) throw new Error('google down'); return { text: `⟨${targetLang}⟩ ${text}`, engine: 'google' } } })
  const azure = fakeProvider('azure', { qualityTier: 'general', translate: async ({ text, targetLang }) => ({ text: `⟨${targetLang}|az⟩ ${text}`, engine: 'azure' }) })
  const { platform } = fakeTranslationPlatform([google, azure])
  const deliveries = []
  const session = createLiveVoiceSession({
    sessionId: 's', participants: [A, B],
    adapters: { stt: createStubStreamingStt({ clock }), mt: createTranslationPlatformMt({ platform }), tts: createStubStreamingTts({ clock }) },
    flags: { liveTranslation: true, voiceClone: true },
    clock: clock.now, deliver: (d) => deliveries.push(d)
  })
  const r1 = await session.speech('A', { script: 'before the outage', sourceLang: 'en' })
  googleAlive = false
  const r2 = await session.speech('A', { script: 'during the outage', sourceLang: 'en' })
  return r1.legs[0].translation === '⟨ta⟩ before the outage' &&
    r2.legs[0].completed === true &&
    r2.legs[0].translation === '⟨ta|az⟩ during the outage' &&
    String(r2.legs[0].mtProvider).includes('azure')
})

/* ============== network degradation over a lossy/delayed fake wire ============== */
await checkAsync('lossy translated-audio wire: jitter buffer conceals, playout stays ordered', async () => {
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, targetMs: 100, chunkMs: 20, plc: 'skip' })
  // 50 chunks, ~14% loss, jittered arrival (deterministic pattern).
  const sent = []
  for (let s = 0; s < 50; s++) {
    if (s % 7 === 3) continue // lost on the wire
    sent.push({ seq: s, delay: (s % 5) * 7 })
  }
  for (const p of sent) { now = p.delay; jb.push({ seq: p.seq, chunk: `c${p.seq}` }) }
  const played = []
  const concealed = []
  for (now = 100; now <= 1400; now += 10) {
    for (const out of jb.drain()) {
      if (out.concealment) concealed.push(out.concealment.seq)
      else played.push(out.seq)
    }
  }
  const ordered = played.every((s, i) => i === 0 || s > played[i - 1])
  return played.length === sent.length && ordered &&
    concealed.length === 50 - sent.length && jb.depthMs > 100
})
await checkAsync('sustained loss breaches the ladder through the session (auto reduction), recovery promotes', async () => {
  const clock = makeManualClock(0)
  // STT whose finalMs breaches only while "network degraded".
  let degraded = false
  const stt = createStubStreamingStt({ clock })
  const realTranscribe = stt.transcribe.bind(stt)
  stt.transcribe = (input, handlers) => { if (degraded) clock.advance(3000); return realTranscribe(input, handlers) }
  const session = createLiveVoiceSession({
    sessionId: 's', participants: [A, B],
    adapters: { stt, mt: createStubStreamingMt({ clock }), tts: createStubStreamingTts({ clock }) },
    flags: { liveTranslation: true, voiceClone: true },
    clock: clock.now, deliver: () => {}
  })
  degraded = true
  await session.speech('A', { script: 'slow', sourceLang: 'en' })
  await session.speech('A', { script: 'slow', sourceLang: 'en' })
  const duringOutage = session.ladder().tier
  degraded = false
  // recovery: default promoteAfterMs is 15s of clean running
  for (let i = 0; i < 10; i++) { clock.advance(2000); await session.speech('A', { script: 'fast again', sourceLang: 'en' }) }
  const recovered = session.ladder().tier
  return duringOutage === 'captions-only' && recovered === 'full'
})

/* ============== long-session boundedness ============== */
await checkAsync('400 utterances: replay ring, cursors, metrics rings and MT log all stay BOUNDED', async () => {
  const clock = makeManualClock(0)
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform })
  const aggregator = createLatencyAggregator()
  let deliveries = 0
  const session = createLiveVoiceSession({
    sessionId: 's', participants: [A, B],
    adapters: { stt: createStubStreamingStt({ clock }), mt, tts: createStubStreamingTts({ clock }) },
    flags: { liveTranslation: true, voiceClone: true },
    clock: clock.now, aggregator, deliver: () => { deliveries += 1 }
  })
  for (let i = 0; i < 400; i++) {
    clock.advance(5000)
    await session.speech(i % 2 === 0 ? 'A' : 'B', { script: `utterance number ${i} with some words`, sourceLang: i % 2 === 0 ? 'en' : 'ta' })
  }
  const replayA = session.replayFor('A')
  const replayB = session.replayFor('B')
  const m = session.metrics()
  return m.utterances === 400 &&
    aggregator.retainedSamples() <= 8 * 256 && // ring caps: stages x capacity
    replayA.captions.length <= 64 && replayA.audio.length <= 64 &&
    replayB.utteranceId.endsWith(':u399') && // only the LAST utterance kept
    mt.decisionLog().length <= 32 &&
    Object.keys(session.cursor()).length === 2 &&
    deliveries > 0
})
await checkAsync('metrics percentiles stay windowed (latest ring), not lifetime', async () => {
  const agg = createLatencyAggregator({ capacity: 8 })
  for (let i = 0; i < 100; i++) agg.record({ measuredMs: 10_000, withinBudget: false, perStage: [] })
  for (let i = 0; i < 8; i++) agg.record({ measuredMs: 100, withinBudget: true, perStage: [] })
  const s = agg.snapshot()
  return s.stages.total.p95 === 100 && s.stages.total.count === 8 && s.utterances === 108
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  degradation + failover + long-session bounds')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
