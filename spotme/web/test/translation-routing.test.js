/**
 * The routing engine — scoring, the hard gates, the profiles, the decision.
 *
 * The whole point of the abstraction is that "which provider" stops being a
 * branch and becomes a number, so this file pins the arithmetic and the gates
 * as deterministic fixtures: given fixed capabilities, health, quality and
 * policy, the router chooses the same provider every time. No network, no clock
 * except the one injected into the breakers.
 *
 *   node test/translation-routing.test.js
 */
import {
  WEIGHT_PROFILES, PROFILE_BUDGET_MS, score, scoreBreakdown
} from '../src/lib/translation/scoring.js'
import { createProviderRegistry } from '../src/lib/translation/registry.js'
import { createRouter } from '../src/lib/translation/router.js'
import { createBreakerRegistry } from '../src/lib/translation/circuit-breaker.js'
import { createQualityStore } from '../src/lib/translation/confidence.js'
import { ROUTING_PROFILES } from '../src/lib/translation/types.js'

const results = {}
const names = []
const check = (name, fn) => {
  names.push(name)
  try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message }
}
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

/** A controllable provider for exact routing fixtures. */
function prov (id, o = {}) {
  const caps = {
    supports: o.supports || ['translate'],
    languagePairs: o.languagePairs || (() => 0.8),
    scripts: ['Latn'], streaming: false,
    qualityTier: o.qualityTier || 'high',
    latencyClass: o.latencyClass || 'fast',
    costClass: o.costClass || 'metered',
    privacy: o.privacy || 'cloud-contract',
    rateLimit: {}
  }
  const p = {
    id,
    capabilities: () => caps,
    health: () => o.health || { circuit: 'closed', p50Ms: 150, p95Ms: o.p95 ?? 800, errorRate: 0 },
    priceSignal: () => ({ unit: 'char', estimatedUnits: 1, costClass: caps.costClass })
  }
  const impl = o.translate || (async () => ({ text: o.out ?? 'ok', engine: id }))
  if (caps.supports.includes('translate')) p.translate = impl
  if (caps.supports.includes('comprehend')) p.comprehend = impl
  return p
}
function reg (...providers) {
  const r = createProviderRegistry()
  for (const p of providers) r.register(p)
  return r
}

/* ------------------------------------------------------- 1. the scoring ---- */

check('every weight profile sums to exactly 1.0', () =>
  ROUTING_PROFILES.every((name) => {
    const w = WEIGHT_PROFILES[name]
    return near(w.fit + w.quality + w.latency + w.cost + w.privacy, 1.0)
  }))

check('a score is in [0,1] for any inputs', () => {
  const p = prov('p', { languagePairs: () => 1, costClass: 'free', privacy: 'on-device', p95: 0 })
  const s = score(p, { targetLang: 'en' }, { profile: 'accuracy', quality: 1 })
  return s >= 0 && s <= 1
})

check('the breakdown is the exact weighted sum of its terms', () => {
  const p = prov('p', { languagePairs: () => 1, costClass: 'free', privacy: 'on-device', p95: 800 })
  const b = scoreBreakdown(p, { targetLang: 'en' }, { profile: 'accuracy', quality: 0.6 })
  // fit1, quality0.6, latency 1-800/8000=0.9, cost 1-0=1, privacy 1.0
  const w = WEIGHT_PROFILES.accuracy
  const expected = w.fit * 1 + w.quality * 0.6 + w.latency * 0.9 + w.cost * 1 + w.privacy * 1
  return near(b.terms.latency, 0.9) && near(b.score, expected)
})

check('an unknown profile falls back to accuracy rather than NaN', () => {
  const p = prov('p')
  const b = scoreBreakdown(p, { targetLang: 'en' }, { profile: 'telepathy' })
  return b.profile === 'accuracy' && b.score >= 0 && b.score <= 1
})

check('the latency profile judges the tail against a tighter budget', () =>
  PROFILE_BUDGET_MS.latency < PROFILE_BUDGET_MS.accuracy &&
  PROFILE_BUDGET_MS.latency < PROFILE_BUDGET_MS.cost)

/* --------------------------------------------------------- 2. hard gates --- */

check('G_supports: a provider lacking the required capability is gated out', () => {
  const r = reg(prov('mt', { supports: ['translate'] }), prov('reader', { supports: ['comprehend'] }))
  const d = createRouter({ registry: r }).route({ targetLang: 'en', requiredCapability: 'translate' })
  return d.chosen === 'mt' &&
    d.candidates.find((c) => c.id === 'reader').gatedOut === 'capability: no translate'
})

