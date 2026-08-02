/**
 * Translation PIPELINE benchmarks — Roadmap V2 §8 (environment, raw results,
 * median AND tail). These isolate the platform's LOCAL orchestration cost from
 * external provider latency: every provider here is a DETERMINISTIC fake that
 * resolves immediately, so the numbers are purely the cost of cache lookup,
 * context construction, confidence aggregation, routing, and the pipeline glue —
 * the overhead the live path pays ON TOP of whatever vendor leg it drives. The
 * vendor legs themselves are measured separately (the engine documents service
 * p90 3.8 s, ?op=read p50 3.2 s).
 *
 *   node test/bench/translation-pipeline.bench.mjs
 */
import { cpus, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'
import { buildTranslationPlatform } from '../../src/lib/translation/index.js'
import { createProviderRegistry } from '../../src/lib/translation/registry.js'
import { createTranslationCache } from '../../src/lib/translation/cache.js'
import { createContextWindow, buildContext } from '../../src/lib/translation/context.js'
import { resolve } from '../../src/lib/translation/verify.js'

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

/** A deterministic, zero-latency fake provider. */
function fake (id, out, over = {}) {
  const caps = {
    supports: over.supports || ['translate'],
    languagePairs: over.languagePairs || (() => 0.9),
    scripts: ['Latn'], streaming: false,
    qualityTier: over.qualityTier || 'high', latencyClass: 'fast',
    costClass: over.costClass || 'metered', privacy: 'cloud-contract', rateLimit: {},
    costModel: { unit: 'char', microUsdPerUnit: 0.02 }
  }
  const p = {
    id,
    capabilities: () => caps,
    health: () => ({ circuit: 'closed', p50Ms: 100, p95Ms: over.p95 ?? 300, errorRate: 0 }),
    priceSignal: (r) => ({ unit: 'char', estimatedUnits: (r.text || '').length, costClass: caps.costClass })
  }
  if (caps.supports.includes('translate')) p.translate = over.translate || (async () => ({ text: out, engine: id }))
  if (caps.supports.includes('adjudicate')) p.adjudicate = over.adjudicate || (async () => ({ text: out, pick: 'A' }))
  return p
}
const reg = (...ps) => { const r = createProviderRegistry(); for (const p of ps) r.register(p); return r }

async function bench (title, fn, { n = 20000, warm = 2000 } = {}) {
  for (let i = 0; i < warm; i++) await fn(i)
  const samples = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    await fn(i)
    samples.push(performance.now() - t0)
  }
  report(title, samples)
}

console.log('========================================')
console.log('  translation pipeline — micro-benchmarks (LOCAL cost, fake vendors)')
console.log('========================================')
console.log(`  node ${process.version}  ${cpus()[0]?.model || 'cpu'} x${cpus().length}  ${(totalmem() / 1e9).toFixed(1)}GB`)

// --- cache lookup (hit) ------------------------------------------------------
const cache = createTranslationCache()
const warmKey = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'namaste' }, { privacyMode: 'standard', contextFingerprint: 'c' })
cache.set(warmKey, { text: 'greetings' })
await bench('cache lookup (hit)', () => { cache.get(warmKey); return Promise.resolve() }, { n: 50000 })

// --- context construction ----------------------------------------------------
const window = createContextWindow()
for (let i = 0; i < 6; i++) window.add({ speaker: i % 2 ? 'a' : 'b', text: `prior turn number ${i} with some words`, lang: 'ta' })
await bench('context construction (6-turn window → fingerprint)', () => { buildContext('naan varen', window, { glossary: ['SpotMe', 'Ruflo'] }); return Promise.resolve() }, { n: 50000 })

// --- confidence aggregation (consensus of two agreeing candidates) -----------
const cands = [{ text: 'i will come', engine: 'a' }, { text: 'I will come.', engine: 'b' }]
await bench('confidence aggregation (resolve → agree)', () => resolve(cands, 'en'), { n: 50000 })

// --- single-provider pipeline ------------------------------------------------
const single = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'hello')), flags: { dynamicRouting: true } })
await bench('pipeline: single provider (route+execute+metrics)', () => single.run({ text: 'x', targetLang: 'en' }))

// --- fallback path (primary throws, backup serves) ---------------------------
const withFallback = buildTranslationPlatform({
  enabled: true,
  registry: reg(fake('primary', 'x', { p95: 100, translate: async () => { throw new Error('503 transient') } }), fake('backup', 'served', { p95: 900 })),
  flags: { dynamicRouting: true }
})
await bench('pipeline: fallback path (primary fails → backup)', () => withFallback.run({ text: 'x', targetLang: 'en' }))

// --- cross-provider path (two agree) -----------------------------------------
const crossAgree = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'hello'), fake('azure', 'hello')), flags: { dynamicRouting: true, crossVerify: true } })
await bench('pipeline: cross-provider path (verify → agree)', () => crossAgree.run({ text: 'x', targetLang: 'en' }))

// --- adjudication path (two disagree, judge picks) ---------------------------
const adjudicated = buildTranslationPlatform({
  enabled: true,
  registry: reg(fake('google', 'apple'), fake('azure', 'orange'), fake('gemini', 'apple', { supports: ['translate', 'adjudicate'] })),
  flags: { dynamicRouting: true, crossVerify: true, adjudication: true, costGovernance: true }
})
await bench('pipeline: adjudication path (disagree → judge)', () => adjudicated.run({ text: 'x', targetLang: 'en', accountId: 'acme' }))

console.log('\n========================================')
console.log('  Reading: the whole LOCAL pipeline — cache, context, routing, verify,')
console.log('  cost, metrics — is a few microseconds. The wall-clock of a real')
console.log('  request is the vendor legs the pipeline chooses between, not this.')
console.log('========================================\n')
