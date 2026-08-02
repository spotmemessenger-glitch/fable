/**
 * The integration seam + the COMPATIBILITY guarantee (design §9, §17.5).
 *
 * The load-bearing property of the whole PR: with the master flag OFF, the entry
 * is a pure passthrough to the legacy engine — same result object, no platform
 * side effect of any kind. This is what makes "flag-OFF is byte-identical to
 * today" a fact about the code, not a promise in a description. Section 2 then
 * drives the ENABLED pipeline end-to-end with deterministic fakes (no network, no
 * key): routing, cross-verify, adjudication, caching, cost ceilings, privacy, and
 * the explicit uncertain result.
 *
 *   node test/translation-integration.test.js
 */
import { createTranslationEntry, STREAMING_NOT_IMPLEMENTED } from '../src/lib/translation/integration.js'
import { buildTranslationPlatform } from '../src/lib/translation/index.js'
import { createPipeline } from '../src/lib/translation/pipeline.js'
import { createProviderRegistry } from '../src/lib/translation/registry.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }
const checkAsync = async (name, fn) => { names.push(name); try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/* ============================ 1. COMPATIBILITY: flag OFF is byte-identical == */

await checkAsync('OFF: translate returns the ENGINE\'S OWN result object, unmodified', async () => {
  const engineOutput = { text: 'legacy answer', engine: 'azure', detected: 'ta' }
  let platformRan = false
  const entry = createTranslationEntry({
    engine: async () => engineOutput,
    platform: { run: async () => { platformRan = true; return { text: 'PLATFORM' } } },
    isEnabled: () => false
  })
  const out = await entry.translate({ text: 'varen', targetLang: 'en' })
  // Same reference — not a copy, not a wrapper. Byte-identical by construction.
  return out === engineOutput && platformRan === false
})

await checkAsync('OFF: no platform collaborator is touched — no cache, cost or metrics mutation', async () => {
  // Build a real platform and prove that going through the OFF entry never calls it.
  const platform = buildTranslationPlatform({ enabled: false })
  const beforeCache = JSON.stringify(platform.cache.snapshot())
  const beforeCost = JSON.stringify(platform.cost.snapshot())
  const beforeMetrics = JSON.stringify(platform.metrics.snapshot())
  const entry = createTranslationEntry({
    engine: async (r) => ({ text: 'engine:' + r.text, engine: 'azure' }),
    platform, isEnabled: () => false
  })
  await entry.translate({ text: 'hi', targetLang: 'ta' })
  await entry.translateBatch([{ text: 'a', targetLang: 'ta' }, { text: 'b', targetLang: 'ta' }])
  return JSON.stringify(platform.cache.snapshot()) === beforeCache &&
    JSON.stringify(platform.cost.snapshot()) === beforeCost &&
    JSON.stringify(platform.metrics.snapshot()) === beforeMetrics
})

await checkAsync('OFF: a batch is exactly N legacy calls, in order, verbatim', async () => {
  const seen = []
  const entry = createTranslationEntry({ engine: async (r) => { seen.push(r.text); return { text: 'E:' + r.text } }, isEnabled: () => false })
  const out = await entry.translateBatch([{ text: 'one', targetLang: 'ta' }, { text: 'two', targetLang: 'ta' }])
  return seen.join(',') === 'one,two' && out[0].text === 'E:one' && out[1].text === 'E:two'
})

await checkAsync('OFF: a voice-note transcript takes the same verbatim engine path', async () => {
  const entry = createTranslationEntry({ engine: async (r) => ({ text: 'E:' + r.text, kind: r.kind }), isEnabled: () => false })
  const out = await entry.translateVoiceNote({ text: 'transcribed', targetLang: 'en' })
  return out.text === 'E:transcribed' && out.kind === 'voice-note'
})

check('an entry with no engine delegate is refused at construction', () => {
  try { createTranslationEntry({}); return false } catch { return true }
})

await checkAsync('ON: the entry routes to platform.run, not the legacy engine', async () => {
  let engineRan = false
  const entry = createTranslationEntry({
    engine: async () => { engineRan = true; return { text: 'LEGACY' } },
    platform: { run: async () => ({ text: 'PLATFORM', verified: 'agree' }) },
    isEnabled: () => true
  })
  const out = await entry.translate({ text: 'x', targetLang: 'en' })
  return out.text === 'PLATFORM' && engineRan === false
})

/* =============================== 2. the ENABLED pipeline with fakes ========= */

/** A deterministic fake provider. No network, no key. */
function fake (id, out, over = {}) {
  const caps = {
    supports: over.supports || ['translate'],
    languagePairs: over.languagePairs || (() => 0.9),
    scripts: ['Latn'], streaming: false,
    qualityTier: over.qualityTier || 'high',
    latencyClass: over.latencyClass || 'fast',
    costClass: over.costClass || 'metered',
    privacy: over.privacy || 'cloud-contract', rateLimit: {},
    costModel: { unit: 'char', microUsdPerUnit: over.rate ?? 0.02 }
  }
  const p = {
    id,
    capabilities: () => caps,
    health: () => over.health || { circuit: 'closed', p50Ms: 100, p95Ms: over.p95 ?? 300, errorRate: 0 },
    priceSignal: (r) => ({ unit: 'char', estimatedUnits: (r.text || '').length, costClass: caps.costClass })
  }
  if (caps.supports.includes('translate')) p.translate = over.translate || (async () => ({ text: out, engine: id }))
  if (caps.supports.includes('adjudicate')) p.adjudicate = over.adjudicate || (async () => ({ text: out, pick: 'A' }))
  return p
}
const reg = (...ps) => { const r = createProviderRegistry(); for (const p of ps) r.register(p); return r }

await checkAsync('ENABLED: two engines that agree → confirmed, high confidence', async () => {
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'hello'), fake('azure', 'hello')), flags: { dynamicRouting: true, crossVerify: true } })
  const out = await platform.run({ text: 'namaste', targetLang: 'en' })
  return out.verified === 'agree' && out.confidence === 0.95 && out.text === 'hello' && out.uncertain === false
})

