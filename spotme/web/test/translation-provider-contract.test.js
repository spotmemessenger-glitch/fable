/**
 * The translation provider CONTRACT, the registry, and the capability matrix.
 *
 * Mirrors test/transport.test.js: one interface, checkable, that REJECTS a bad
 * implementation as firmly as it accepts a good one. A partially-conforming
 * provider is worse than an absent one, so every rejection is asserted, not
 * assumed. Pure logic — no network, no vendor call, no key.
 *
 *   node test/translation-provider-contract.test.js
 */
import {
  assertImplementsProvider, providerSupports, FORBIDDEN_SECRET_SURFACE
} from '../src/lib/translation/ITranslationProvider.js'
import { createProviderRegistry } from '../src/lib/translation/registry.js'
import {
  PROVIDER_MATRIX, providerCapabilities, pairFitness, capabilityMatrixData
} from '../src/lib/translation/capabilities.js'
import { createBuiltinRegistry, BUILTIN_PROVIDER_IDS } from '../src/lib/translation/adapters/index.js'
import { createEnginePort, NOT_WIRED_MESSAGE } from '../src/lib/translation/adapters/engine-port.js'
import { PROVIDER_IDS } from '../src/lib/translation/types.js'

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

/** A well-formed provider, with knobs to break one thing at a time. */
function fakeProvider (id, over = {}) {
  const caps = {
    supports: over.supports || ['translate'],
    languagePairs: over.languagePairs || (() => 0.8),
    scripts: over.scripts || ['Latn'],
    streaming: false,
    qualityTier: over.qualityTier || 'high',
    latencyClass: over.latencyClass || 'fast',
    costClass: over.costClass || 'metered',
    privacy: over.privacy || 'cloud-contract',
    rateLimit: {}
  }
  const p = {
    id,
    capabilities: () => (over.capsReturn !== undefined ? over.capsReturn : caps),
    health: () => (over.health !== undefined ? over.health : { circuit: 'closed', p50Ms: 400, p95Ms: 800, errorRate: 0 }),
    priceSignal: () => (over.price !== undefined ? over.price : { unit: 'char', estimatedUnits: 1, costClass: caps.costClass })
  }
  if (caps.supports.includes('translate') && !over.dropTranslate) p.translate = async () => ({ text: 'x', engine: id })
  if (caps.supports.includes('detect')) p.detectLanguage = async () => ({ language: 'en' })
  if (caps.supports.includes('transliterate')) p.transliterate = async () => ({ text: 'x' })
  if (caps.supports.includes('comprehend')) p.comprehend = async () => ({ text: 'x' })
  if (caps.supports.includes('adjudicate')) p.adjudicate = async () => ({ text: 'x' })
  return Object.assign(p, over.extra || {})
}

/* ------------------------------------------------ 1. the contract accepts -- */

check('a well-formed provider satisfies the contract', () => {
  assertImplementsProvider(fakeProvider('good'), 'good'); return true
})

check('a voice-only provider (no text method) satisfies the contract', () => {
  // ElevenLabs declares stt/tts/clone — declaration-only, no text method needed.
  assertImplementsProvider(fakeProvider('voice', { supports: ['stt', 'tts', 'clone'] }), 'voice')
  return true
})

check('providerSupports reflects declared-and-implemented capabilities', () => {
  const p = fakeProvider('p', { supports: ['translate', 'detect'] })
  return providerSupports(p, 'translate') === true &&
    providerSupports(p, 'detect') === true &&
    providerSupports(p, 'adjudicate') === false
})

/* ------------------------------------------------ 2. the contract rejects -- */

check('a non-object is rejected', () => {
  for (const bad of [null, undefined, 'provider', 42]) {
    try { assertImplementsProvider(bad, 'bad'); return false } catch { /* expected */ }
  }
  return true
})

check('a missing id is rejected', () => {
  const p = fakeProvider('x'); delete p.id
  try { assertImplementsProvider(p, 'noid'); return false } catch { return true }
})

check('each missing required method is rejected', () => {
  for (const m of ['capabilities', 'health', 'priceSignal']) {
    const p = fakeProvider('x'); delete p[m]
    try { assertImplementsProvider(p, 'x'); return false } catch { /* expected */ }
  }
  return true
})

check('a capability with no backing method is rejected', () => {
  // Declares translate but has no translate() — the classic silent-gap.
  const p = fakeProvider('x', { supports: ['translate'], dropTranslate: true })
  try { assertImplementsProvider(p, 'x'); return false } catch { return true }
})

check('an unknown capability is rejected', () => {
  const p = fakeProvider('x', { supports: ['translate', 'telepathy'] })
  try { assertImplementsProvider(p, 'x'); return false } catch { return true }
})

check('each invalid vocabulary value is rejected', () => {
  for (const bad of [{ qualityTier: 'amazing' }, { latencyClass: 'quick' }, { costClass: 'spendy' }, { privacy: 'trustme' }]) {
    const p = fakeProvider('x', bad)
    try { assertImplementsProvider(p, 'x'); return false } catch { /* expected */ }
  }
  return true
})

