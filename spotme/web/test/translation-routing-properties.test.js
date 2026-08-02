/**
 * Property tests for the routing engine. The unit tests pin specific fixtures;
 * these assert INVARIANTS that must hold for ANY registry the router is handed,
 * generated from a seeded RNG so the run is deterministic and reproducible. If
 * the router ever chooses a gated-out provider, returns a score outside [0,1], or
 * stops being a pure function of its inputs, one of these fails.
 *
 * Also exercises the new (default-off) `attempt` hook that lets the pipeline add
 * a bounded transient retry to the primary route without changing default routing.
 *
 *   node test/translation-routing-properties.test.js
 */
import { createProviderRegistry } from '../src/lib/translation/registry.js'
import { createRouter } from '../src/lib/translation/router.js'
import { createBreakerRegistry } from '../src/lib/translation/circuit-breaker.js'
import { score, WEIGHT_PROFILES } from '../src/lib/translation/scoring.js'
import { makeAttempt } from '../src/lib/translation/retry.js'
import { ROUTING_PROFILES } from '../src/lib/translation/types.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }
const checkAsync = async (name, fn) => { names.push(name); try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/** A tiny seeded LCG so the "random" scenarios are reproducible. */
function rng (seed) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0xffffffff }
}

const QUALITY_TIERS = ['reference', 'high', 'general', 'fallback']
const LATENCY = ['realtime', 'fast', 'medium', 'slow']
const COST = ['free', 'cheap', 'metered', 'premium']
const PRIVACY = ['on-device', 'cloud-contract', 'cloud-keyless']
const pick = (r, arr) => arr[Math.floor(r() * arr.length)]

/**
 * Generate a random-but-valid provider. Every random draw is taken ONCE, at
 * construction, and frozen into stable closures — so `health()`/`capabilities()`
 * return the same values on every call and the provider itself is deterministic
 * (a provider whose health changed each time it was read would not be a fair
 * subject for a determinism invariant).
 */
function randomProvider (r, i) {
  const privacy = pick(r, PRIVACY)
  const fitness = r() // 0..1; 0 gates it out on pair
  const p95 = Math.floor(r() * 8000)
  const caps = {
    supports: ['translate'],
    languagePairs: () => fitness,
    scripts: ['Latn'], streaming: false,
    qualityTier: pick(r, QUALITY_TIERS),
    latencyClass: pick(r, LATENCY),
    costClass: pick(r, COST),
    privacy, rateLimit: {}
  }
  const health = { circuit: 'closed', p50Ms: 100, p95Ms: p95, errorRate: 0 }
  return {
    id: `p${i}`,
    capabilities: () => caps,
    health: () => health,
    priceSignal: () => ({ unit: 'char', estimatedUnits: 1, costClass: caps.costClass }),
    translate: async () => ({ text: 'ok', engine: `p${i}` })
  }
}

function randomRegistry (r, n) {
  const reg = createProviderRegistry()
  for (let i = 0; i < n; i++) reg.register(randomProvider(r, i))
  return reg
}

const SCENARIOS = 300

/* ------------------------------------------------ invariant sweep ---------- */

check('INV: every candidate score is within [0,1]', () => {
  const r = rng(1)
  for (let n = 0; n < SCENARIOS; n++) {
    const reg = randomRegistry(r, 1 + Math.floor(r() * 8))
    const profile = pick(r, ROUTING_PROFILES)
    const d = createRouter({ registry: reg }).route({ targetLang: 'en', routingProfile: profile })
    for (const c of d.candidates) if (!(c.score >= 0 && c.score <= 1)) return false
  }
  return true
})

check('INV: the chosen provider is the argmax among gated-in, or null', () => {
  const r = rng(2)
  for (let n = 0; n < SCENARIOS; n++) {
    const reg = randomRegistry(r, 1 + Math.floor(r() * 8))
    const d = createRouter({ registry: reg }).route({ targetLang: 'en', routingProfile: pick(r, ROUTING_PROFILES) })
    const gatedIn = d.candidates.filter((c) => c.gatedOut === undefined)
    if (gatedIn.length === 0) { if (d.chosen !== null) return false; continue }
    const top = gatedIn.reduce((a, b) => (b.score > a.score ? b : a))
    if (d.chosen !== gatedIn[0].id) return false
    if (gatedIn[0].score < top.score) return false
  }
  return true
})

check('INV: a chosen provider always passes every hard gate', () => {
  const r = rng(3)
  for (let n = 0; n < SCENARIOS; n++) {
    const reg = randomRegistry(r, 1 + Math.floor(r() * 8))
    const tenantId = r() > 0.5 ? 'acme' : null
    const d = createRouter({ registry: reg }).route({ targetLang: 'en', tenantId })
    if (!d.chosen) continue
    const p = reg.get(d.chosen)
    const caps = p.capabilities()
    if (caps.languagePairs('*', 'en') <= 0) return false
    if (tenantId && caps.privacy === 'cloud-keyless') return false // enterprise never keyless
  }
  return true
})

