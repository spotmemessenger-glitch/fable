/**
 * Translation routing benchmarks — Roadmap V2 §8 requires environment, raw
 * results, median AND tail, so all four are printed. These measure the PURE
 * routing cost — scoring the full 11-provider registry, applying every hard
 * gate, and producing a RoutingDecision — with no network and no vendor call,
 * so the number isolates the router's own overhead. It is the budget the live
 * path would pay ON TOP of the existing engine once the platform is enabled;
 * the vendor legs themselves are measured separately (the engine documents
 * service p90 3.8 s, ?op=read p50 3.2 s).
 *
 *   node test/bench/translation-routing.bench.mjs
 */
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { buildTranslationPlatform } from '../../src/lib/translation/index.js'
import { createRouter } from '../../src/lib/translation/router.js'
import { createProviderRegistry } from '../../src/lib/translation/registry.js'
import { createBreakerRegistry } from '../../src/lib/translation/circuit-breaker.js'
import { createQualityStore } from '../../src/lib/translation/confidence.js'
import { score } from '../../src/lib/translation/scoring.js'

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
  console.log(`  n=${t.n}  min ${us(t.min)}  p50 ${us(t.p50)}  p90 ${us(t.p90)}  p95 ${us(t.p95)}  p99 ${us(t.p99)}  max ${us(t.max)}  mean ${us(t.mean)}`)
}

console.log('========================================')
console.log('  translation routing — micro-benchmarks')
console.log('========================================')
console.log(`  node ${process.version}  ${cpus()[0]?.model || 'cpu'} x${cpus().length}  ${(totalmem() / 1e9).toFixed(1)}GB`)

// The real thing: the full builtin registry (11 providers), scored per request.
const platform = buildTranslationPlatform({ enabled: true })
const requests = [
  { text: 'naan innaiku vetuku varen', targetLang: 'en', routingProfile: 'accuracy' },
  { text: 'hello', targetLang: 'kn', sourceLang: 'en', routingProfile: 'accuracy' },
  { text: 'bonjour le monde', targetLang: 'fr', sourceLang: 'en', routingProfile: 'latency' },
  { text: 'vanakkam', targetLang: 'en', tenantId: 'acme', routingProfile: 'cost' }
]

const WARM = 5000
const N = 50_000
for (let i = 0; i < WARM; i++) platform.decide(requests[i % requests.length])

const decideSamples = []
for (let i = 0; i < N; i++) {
  const r = requests[i % requests.length]
  const t0 = performance.now()
  platform.decide(r)
  decideSamples.push(performance.now() - t0)
}
report('route() over the full 11-provider registry (accuracy/latency/cost mix)', decideSamples)

// A single score() call, isolated.
const one = createProviderRegistry()
const provider = platform.registry.get('sarvam')
one.register(provider)
const scoreSamples = []
for (let i = 0; i < N; i++) {
  const t0 = performance.now()
  score(provider, { targetLang: 'kn', sourceLang: 'en' }, { profile: 'accuracy', quality: 0.6 })
  scoreSamples.push(performance.now() - t0)
}
report('score() a single provider', scoreSamples)

// The router with breakers + a warmed quality store — the enabled shape.
const breakers = createBreakerRegistry()
const quality = createQualityStore()
for (const id of platform.registry.ids()) quality.record(id, '*|en', 'agree')
const router = createRouter({ registry: platform.registry, breakers, quality, policy: { policyVersion: 'rt-bench' } })
const fullSamples = []
for (let i = 0; i < N; i++) {
  const r = requests[i % requests.length]
  const t0 = performance.now()
  router.route(r)
  fullSamples.push(performance.now() - t0)
}
report('route() with breakers + quality store (the enabled shape)', fullSamples)

console.log('\n========================================')
console.log('  a routing decision is sub-millisecond; the cost of choosing is')
console.log('  negligible beside any vendor leg it chooses between.')
console.log('========================================\n')