check('G_pair: fitness 0 gates a provider out entirely', () => {
  const r = reg(prov('spec', { languagePairs: (s, t) => (t === 'kn' ? 1 : 0) }))
  const d = createRouter({ registry: r }).route({ targetLang: 'fr' })
  return d.chosen === null &&
    d.candidates.find((c) => c.id === 'spec').gatedOut === 'pair: unsupported'
})

check('G_privacy: an enterprise tenant denies a cloud-keyless provider by default', () => {
  const r = reg(prov('keyless', { privacy: 'cloud-keyless' }), prov('contract', { privacy: 'cloud-contract' }))
  const router = createRouter({ registry: r })
  const enterprise = router.route({ targetLang: 'en', tenantId: 'acme' })
  const consumer = router.route({ targetLang: 'en' })
  return enterprise.chosen === 'contract' &&
    enterprise.candidates.find((c) => c.id === 'keyless').gatedOut === 'privacy: cloud-keyless' &&
    // a consumer request (no tenant) may still reach the keyless tail
    consumer.candidates.find((c) => c.id === 'keyless').gatedOut === undefined
})

check('G_allow: a tenant allow-list gates out everything not on it', () => {
  const r = reg(prov('a'), prov('b'))
  const policy = { allowList: new Set(['a']) }
  const d = createRouter({ registry: r, policy }).route({ targetLang: 'en', tenantId: 'acme' })
  return d.chosen === 'a' &&
    d.candidates.find((c) => c.id === 'b').gatedOut === 'allow: not in tenant list'
})

check('G_circuit: an OPEN breaker sheds a provider from candidacy', () => {
  const r = reg(prov('a'), prov('b'))
  const breakers = createBreakerRegistry({ threshold: 1 })
  breakers.get('a').onFailure() // trips OPEN at threshold 1
  const d = createRouter({ registry: r, breakers }).route({ targetLang: 'en' })
  return d.chosen === 'b' &&
    d.candidates.find((c) => c.id === 'a').gatedOut === 'circuit: open'
})

/* ---------------------------------------------------- 3. the decision ------ */

check('the decision has the documented shape', () => {
  const r = reg(prov('a'), prov('b'))
  const d = createRouter({ registry: r, policy: { policyVersion: 'rt-test.1' } }).route({ targetLang: 'en' })
  return d.profile === 'accuracy' && d.requiredCapability === 'translate' &&
    Array.isArray(d.candidates) && typeof d.chosen === 'string' &&
    Array.isArray(d.fallbacksTaken) && d.verified === 'none' &&
    Array.isArray(d.breakerTrips) && d.policyVersion === 'rt-test.1'
})

check('gated-in candidates are sorted by score desc; the primary is the argmax', () => {
  // fast+free scores above slow+premium under the latency profile.
  const r = reg(
    prov('slow', { p95: 6000, costClass: 'premium' }),
    prov('fast', { p95: 200, costClass: 'free' })
  )
  const d = createRouter({ registry: r }).route({ targetLang: 'en', routingProfile: 'latency' })
  return d.chosen === 'fast' && d.fallbackChain[0] === 'slow' &&
    d.candidates[0].id === 'fast' && d.candidates[0].score >= d.candidates[1].score
})

check('gated-out candidates score 0 and carry a reason, and sort after the live ones', () => {
  const r = reg(prov('live'), prov('dead', { languagePairs: () => 0 }))
  const d = createRouter({ registry: r }).route({ targetLang: 'en' })
  const dead = d.candidates.find((c) => c.id === 'dead')
  return dead.score === 0 && typeof dead.gatedOut === 'string' &&
    d.candidates[d.candidates.length - 1].id === 'dead'
})

/* --------------------------------------- 4. profiles + quality change the pick */

