/**
 * Latency accounting — per-stage marks through the budget into p50/p95/p99
 * aggregation, and the over-budget → ladder wiring (ADR-011b; mission
 * item 7). Deterministic (manual clock; synthetic reports for percentiles).
 *
 *   node test/live-voice-latency.test.js
 */
import { createLatencyAggregator, percentile, DEFAULT_RING_CAPACITY } from '../src/lib/live-voice/metrics.js'
import { createLiveVoiceOrchestrator } from '../src/lib/live-voice/orchestrator.js'
import { createStubStreamingStt, createStubStreamingMt, createStubStreamingTts, createStubCorrector, createStubPlayback, makeManualClock } from '../src/lib/live-voice/stub-adapters.js'
import { STAGE_ORDER, TOTAL_BUDGET_MS } from '../src/lib/live-voice/latency-budget.js'

const results = {}
const check = (name, pass) => { results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* -------- percentile math -------- */
check('percentile: nearest-rank on small samples', percentile([10, 20, 30, 40], 50) === 20 && percentile([10, 20, 30, 40], 95) === 40)
check('percentile: single sample is every percentile', percentile([7], 50) === 7 && percentile([7], 99) === 7)
check('percentile: empty is null', percentile([], 50) === null)
check('percentile is order-independent', percentile([30, 10, 20], 50) === 20)

/* -------- aggregation over real orchestrator budgets -------- */
await checkAsync('per-stage marks flow from the pipeline into stage percentiles', async () => {
  const agg = createLatencyAggregator()
  for (let i = 0; i < 20; i++) {
    const clock = makeManualClock(0)
    const orch = createLiveVoiceOrchestrator({
      stt: createStubStreamingStt({ clock, firstTokenMs: 300 + i * 10, finalMs: 200 }),
      mt: createStubStreamingMt({ clock, mtMs: 150 }),
      tts: createStubStreamingTts({ clock, firstAudioMs: 250 }),
      corrector: createStubCorrector({ clock, correctMs: 100 }),
      playback: createStubPlayback({ clock, scheduleMs: 10 }),
      clock: clock.now
    })
    const r = await orch.processUtterance({ sessionId: 's', script: 'a b c', sourceLang: 'en', targetLang: 'ta', voiceProfileId: 'VOICEaaaa1111' })
    agg.record(r.budget)
  }
  const s = agg.snapshot()
  const stagesSeen = Object.keys(s.stages)
  return s.utterances === 20 && s.overBudget === 0 &&
    STAGE_ORDER.every((st) => stagesSeen.includes(st)) &&
    s.stages.stt_partial.p50 === 390 && // nearest-rank: sorted[ceil(.5*20)-1] = 300+9*10
    s.stages.stt_partial.min === 300 && s.stages.stt_partial.max === 490 &&
    s.stages.mt.p50 === 150 && s.stages.total.p95 >= s.stages.total.p50
})
await checkAsync('p50/p95/p99 are exact on a known distribution', async () => {
  const agg = createLatencyAggregator()
  for (let v = 1; v <= 100; v++) agg.record({ measuredMs: v, withinBudget: true, perStage: [{ stage: 'mt', ms: v }] })
  const s = agg.snapshot()
  return s.stages.total.p50 === 50 && s.stages.total.p95 === 95 && s.stages.total.p99 === 99 &&
    s.stages.mt.p50 === 50 && s.stages.mt.mean === 50.5
})
await checkAsync('overBudget counts + rate reflect the budget verdicts', async () => {
  const agg = createLatencyAggregator()
  agg.record({ measuredMs: 1000, withinBudget: true, perStage: [] })
  agg.record({ measuredMs: 3000, withinBudget: false, perStage: [] })
  agg.record({ measuredMs: 2600, withinBudget: false, perStage: [] })
  const s = agg.snapshot()
  return s.overBudget === 2 && Math.abs(s.overBudgetRate - 2 / 3) < 1e-9
})
await checkAsync('named durations (session setup, fan-out) aggregate alongside stages', async () => {
  const agg = createLatencyAggregator()
  agg.recordDuration('session_setup', 5)
  agg.recordDuration('session_setup', 15)
  agg.recordDuration('fanout_compute', 1)
  const s = agg.snapshot()
  return s.stages.session_setup.count === 2 && s.stages.session_setup.max === 15 && s.stages.fanout_compute.count === 1
})
await checkAsync('rings are FIXED-SIZE: retained samples never exceed capacity per series', async () => {
  const agg = createLatencyAggregator({ capacity: 16 })
  for (let i = 0; i < 10_000; i++) agg.record({ measuredMs: i, withinBudget: true, perStage: [{ stage: 'mt', ms: i }] })
  return agg.retainedSamples() === 32 && agg.snapshot().stages.total.count === 16
})
check('default ring capacity is documented and bounded', DEFAULT_RING_CAPACITY === 256)

/* -------- the budget ceiling is the owner's 2.5 s -------- */
check('TOTAL_BUDGET_MS stays the owner amendment 2500', TOTAL_BUDGET_MS === 2500)

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  latency accounting — marks → budgets → percentiles')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
