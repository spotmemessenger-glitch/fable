/**
 * Observability (design §14): counts by provider and pair, success/fail, latency
 * and confidence percentiles, fallback/adjudication/cache/wrong-script/uncertainty
 * counters, estimated cost — and a readiness view that exposes circuit state and
 * capability but NO secret and NO content.
 *
 *   node test/translation-metrics.test.js
 */
import { createMetrics, percentiles, readiness } from '../src/lib/translation/metrics.js'
import { createProviderRegistry } from '../src/lib/translation/registry.js'
import { createBreakerRegistry } from '../src/lib/translation/circuit-breaker.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

const provider = (id, caps = ['translate']) => ({
  id,
  capabilities: () => ({ supports: caps, languagePairs: () => 0.8, scripts: ['Latn'], streaming: false, qualityTier: 'high', latencyClass: 'fast', costClass: 'metered', privacy: 'cloud-contract', rateLimit: {} }),
  health: () => ({ circuit: 'closed', p50Ms: 100, p95Ms: 300, errorRate: 0 }),
  priceSignal: () => ({ unit: 'char', estimatedUnits: 1, costClass: 'metered' }),
  translate: async () => ({ text: 'x', engine: id }),
  ...(caps.includes('adjudicate') ? { adjudicate: async () => ({ text: 'x' }) } : {}),
  ...(caps.includes('detect') ? { detectLanguage: async () => ({ language: 'en' }) } : {})
})

/* ------------------------------------------------------- 1. percentiles ---- */

check('percentiles are computed from an unsorted sample', () => {
  const p = percentiles([5, 1, 4, 2, 3], [0.5, 0.9])
  return p.n === 5 && p.min === 1 && p.max === 5 && p.p50 >= 3 && p.mean === 3
})

check('percentiles of an empty set are zeros, not a throw', () => {
  const p = percentiles([])
  return p.n === 0 && p.p50 === 0 && p.mean === 0
})

/* ---------------------------------------------------------- 2. counters ---- */

check('record rolls up requests, success/fail and by-provider / by-pair', () => {
  const m = createMetrics()
  m.record({ ok: true, provider: 'sarvam', pair: 'ta|en', latencyMs: 100, confidence: 0.95, confidenceBand: 'confirmed' })
  m.record({ ok: false, provider: 'gemini', pair: 'ta|en', latencyMs: 300, uncertain: true })
  const s = m.snapshot()
  return s.requests === 2 && s.success === 1 && s.fail === 1 &&
    s.byProvider.sarvam === 1 && s.byPair['ta|en'] === 2 && s.uncertain === 1
})

check('fallback, adjudication, wrong-script and breaker-trip counters accumulate', () => {
  const m = createMetrics()
  m.record({ ok: true, provider: 'a', fallbacks: 2, adjudicated: true, wrongScript: 1, breakerTrips: 1 })
  const s = m.snapshot()
  return s.fallbacks === 2 && s.adjudications === 1 && s.wrongScriptRejections === 1 && s.breakerTrips === 1
})

check('cache hit rate and estimated cost aggregate', () => {
  const m = createMetrics()
  m.record({ ok: true, cacheHit: true, estimatedMicroUsd: 20 })
  m.record({ ok: true, cacheHit: false, estimatedMicroUsd: 30 })
  const s = m.snapshot()
  return s.cacheHitRate === 0.5 && s.estimatedMicroUsd === 50
})

check('latency + confidence percentiles appear in the snapshot', () => {
  const m = createMetrics()
  for (const l of [100, 200, 300, 400]) m.record({ ok: true, latencyMs: l, confidence: 0.9 })
  const s = m.snapshot()
  return s.latencyMs.n === 4 && s.latencyMs.p50 >= 200 && s.confidence.n === 4
})

check('unknown/content-shaped fields are ignored — no content can be smuggled in', () => {
  const m = createMetrics()
  m.record({ ok: true, text: 'secret plaintext', q: 'more secret', provider: 'a' })
  const s = m.snapshot()
  const json = JSON.stringify(s)
  return !/secret/.test(json) && s.requests === 1
})

/* ---------------------------------------------------------- 3. readiness --- */

check('readiness reports ready when a translator exists and its breaker is closed', () => {
  const reg = createProviderRegistry(); reg.register(provider('google'))
  const breakers = createBreakerRegistry()
  const r = readiness({ registry: reg, breakers, flags: { platformV2: false } })
  return r.ready === true && r.providers === 1 && r.capable.translate.includes('google')
})

check('readiness reports NOT ready when every translator\'s breaker is open', () => {
  const reg = createProviderRegistry(); reg.register(provider('google'))
  const breakers = createBreakerRegistry({ threshold: 1 })
  breakers.get('google').onFailure() // trips open
  const r = readiness({ registry: reg, breakers })
  return r.ready === false && r.circuits.google.circuit === 'open'
})

check('readiness exposes flags, capability and circuits — never a secret', () => {
  const reg = createProviderRegistry(); reg.register(provider('gemini', ['translate', 'adjudicate']))
  const r = readiness({ registry: reg, breakers: createBreakerRegistry(), flags: { platformV2: true, cache: false } })
  const json = JSON.stringify(r)
  return r.flags.platformV2 === true && r.capable.adjudicate.includes('gemini') &&
    !/key|secret|token|apiKey/i.test(json)
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — observability + readiness')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
