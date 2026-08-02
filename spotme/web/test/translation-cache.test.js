/**
 * The translation cache (design §11, §18-C1). A cache on a messaging app is a
 * loaded gun — the tests here are as much about what it MUST NOT do as what it
 * does. The load-bearing one is ISOLATION: a cache must never leak one user's
 * private context into another's result. Deterministic — `now` is injected so TTL
 * is asserted without sleeping.
 *
 *   node test/translation-cache.test.js
 */
import {
  canonicalKey, createTranslationCache, CACHE_DEFAULTS, hash64
} from '../src/lib/translation/cache.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/* ----------------------------------------------------- 1. the canonical key */

check('the key folds in lang pair, version, privacy mode and context fingerprint', () => {
  const a = canonicalKey({ sourceLang: 'ta', targetLang: 'en', text: 'x', engineVersion: 'v1', privacyMode: 'standard', contextFingerprint: 'c1' })
  const b = canonicalKey({ sourceLang: 'ta', targetLang: 'en', text: 'x', engineVersion: 'v1', privacyMode: 'standard', contextFingerprint: 'c1' })
  return typeof a === 'string' && a.length === 16 && a === b // deterministic
})

check('a different privacy mode yields a different key (no cross-mode reuse)', () => {
  const base = { sourceLang: 'ta', targetLang: 'en', text: 'x', engineVersion: 'v1', contextFingerprint: 'c1' }
  return canonicalKey({ ...base, privacyMode: 'standard' }) !== canonicalKey({ ...base, privacyMode: 'strict' })
})

check('a different context fingerprint yields a different key', () => {
  const base = { sourceLang: 'ta', targetLang: 'en', text: 'x', engineVersion: 'v1', privacyMode: 'standard' }
  return canonicalKey({ ...base, contextFingerprint: 'A' }) !== canonicalKey({ ...base, contextFingerprint: 'B' })
})

check('concatenation cannot collide two different field splits', () =>
  // "a|b","" vs "a","b|" style bugs — the control-char separator prevents them
  canonicalKey({ sourceLang: 'ab', targetLang: 'c', text: '', engineVersion: 'v', contextFingerprint: '', privacyMode: 'standard' }) !==
  canonicalKey({ sourceLang: 'a', targetLang: 'bc', text: '', engineVersion: 'v', contextFingerprint: '', privacyMode: 'standard' }))

check('hash64 is deterministic and bounded', () => {
  const first = hash64('hello')
  const second = hash64('hello')
  return first === second && hash64('a').length === 16 && hash64('a') !== hash64('b')
})

/* ------------------------------------------ 2. THE ISOLATION GUARANTEE ------ */

check('ISOLATION: one user\'s private-context result is unreachable from another\'s key', () => {
  const cache = createTranslationCache()
  // User A translates "varen" inside a private conversation (fingerprint ctxA).
  const keyA = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'varen' }, { privacyMode: 'standard', contextFingerprint: 'ctxA' })
  cache.set(keyA, { text: 'I will come (to YOUR place, per A\'s private thread)' })
  // User B translates the SAME word in a DIFFERENT conversation (ctxB).
  const keyB = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'varen' }, { privacyMode: 'standard', contextFingerprint: 'ctxB' })
  const bResult = cache.get(keyB)
  // B must NOT receive A's context-shaped answer. Different context → cache miss.
  return keyA !== keyB && bResult === null
})

check('ISOLATION: a strict-mode result never satisfies a standard-mode lookup', () => {
  const cache = createTranslationCache()
  const strictKey = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'x' }, { privacyMode: 'strict', contextFingerprint: 'c' })
  cache.set(strictKey, { text: 'on-device only answer' })
  const standardKey = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'x' }, { privacyMode: 'standard', contextFingerprint: 'c' })
  return cache.get(standardKey) === null
})

check('the same request in the same context DOES hit (isolation is not paranoia)', () => {
  const cache = createTranslationCache()
  const env = { privacyMode: 'standard', contextFingerprint: 'same' }
  const k1 = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'x' }, env)
  cache.set(k1, { text: 'answer' })
  const k2 = cache.keyFor({ sourceLang: 'ta', targetLang: 'en', text: 'x' }, env)
  return cache.get(k2)?.value.text === 'answer'
})

/* -------------------------------------------------------- 3. TTL + version - */

check('an entry expires after its TTL (injected clock)', () => {
  let t = 1000
  const cache = createTranslationCache({ ttlMs: 500, now: () => t })
  const k = cache.keyFor({ targetLang: 'en', text: 'x' }, {})
  cache.set(k, { text: 'a' })
  const fresh = cache.get(k)
  t = 1600 // 600ms later, past the 500ms TTL
  const stale = cache.get(k)
  return fresh?.value.text === 'a' && stale === null
})

check('a version change invalidates every entry stamped with the old version', () => {
  const cache = createTranslationCache({ engineVersion: 'v1' })
  const k = cache.keyFor({ targetLang: 'en', text: 'x' }, {})
  cache.set(k, { text: 'v1 answer' })
  const dropped = cache.invalidateVersion('v2')
  return dropped === 1 && cache.get(k) === null && cache.version === 'v2'
})

/* ------------------------------------------------ 4. safe negative caching - */

check('a safe negative caches with a REQUIRED reason and hits as negative', () => {
  const cache = createTranslationCache()
  const k = cache.keyFor({ sourceLang: 'en', targetLang: 'en', text: 'hello' }, {})
  const stored = cache.setNegative(k, 'same-language no-op')
  const noReason = cache.setNegative('k2', '')
  const hit = cache.get(k)
  return stored === true && noReason === false && hit?.negative === true && hit.reason === 'same-language no-op'
})

check('the cache REFUSES to store an uncertain verdict as an answer', () => {
  const cache = createTranslationCache()
  const k = cache.keyFor({ targetLang: 'en', text: 'x' }, {})
  const stored = cache.set(k, { text: 'maybe', uncertain: true })
  return stored === false && cache.get(k) === null
})

/* ----------------------------------------------------- 5. bounded storage -- */

check('the cache is bounded and evicts the oldest (LRU)', () => {
  const cache = createTranslationCache({ max: 3 })
  for (let i = 0; i < 3; i++) cache.set(cache.keyFor({ targetLang: 'en', text: `t${i}` }, {}), { text: `r${i}` })
  // touch t0 so it is most-recently-used, then overflow
  cache.get(cache.keyFor({ targetLang: 'en', text: 't0' }, {}))
  cache.set(cache.keyFor({ targetLang: 'en', text: 't3' }, {}), { text: 'r3' })
  const t0 = cache.get(cache.keyFor({ targetLang: 'en', text: 't0' }, {}))
  const t1 = cache.get(cache.keyFor({ targetLang: 'en', text: 't1' }, {}))
  // t1 was the least-recently-used → evicted; t0 survived because it was touched
  return cache.size === 3 && t0 !== null && t1 === null
})

check('the snapshot reports a hit rate and counters, no content', () => {
  const cache = createTranslationCache()
  const k = cache.keyFor({ targetLang: 'en', text: 'x' }, {})
  cache.set(k, { text: 'a' })
  cache.get(k) // hit
  cache.get(cache.keyFor({ targetLang: 'en', text: 'y' }, {})) // miss
  const s = cache.snapshot()
  return s.hits === 1 && s.misses === 1 && s.hitRate === 0.5 && CACHE_DEFAULTS.max > 0
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — cache: key, isolation, TTL, negatives, bounds')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