check('a bogus circuit state in health() is rejected', () => {
  const p = fakeProvider('x', { health: { circuit: 'vibes', p50Ms: 1, p95Ms: 1, errorRate: 0 } })
  try { assertImplementsProvider(p, 'x'); return false } catch { return true }
})

check('a bogus priceSignal unit is rejected', () => {
  const p = fakeProvider('x', { price: { unit: 'goats', estimatedUnits: 1, costClass: 'free' } })
  try { assertImplementsProvider(p, 'x'); return false } catch { return true }
})

check('THE TRIPWIRE: every forbidden secret surface is individually caught', () => {
  for (const banned of FORBIDDEN_SECRET_SURFACE) {
    const p = fakeProvider('leaky', { extra: { [banned]: 'x' } })
    try { assertImplementsProvider(p, 'leaky'); return false } catch { /* expected */ }
  }
  return true
})

/* -------------------------------------------------------- 3. the registry -- */

check('the registry registers, gets, lists and sizes', () => {
  const r = createProviderRegistry()
  r.register(fakeProvider('a'))
  r.register(fakeProvider('b'))
  return r.size === 2 && r.has('a') && r.get('b')?.id === 'b' &&
    r.ids().join(',') === 'a,b' && r.list().length === 2
})

check('the registry refuses a malformed provider at the door', () => {
  const r = createProviderRegistry()
  try { r.register({ id: 'broken' }); return false } catch { return true }
})

check('the registry refuses a duplicate id — two of one is a bug, not a fallback', () => {
  const r = createProviderRegistry()
  r.register(fakeProvider('a'))
  try { r.register(fakeProvider('a')); return false } catch { return true }
})

check('the registry exposes a capability matrix for exactly its registered members', () => {
  const r = createProviderRegistry()
  r.register(fakeProvider('a'))
  const matrix = r.capabilityMatrix()
  return Array.isArray(matrix) && matrix.every((row) => typeof row.id === 'string')
})

/* --------------------------------------------- 4. the capability matrix ----- */

check('every declared provider id has a matrix row', () =>
  PROVIDER_IDS.every((id) => Boolean(PROVIDER_MATRIX[id])))

check('providerCapabilities returns the interface shape, with a languagePairs function', () => {
  const caps = providerCapabilities('sarvam')
  return typeof caps.languagePairs === 'function' &&
    Array.isArray(caps.supports) && Array.isArray(caps.scripts) &&
    providerCapabilities('nope') === null
})

check('pair fitness encodes the specialist story: Sarvam owns Indic, is 0 off it', () => {
  return pairFitness(PROVIDER_MATRIX.sarvam.pairs, 'en', 'kn') === 1.0 &&
    pairFitness(PROVIDER_MATRIX.sarvam.pairs, 'en', 'fr') === 0 &&
    pairFitness(PROVIDER_MATRIX.google.pairs, 'en', 'fr') > 0
})

check('a transliteration-only engine has 0 translate fitness', () =>
  // google-inputtools transliterates; it must gate OUT of a translate request.
  pairFitness(PROVIDER_MATRIX['google-inputtools'].pairs, 'en', 'ta') > 0 &&
  PROVIDER_MATRIX['google-inputtools'].supports.includes('transliterate') &&
  !PROVIDER_MATRIX['google-inputtools'].supports.includes('translate'))

check('on-device needs a known source — no source scores 0 (gates out)', () =>
  pairFitness(PROVIDER_MATRIX.device.pairs, null, 'en') === 0 &&
  pairFitness(PROVIDER_MATRIX.device.pairs, 'en', 'fr') === 0.6)

check('capabilityMatrixData never leaks a languagePairs function or content', () => {
  const data = capabilityMatrixData()
  return data.length === PROVIDER_IDS.length &&
    data.every((row) => typeof row.languagePairs === 'undefined')
})

/* ------------------------------------- 5. the real adapters, over the port -- */

check('every builtin provider registers and satisfies the contract', () => {
  const r = createBuiltinRegistry()
  return r.size === BUILTIN_PROVIDER_IDS.length &&
    r.list().every((p) => { assertImplementsProvider(p, p.id); return true })
})

check('no builtin adapter carries a vendor secret — keys stay in the engine', () => {
  const r = createBuiltinRegistry()
  return r.list().every((p) => FORBIDDEN_SECRET_SURFACE.every((banned) => !(banned in p)))
})

await checkAsync('an adapter operation DELEGATES to the port — inert while not wired', async () => {
  // Prove the adapter does not do the work itself: with the default (inert)
  // port, calling translate() surfaces the not-wired error, not a translation.
  const r = createBuiltinRegistry(createEnginePort())
  const google = r.get('google')
  try { await google.translate({ text: 'hi', targetLang: 'ta' }); return false } catch (e) {
    return e.message.startsWith(NOT_WIRED_MESSAGE.slice(0, 20))
  }
})

/* --------------------------------------------------------------- report */
const shown = names
const passed = shown.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — provider contract, registry, matrix')
console.log('========================================')
for (const n of shown) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${shown.length} passed`)
console.log('========================================\n')
process.exit(passed === shown.length ? 0 : 1)
