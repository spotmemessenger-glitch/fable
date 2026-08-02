/**
 * Cost governance (design §9, §14): estimate before spending, count per account
 * per day/month, refuse over a hard ceiling, warn at a soft ratio, and never fan
 * out (cross-verify/adjudicate) without a recorded reason. Deterministic — `now`
 * is injected so day/month rollover is asserted without a clock.
 *
 *   node test/translation-cost.test.js
 */
import {
  estimateMicroUsd, estimateForProvider, createCostGovernor, COST_DEFAULTS
} from '../src/lib/translation/cost.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/** A provider stub exposing just priceSignal + capabilities.costModel. */
const provider = (unit, perUnit, units) => ({
  priceSignal: () => ({ unit, estimatedUnits: units }),
  capabilities: () => ({ costModel: { unit, microUsdPerUnit: perUnit } })
})

/* ----------------------------------------------------------- 1. estimate --- */

check('estimate multiplies units by the model rate; free is 0', () =>
  estimateMicroUsd({ estimatedUnits: 1000 }, { microUsdPerUnit: 0.02 }) === 20 &&
  estimateMicroUsd({ estimatedUnits: 500 }, { microUsdPerUnit: 3.0 }) === 1500 &&
  estimateMicroUsd({ estimatedUnits: 1000 }, { microUsdPerUnit: 0 }) === 0)

check('estimateForProvider reads the provider\'s own signal + model, never throws', () =>
  estimateForProvider(provider('char', 0.02, 1000)) === 20 &&
  estimateForProvider({}) === 0) // a provider with no signal estimates free

/* --------------------------------------------------------- 2. the ceiling -- */

check('a call within budget is allowed; one over the daily ceiling is refused', () => {
  const g = createCostGovernor({ limits: { dailyMicroUsd: 100, monthlyMicroUsd: 10000, softRatio: 0.8 } })
  const ok = g.check('acme', 50)
  const over = g.check('acme', 150)
  return ok.allowed === true && ok.hardBlocked === false &&
    over.allowed === false && over.hardBlocked === true && over.reason === 'daily ceiling'
})

check('recorded spend accumulates and then trips the ceiling', () => {
  const g = createCostGovernor({ limits: { dailyMicroUsd: 100, monthlyMicroUsd: 10000 } })
  g.record('acme', 80)
  const next = g.check('acme', 30) // 80 + 30 > 100
  return next.allowed === false && g.usage('acme').day === 80
})

check('a soft warning fires before the hard ceiling', () => {
  const g = createCostGovernor({ limits: { dailyMicroUsd: 100, monthlyMicroUsd: 10000, softRatio: 0.8 } })
  g.record('acme', 75)
  const warn = g.check('acme', 10) // 85 > 80% of 100, still < 100
  return warn.allowed === true && warn.softWarning === true
})

check('the monthly ceiling is enforced independently of the daily one', () => {
  const g = createCostGovernor({ limits: { dailyMicroUsd: 1e9, monthlyMicroUsd: 100 } })
  g.record('acme', 90)
  const over = g.check('acme', 20) // day is fine, month is not
  return over.allowed === false && over.reason === 'monthly ceiling'
})

/* --------------------------------------------------- 3. per-account + time - */

check('accounts have independent budgets', () => {
  const g = createCostGovernor({ limits: { dailyMicroUsd: 100, monthlyMicroUsd: 10000 } })
  g.record('acme', 100)
  return g.check('acme', 1).allowed === false && g.check('other', 1).allowed === true
})

check('a per-account override widens (or narrows) just that account', () => {
  const g = createCostGovernor({ limits: { dailyMicroUsd: 100 }, overrides: { vip: { dailyMicroUsd: 1000 } } })
  g.record('vip', 500)
  return g.check('vip', 100).allowed === true && g.check('acme', 200).allowed === false
})

check('spend resets when the day rolls over (injected clock)', () => {
  let t = Date.parse('2026-08-02T10:00:00Z')
  const g = createCostGovernor({ limits: { dailyMicroUsd: 100, monthlyMicroUsd: 1e9 }, now: () => t })
  g.record('acme', 100)
  const sameDay = g.check('acme', 1) // over
  t = Date.parse('2026-08-03T10:00:00Z') // next day
  const nextDay = g.check('acme', 50) // fresh daily budget
  return sameDay.allowed === false && nextDay.allowed === true
})

/* --------------------------------------------------- 4. the fan-out budget - */

check('a fan-out with no recorded reason is REFUSED', () => {
  const g = createCostGovernor()
  const bad = g.fanout('acme', '')
  const good = g.fanout('acme', 'adjudicate disagreement google vs sarvam for kn')
  return bad.allowed === false && /reason/.test(bad.reason) && good.allowed === true
})

check('the fan-out budget is bounded per window', () => {
  let t = 0
  const g = createCostGovernor({ limits: { maxFanoutPerMin: 2, fanoutWindowMs: 1000 }, now: () => t })
  const a = g.fanout('acme', 'reason 1')
  const b = g.fanout('acme', 'reason 2')
  const c = g.fanout('acme', 'reason 3') // over budget
  t = 1001 // window elapsed
  const d = g.fanout('acme', 'reason 4') // budget refreshed
  return a.allowed && b.allowed && c.allowed === false && d.allowed === true
})

/* ---------------------------------------------------------- 5. cache-first - */

check('the governor advises cache-first and counts the saving', () => {
  const g = createCostGovernor()
  g.recordCacheSaving(20)
  return g.shouldCheckCacheFirst() === true && g.snapshot().cacheSavings === 20
})

check('the snapshot is amounts and counts only — never content', () => {
  const g = createCostGovernor()
  g.record('acme', 50, { estimate: 48 })
  const s = g.snapshot()
  return s.recorded === 50 && s.accounts === 1 && !('text' in s) &&
    COST_DEFAULTS.dailyMicroUsd > 0
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — cost governance')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
