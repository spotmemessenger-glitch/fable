/**
 * Live-voice latency budget accounting — the <2.5 s promise, made checkable
 * (ADR-011, §6.5).
 *
 * A latency type is untestable against a wall clock, so the whole point of the
 * injectable clock is here: a fake clock advanced by fixed amounts makes the
 * arithmetic exactly reproducible. This pins that the default allocation sums to
 * the total, that per-stage and total breaches are detected, and that the report
 * is the typed shape the orchestrator and a benchmark harness consume.
 */
import {
  TOTAL_BUDGET_MS, STAGE_BUDGETS_MS, STAGE_ORDER, createLatencyBudget
} from '../src/lib/live-voice/latency-budget.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

const fakeClock = (start = 0) => {
  let t = start
  const c = () => t
  c.advance = (ms) => { t += ms }
  return c
}

/* -------- allocation -------- */
check('the default per-stage allocation sums to the total budget', () => {
  const sum = STAGE_ORDER.reduce((a, s) => a + STAGE_BUDGETS_MS[s], 0)
  return sum === TOTAL_BUDGET_MS && TOTAL_BUDGET_MS === 2500
})
check('stage order is the pipeline order (stt before mt before tts)', () => {
  const i = (s) => STAGE_ORDER.indexOf(s)
  return i('stt_partial') < i('mt') && i('mt') < i('tts_first_audio') && i('tts_first_audio') < i('playback_schedule')
})

/* -------- measurement -------- */
check('marks measure back-to-back deltas from the injected clock', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock })
  b.begin()
  clock.advance(400); const d1 = b.mark('stt_partial')
  clock.advance(300); const d2 = b.mark('stt_final')
  return d1 === 400 && d2 === 300 && b.elapsed() === 700
})
check('a within-budget run reports withinBudget=true and overBy=0', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock })
  b.begin()
  for (const [s, ms] of [['capture', 100], ['stt_partial', 400], ['stt_final', 300], ['mt', 250], ['tts_first_audio', 350], ['playback_schedule', 80]]) {
    clock.advance(ms); b.mark(s)
  }
  const r = b.report()
  return r.withinBudget === true && r.overBy === 0 && r.measuredMs === 1480
})

/* -------- breaches -------- */
check('a stage that blows its slice is flagged, total may still be OK', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock })
  b.begin()
  clock.advance(700); b.mark('stt_partial')   // slice is 600 → over
  return b.stageOver('stt_partial') === true && b.breachedStages().includes('stt_partial')
})
check('total over budget is detected and reported with overBy', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock })
  b.begin()
  clock.advance(3000); b.mark('stt_final')
  const r = b.report()
  return b.overBudget() === true && r.withinBudget === false && r.overBy === 500
})
check('remaining() counts down and goes negative once over', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock })
  b.begin()
  clock.advance(2000); b.mark('mt')
  const beforeOver = b.remaining() === 500
  clock.advance(1000); b.mark('tts_first_audio')
  return beforeOver && b.remaining() === -500
})

/* -------- report shape + guards -------- */
check('report() is the typed shape the orchestrator attaches to a result', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock })
  b.begin(); clock.advance(400); b.mark('stt_partial')
  const r = b.report()
  const entry = r.perStage[0]
  return typeof r.totalMs === 'number' && typeof r.measuredMs === 'number' &&
    Array.isArray(r.perStage) && Array.isArray(r.breached) &&
    entry.stage === 'stt_partial' && entry.ms === 400 && entry.budgetMs === 600 && entry.over === false
})
check('mark() before begin() throws rather than recording nonsense', () => {
  const b = createLatencyBudget({ clock: fakeClock(0) })
  return throws(() => b.mark('mt'))
})
check('an unknown stage name is rejected', () => {
  const b = createLatencyBudget({ clock: fakeClock(0) })
  b.begin()
  return throws(() => b.mark('teleport'))
})
check('a custom total/allocation is honoured (targets will move — §6.5)', () => {
  const clock = fakeClock(0)
  const b = createLatencyBudget({ clock, totalMs: 1500, stageBudgets: { mt: 1500 } })
  b.begin(); clock.advance(1600); b.mark('mt')
  return b.overBudget() === true && b.report().totalMs === 1500
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice latency budget — <2.5s')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