check('the profile changes the winner between the same two providers', () => {
  // Same fitness, privacy and latency; they differ only in COST and QUALITY.
  // accuracy leans on quality (the premium engine wins); cost leans on price
  // (the free engine wins). Same table, two lenses, two answers.
  const r = reg(
    prov('cheapbasic', { costClass: 'free', p95: 800, privacy: 'cloud-contract' }),
    prov('premiumquality', { costClass: 'premium', p95: 800, privacy: 'cloud-contract' })
  )
  const quality = createQualityStore()
  for (let i = 0; i < 40; i++) quality.record('premiumquality', '*|en', 1.0) // strong history
  const router = createRouter({ registry: r, quality })
  const byCost = router.route({ targetLang: 'en', routingProfile: 'cost' })
  const byAccuracy = router.route({ targetLang: 'en', routingProfile: 'accuracy' })
  return byCost.chosen === 'cheapbasic' && byAccuracy.chosen === 'premiumquality'
})

check('a rising quality score lifts a provider up the ranking', () => {
  const r = reg(prov('a', { p95: 800 }), prov('b', { p95: 800 }))
  const quality = createQualityStore()
  const before = createRouter({ registry: r, quality }).route({ targetLang: 'en' })
  for (let i = 0; i < 20; i++) quality.record('b', '*|en', 'agree') // push b's EWMA up
  const after = createRouter({ registry: r, quality }).route({ targetLang: 'en' })
  // a and b tie on everything but quality; once b's quality leads, b leads.
  return before.chosen === 'a' && after.chosen === 'b'
})

/* --------------------------------------------------- 5. pair overrides ----- */

check('a pair override can PIN a lower-scored provider to the front', () => {
  const r = reg(prov('general', { p95: 200, costClass: 'free' }), prov('specialist', { p95: 3000 }))
  const policy = { pairOverrides: { '*|kn': { pin: 'specialist' } } }
  const d = createRouter({ registry: r, policy }).route({ targetLang: 'kn' })
  return d.chosen === 'specialist'
})

check('a pair override can DENY a provider for a pair', () => {
  const r = reg(prov('a'), prov('b'))
  const policy = { pairOverrides: { '*|kn': { deny: ['a'] } } }
  const d = createRouter({ registry: r, policy }).route({ targetLang: 'kn' })
  return d.chosen === 'b' &&
    d.candidates.find((c) => c.id === 'a').gatedOut === 'override: denied for pair'
})

/* ------------------------------------------------ 6. execute() walks it ---- */

await checkAsync('execute walks the chain past a failure to the next candidate', async () => {
  const r = reg(
    prov('primary', { p95: 200, costClass: 'free', translate: async () => { throw new Error('boom') } }),
    prov('backup', { p95: 900, out: 'served' })
  )
  const breakers = createBreakerRegistry({ threshold: 5 })
  const { result, decision } = await createRouter({ registry: r, breakers }).execute({ targetLang: 'en' })
  return result?.text === 'served' && decision.chosen === 'backup' &&
    decision.fallbacksTaken.includes('primary')
})

await checkAsync('a wrong-script answer is a FAILURE, not a success — it sheds and falls through', async () => {
  // primary returns Devanagari for a Kannada target — the engine's scriptOk
  // gate (reused) disqualifies it, exactly as on the live fallback path.
  const r = reg(
    prov('primary', { p95: 100, translate: async () => ({ text: 'नल पॉइंटर', engine: 'primary' }) }),
    prov('backup', { p95: 900, translate: async () => ({ text: 'ಸರಿ', engine: 'backup' }) })
  )
  const breakers = createBreakerRegistry({ threshold: 5 })
  const { result, decision } = await createRouter({ registry: r, breakers }).execute({ targetLang: 'kn' })
  return result?.engine === 'backup' && decision.fallbacksTaken.includes('primary')
})

await checkAsync('a total outage returns no result and verified:none, never a throw', async () => {
  const r = reg(
    prov('a', { translate: async () => { throw new Error('down') } }),
    prov('b', { translate: async () => { throw new Error('down') } })
  )
  const { result, decision, error } = await createRouter({ registry: r, breakers: createBreakerRegistry() }).execute({ targetLang: 'en' })
  return result === null && decision.verified === 'none' && error instanceof Error
})

await checkAsync('execute records a breaker trip when a provider fails past its threshold', async () => {
  const r = reg(
    prov('flaky', { translate: async () => { throw new Error('down') } }),
    prov('ok', { out: 'served' })
  )
  const breakers = createBreakerRegistry({ threshold: 1 }) // trip on first failure
  const { decision } = await createRouter({ registry: r, breakers }).execute({ targetLang: 'en' })
  return decision.breakerTrips.includes('flaky') && breakers.get('flaky').state() === 'open'
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — routing, scoring, gates, overrides')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