await checkAsync('ENABLED: engines disagree with adjudication OFF → explicit uncertain', async () => {
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'apple'), fake('azure', 'orange')), flags: { dynamicRouting: true, crossVerify: true, adjudication: false } })
  const out = await platform.run({ text: 'x', targetLang: 'en' })
  return out.uncertain === true && out.alternative !== undefined
})

await checkAsync('ENABLED: engines disagree with adjudication ON → adjudicated', async () => {
  const judge = fake('gemini', 'apple', { supports: ['translate', 'adjudicate'] })
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'apple'), fake('azure', 'orange'), judge), flags: { dynamicRouting: true, crossVerify: true, adjudication: true, costGovernance: true } })
  const out = await platform.run({ text: 'x', targetLang: 'en', accountId: 'acme' })
  return out.verified === 'adjudicated' && out.uncertain === false
})

await checkAsync('ENABLED: a repeat request is served from cache with no second provider call', async () => {
  let calls = 0
  const counting = fake('google', 'cached-answer', { translate: async () => { calls += 1; return { text: 'cached-answer', engine: 'google' } } })
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(counting), flags: { dynamicRouting: true, cache: true } })
  const first = await platform.run({ text: 'repeat me', targetLang: 'en' })
  const callsAfterFirst = calls
  const second = await platform.run({ text: 'repeat me', targetLang: 'en' })
  return first.cacheHit === false && second.cacheHit === true && second.text === 'cached-answer' && calls === callsAfterFirst
})

await checkAsync('ENABLED: a request over the cost ceiling is refused before spending', async () => {
  let called = false
  const pricey = fake('openai', 'x', { rate: 1000, translate: async () => { called = true; return { text: 'x', engine: 'openai' } } })
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(pricey), flags: { dynamicRouting: true, costGovernance: true }, costLimits: { dailyMicroUsd: 1, monthlyMicroUsd: 1 } })
  const out = await platform.run({ text: 'a very long message that costs a lot to translate', targetLang: 'en', accountId: 'broke' })
  return out.uncertain === true && out.blocked === true && called === false
})

await checkAsync('ENABLED: strict privacy with only cloud providers → no eligible provider', async () => {
  // strict admits on-device only; a cloud-contract provider is gated out.
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'x', { privacy: 'cloud-contract' })), flags: { dynamicRouting: true } })
  const out = await platform.run({ text: 'secret', targetLang: 'en', privacyMode: 'strict' })
  return out.uncertain === true && /no eligible provider/.test(out.reason)
})

await checkAsync('ENABLED: a wrong-script primary is shed and the fallback serves', async () => {
  const wrong = fake('primary', 'नमस्ते', { p95: 100 }) // Devanagari for a Kannada target
  const right = fake('backup', 'ಸರಿ', { p95: 900 })
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(wrong, right), flags: { dynamicRouting: true } })
  const out = await platform.run({ text: 'x', targetLang: 'kn' })
  return out.text === 'ಸರಿ' && out.uncertain === false
})

await checkAsync('ENABLED: metrics and privacy notice are attached to a served result', async () => {
  const platform = buildTranslationPlatform({ enabled: true, registry: reg(fake('google', 'hi')), flags: { dynamicRouting: true } })
  const out = await platform.run({ text: 'x', targetLang: 'en' })
  const snap = platform.metrics.snapshot()
  return snap.requests === 1 && typeof out.latencyMs === 'number' && /cloud/.test(out.privacyNotice)
})

await checkAsync('the pipeline can be built and driven directly (leaf-level, no platform wrapper)', async () => {
  // createPipeline is the orchestrator index.js composes; drive it on its own to
  // prove it needs only a registry + flags, and threads a whole-chat context.
  const pipeline = createPipeline({ registry: reg(fake('google', 'contextual')), flags: { dynamicRouting: true } })
  const { createContextWindow } = await import('../src/lib/translation/context.js')
  const window = createContextWindow()
  window.add({ speaker: 'alice', text: 'ne varya', lang: 'ta' })
  const out = await pipeline.translate({ text: 'varen', targetLang: 'en' }, { window, glossary: ['SpotMe'] })
  return out.text === 'contextual' && out.uncertain === false && typeof out.latencyMs === 'number'
})

/* ------------------------------------------------------- 3. streaming stub - */

await checkAsync('streaming is a declared STUB that throws — no live-call impl', async () => {
  const entry = createTranslationEntry({ engine: async () => ({}), isEnabled: () => false })
  if (entry.streaming.supported !== false) return false
  if (!/interface stub/.test(entry.streaming.describe().reason)) return false
  try { const it = entry.streaming.stream(); await it.next(); return false } catch (e) { return e.message === STREAMING_NOT_IMPLEMENTED }
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — integration + compatibility (flag-OFF byte-identical)')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