check('INV: the fallback chain never contains the chosen and is sorted desc', () => {
  const r = rng(4)
  for (let n = 0; n < SCENARIOS; n++) {
    const reg = randomRegistry(r, 1 + Math.floor(r() * 8))
    const d = createRouter({ registry: reg }).route({ targetLang: 'en' })
    if (d.fallbackChain.includes(d.chosen)) return false
    const scores = d.candidates.filter((c) => c.gatedOut === undefined).map((c) => c.score)
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[i - 1]) return false
  }
  return true
})

check('INV: gated-out candidates score 0, carry a reason, and sort last', () => {
  const r = rng(5)
  for (let n = 0; n < SCENARIOS; n++) {
    const reg = randomRegistry(r, 1 + Math.floor(r() * 8))
    const d = createRouter({ registry: reg }).route({ targetLang: 'en' })
    let seenGatedOut = false
    for (const c of d.candidates) {
      if (c.gatedOut !== undefined) { seenGatedOut = true; if (c.score !== 0) return false }
      else if (seenGatedOut) return false // a gated-in appeared AFTER a gated-out
    }
  }
  return true
})

check('INV: routing is a PURE function — same inputs, same decision', () => {
  const r = rng(6)
  for (let n = 0; n < 100; n++) {
    const reg = randomRegistry(r, 1 + Math.floor(r() * 8))
    const req = { targetLang: 'en', routingProfile: pick(r, ROUTING_PROFILES), tenantId: r() > 0.5 ? 't' : null }
    const router = createRouter({ registry: reg })
    const a = router.route(req)
    const b = router.route(req)
    if (a.chosen !== b.chosen) return false
    if (a.candidates.map((c) => c.id).join(',') !== b.candidates.map((c) => c.id).join(',')) return false
  }
  return true
})

check('INV: score() is deterministic for the same provider/request/ctx', () => {
  const r = rng(7)
  for (let n = 0; n < 200; n++) {
    const p = randomProvider(r, n)
    const req = { targetLang: 'en' }
    const ctx = { profile: pick(r, ROUTING_PROFILES), quality: r() }
    const s1 = score(p, req, ctx)
    const s2 = score(p, req, ctx)
    if (s1 !== s2) return false
  }
  return true
})

check('every weight profile still sums to exactly 1.0', () =>
  ROUTING_PROFILES.every((name) => {
    const w = WEIGHT_PROFILES[name]
    return Math.abs(w.fit + w.quality + w.latency + w.cost + w.privacy - 1) < 1e-9
  }))

/* ---------------------------------------- the attempt() retry hook --------- */

await checkAsync('the attempt hook is DEFAULT OFF — one call, exactly today\'s behaviour', async () => {
  let calls = 0
  const reg = createProviderRegistry()
  reg.register({ id: 'p', capabilities: () => ({ supports: ['translate'], languagePairs: () => 1, scripts: ['Latn'], streaming: false, qualityTier: 'high', latencyClass: 'fast', costClass: 'free', privacy: 'cloud-contract', rateLimit: {} }), health: () => ({ circuit: 'closed', p50Ms: 1, p95Ms: 1, errorRate: 0 }), priceSignal: () => ({ unit: 'char', estimatedUnits: 1, costClass: 'free' }), translate: async () => { calls += 1; throw new Error('503 transient') } })
  await createRouter({ registry: reg, breakers: createBreakerRegistry() }).execute({ targetLang: 'en' })
  return calls === 1 // no retry by default
})

await checkAsync('with a retry attempt, a transient-then-success provider is retried and serves', async () => {
  let calls = 0
  const reg = createProviderRegistry()
  reg.register({ id: 'p', capabilities: () => ({ supports: ['translate'], languagePairs: () => 1, scripts: ['Latn'], streaming: false, qualityTier: 'high', latencyClass: 'fast', costClass: 'free', privacy: 'cloud-contract', rateLimit: {} }), health: () => ({ circuit: 'closed', p50Ms: 1, p95Ms: 1, errorRate: 0 }), priceSignal: () => ({ unit: 'char', estimatedUnits: 1, costClass: 'free' }), translate: async () => { calls += 1; if (calls < 3) throw new Error('503 transient'); return { text: 'served', engine: 'p' } } })
  const attempt = makeAttempt({ maxAttempts: 3, baseDelayMs: 1 }, { sleep: async () => {} })
  const { result } = await createRouter({ registry: reg, breakers: createBreakerRegistry(), attempt }).execute({ targetLang: 'en' })
  return result?.text === 'served' && calls === 3
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — routing invariants (property tests)')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
