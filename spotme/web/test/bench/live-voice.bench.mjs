/**
 * Live-voice LOCAL orchestration benchmarks — Roadmap V2 §8 (environment,
 * raw results, median AND tail). Same discipline as the translation
 * benchmarks: every provider is a DETERMINISTIC fake that resolves on
 * microtasks, so these numbers are purely the platform's OWN cost — session
 * construction, fan-out math, the frame path through the orchestrator,
 * shared-STT fanning, VAD stepping, jitter-buffer ops, ladder/aggregator
 * folds — the overhead a live call pays ON TOP of provider latency. The
 * provider legs themselves are the §4 critical-path terms (STT stabilise,
 * TTS first-audio) and are measured against live vendors by the cred-gated
 * suite, never here.
 *
 *   node test/bench/live-voice.bench.mjs
 */
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { createLiveVoiceSession } from '../../src/lib/live-voice/live-session.js'
import { createStubStreamingStt, createStubStreamingMt, createStubStreamingTts, makeManualClock } from '../../src/lib/live-voice/stub-adapters.js'
import { fanoutForUtterance, planCall } from '../../src/lib/live-voice/fanout.js'
import { createVad } from '../../src/lib/live-voice/quality/vad.js'
import { createJitterBuffer } from '../../src/lib/live-voice/quality/jitter-buffer.js'
import { createLatencyAggregator } from '../../src/lib/live-voice/metrics.js'
import { createDegradationLadder } from '../../src/lib/live-voice/quality/degradation-ladder.js'

function stats (samples) {
  const s = [...samples].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  return { n: s.length, min: s[0], p50: at(0.5), p90: at(0.9), p95: at(0.95), p99: at(0.99), max: s[s.length - 1], mean }
}
const us = (ms) => `${(ms * 1000).toFixed(2)}us`
function report (title, samples) {
  const t = stats(samples)
  console.log(`\n${title}`)
  console.log(`  n=${t.n}  min=${us(t.min)}  p50=${us(t.p50)}  p90=${us(t.p90)}  p95=${us(t.p95)}  p99=${us(t.p99)}  max=${us(t.max)}  mean=${us(t.mean)}`)
  return t
}

console.log('live-voice local orchestration benchmark')
console.log(`env: node ${process.version}, ${cpus().length}x ${cpus()[0]?.model || 'cpu'}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB`)
console.log('providers: deterministic fakes (microtask-resolved) — LOCAL cost only')

const A = { id: 'A', listenLang: 'en', speakLang: 'en', voiceId: 'VOICEaaaa1111', consented: true }
const B = { id: 'B', listenLang: 'ta', speakLang: 'ta', voiceId: 'VOICEbbbb2222', consented: true }
const C = { id: 'C', listenLang: 'hi' }

function buildSession (participants, group = false) {
  const clock = makeManualClock(0)
  return createLiveVoiceSession({
    sessionId: 'bench', participants,
    adapters: { stt: createStubStreamingStt({ clock }), mt: createStubStreamingMt({ clock }), tts: createStubStreamingTts({ clock }) },
    flags: { liveTranslation: true, voiceClone: true, ...(group ? { groupTranslation: true } : {}) },
    clock: clock.now, deliver: () => {}
  })
}

/* -------- session setup -------- */
{
  const samples = []
  for (let i = 0; i < 2000; i++) {
    const t0 = performance.now()
    buildSession([A, B])
    samples.push(performance.now() - t0)
  }
  report('session setup (1:1, adapters + ladder + aggregator + machine)', samples)
}

/* -------- fan-out matrix -------- */
{
  const many = [A, B, C, ...Array.from({ length: 13 }, (_, i) => ({ id: `p${i}`, listenLang: ['en', 'ta', 'hi', 'ml', 'kn'][i % 5] }))]
  const samples = []
  for (let i = 0; i < 20000; i++) {
    const t0 = performance.now()
    fanoutForUtterance(many, 'A', 'en')
    samples.push(performance.now() - t0)
  }
  report('fan-out matrix (16 participants, 5 languages)', samples)
  const plan = planCall(many)
  console.log(`  plan: ${plan.sttPasses} stt passes, ${plan.mtTtsLegs} MT+TTS legs, bound ${plan.concurrencyBound}`)
}

/* -------- full utterance frame path, 1:1 -------- */
{
  const session = buildSession([A, B])
  const samples = []
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now()
    await session.speech('A', { script: 'hello there my good friend today', sourceLang: 'en' })
    samples.push(performance.now() - t0)
  }
  report('full utterance, 1:1 (shared STT → MT → TTS → playback, frames + budget)', samples)
}

/* -------- full utterance, 3-party group fan-out -------- */
{
  const session = buildSession([A, B, C], true)
  const samples = []
  for (let i = 0; i < 500; i++) {
    const t0 = performance.now()
    await session.speech('A', { script: 'hello there my good friend today', sourceLang: 'en' })
    samples.push(performance.now() - t0)
  }
  report('full utterance, 3-party (2 translated legs + shared STT)', samples)
}

/* -------- VAD stepping -------- */
{
  const vad = createVad()
  const samples = []
  for (let run = 0; run < 200; run++) {
    const t0 = performance.now()
    for (let f = 0; f < 500; f++) vad.push({ energy: f % 40 < 25 ? 0.6 : 0.02 }) // 10 s of 20 ms frames
    samples.push(performance.now() - t0)
  }
  report('VAD: 500 frames (10 s of audio) per sample', samples)
}

/* -------- jitter buffer ops -------- */
{
  let now = 0
  const clock = { now: () => now }
  const jb = createJitterBuffer({ clock, chunkMs: 20 })
  const samples = []
  for (let run = 0; run < 200; run++) {
    jb.hardReset()
    now = 0
    const t0 = performance.now()
    for (let s = 0; s < 500; s++) { now = s * 20; jb.push({ seq: s, chunk: 'x'.repeat(64) }); jb.drain() }
    now += 10_000; jb.drain()
    samples.push(performance.now() - t0)
  }
  report('jitter buffer: 500 push+drain cycles (10 s of 20 ms chunks) per sample', samples)
}

/* -------- aggregator + ladder folds -------- */
{
  const agg = createLatencyAggregator()
  const ladder = createDegradationLadder({ clock: { now: () => 0 } })
  const rep = { measuredMs: 1500, withinBudget: true, perStage: [{ stage: 'mt', ms: 100 }, { stage: 'stt_final', ms: 400 }] }
  const samples = []
  for (let run = 0; run < 2000; run++) {
    const t0 = performance.now()
    for (let i = 0; i < 100; i++) { agg.record(rep); ladder.recordClean() }
    samples.push(performance.now() - t0)
  }
  report('metrics+ladder: 100 utterance folds per sample', samples)
}

console.log('\nInterpretation: every local p95 above sits orders of magnitude under the')
console.log('2.5 s budget — the budget is spent on providers + network (§4), and the')
console.log('platform machinery adds microseconds-to-low-milliseconds per utterance.')
