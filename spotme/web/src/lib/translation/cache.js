/**
 * Spot Me — the translation cache (design §11, §18-C1). A cache is the cheapest
 * possible provider: it answers with no call, no latency and no spend. But a
 * translation cache on a MESSAGING app is a loaded gun — cache the wrong thing
 * against the wrong key and you hand one user another user's private message.
 * So the whole design of this module is the KEY, and the one invariant it must
 * never break: a cache MUST NOT leak one user's private context into another's
 * result (proved by test/translation-cache.test.js).
 *
 * THE CANONICAL KEY folds in five things, and the two that matter most for safety
 * are the last two:
 *   engineVersion       — bust the cache when the engine/model changes
 *   sourceLang|targetLang
 *   text                — the exact input
 *   privacyMode         — a `strict` result is NEVER served to a `standard` call
 *   contextFingerprint  — two conversations with different context/glossary/
 *                         speakers hash differently, so A's context-shaped answer
 *                         is unreachable from B's key
 * The key is a hash, so no raw plaintext sits around as a Map key.
 *
 * SAFE NEGATIVE CACHING ONLY. The one negative it is safe to remember is a
 * deterministic no-op — same-language, nothing to translate. It NEVER caches an
 * error, a timeout, or an "uncertain" verdict as if it were an answer; those must
 * be re-tried, not pinned. IN MEMORY ONLY, bounded, and gated OFF by default —
 * the same posture `src/lib/translate.js` already takes for its own caches.
 */

/** Cache defaults. Short TTL — a translation can go stale when a model changes. */
export const CACHE_DEFAULTS = Object.freeze({
  ttlMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // bounded, same ceiling as the client's in-memory cache
  engineVersion: 'rt-2026.08.1'
})

/** A fast, deterministic, non-cryptographic hash (FNV-1a, two seeds → 64 bits). */
export function hash64 (str) {
  const s = String(str)
  let h1 = 0x811c9dc5
  let h2 = 0xc2b2ae35
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193)
    h2 = Math.imul(h2 ^ c, 0x85ebca6b)
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0')
  return hex(h1) + hex(h2)
}

const base = (c) => String(c || '').toLowerCase().split('-')[0]

/**
 * Build the canonical cache key. The field separator is a control char that
 * cannot appear in a language code, a mode, or a fingerprint, so no combination
 * of inputs can collide by concatenation (the classic "a|b" vs "a" + "|b" bug).
 * `text` is included verbatim in the hashed material — different text, different
 * key — but only the hash is returned, so plaintext is not exposed as a key.
 */
export function canonicalKey (parts = {}) {
  const sep = ''
  const material = [
    'v2',
    String(parts.engineVersion || CACHE_DEFAULTS.engineVersion),
    base(parts.sourceLang) || '*',
    base(parts.targetLang) || '*',
    String(parts.privacyMode || 'standard'),
    String(parts.contextFingerprint || 'none'),
    String(parts.text || '')
  ].join(sep)
  return hash64(material)
}

/** A sentinel a negative-cache entry carries so a hit is unambiguous. */
export const NEGATIVE = Object.freeze({ negative: true })

/**
 * Create a bounded, TTL'd, in-memory translation cache. LRU eviction uses Map
 * insertion order (delete-then-set on read/write moves an entry to the tail).
 * `now` is injected so expiry is testable without sleeping.
 */
export function createTranslationCache (opts = {}) {
  const cfg = { ...CACHE_DEFAULTS, ...opts }
  let engineVersion = cfg.engineVersion
  const now = typeof opts.now === 'function' ? opts.now : Date.now
  const store = new Map() // key -> { value, expiresAt, engineVersion, negative }
  const stats = { hits: 0, misses: 0, negativeHits: 0, evictions: 0, sets: 0, invalidations: 0 }

  function evictIfNeeded () {
    while (store.size > cfg.max) {
      const oldest = store.keys().next().value
      store.delete(oldest)
      stats.evictions += 1
    }
  }

  function alive (entry) {
    return entry && (entry.expiresAt === 0 || entry.expiresAt > now()) &&
      entry.engineVersion === engineVersion
  }

  return {
    /** Build a key from a request + context/privacy/version envelope. */
    keyFor (request = {}, env = {}) {
      return canonicalKey({
        engineVersion: env.engineVersion || engineVersion,
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        privacyMode: env.privacyMode || request.privacyMode,
        contextFingerprint: env.contextFingerprint,
        text: request.text
      })
    },

    /** Look up a key. Returns `{ value, negative }` or null on miss/expiry. */
    get (key) {
      const entry = store.get(key)
      if (!alive(entry)) {
        if (entry) store.delete(key) // reap the dead entry
        stats.misses += 1
        return null
      }
      // LRU touch: move to the tail.
      store.delete(key)
      store.set(key, entry)
      if (entry.negative) { stats.negativeHits += 1; return { value: null, negative: true, reason: entry.reason } }
      stats.hits += 1
      return { value: entry.value, negative: false }
    },

    /**
     * Store a POSITIVE result. Refuses to cache anything flagged uncertain — an
     * uncertain verdict is not an answer and must not be pinned. Returns true if
     * stored, false if refused.
     */
    set (key, value, meta = {}) {
      if (value == null) return false
      if (value && typeof value === 'object' && value.uncertain === true) return false
      store.delete(key)
      store.set(key, {
        value,
        negative: false,
        engineVersion,
        expiresAt: cfg.ttlMs > 0 ? now() + cfg.ttlMs : 0,
        ...(meta.tag ? { tag: meta.tag } : {})
      })
      stats.sets += 1
      evictIfNeeded()
      return true
    },

    /**
     * Store a SAFE negative — only ever a deterministic no-op (same-language,
     * nothing to translate). `reason` is required and recorded, so a negative can
     * never be an unexplained "we gave up".
     */
    setNegative (key, reason) {
      if (!reason || typeof reason !== 'string') return false
      store.delete(key)
      store.set(key, {
        value: null, negative: true, reason, engineVersion,
        expiresAt: cfg.ttlMs > 0 ? now() + cfg.ttlMs : 0
      })
      stats.sets += 1
      evictIfNeeded()
      return true
    },

    /**
     * Invalidate on a provider/model version change: adopt the new version and
     * drop every entry stamped with the old one. A cached translation from a
     * retired model is exactly the stale answer this busts.
     */
    invalidateVersion (newVersion) {
      if (newVersion && newVersion !== engineVersion) engineVersion = newVersion
      let dropped = 0
      for (const [k, entry] of store) {
        if (entry.engineVersion !== engineVersion) { store.delete(k); dropped += 1 }
      }
      stats.invalidations += 1
      return dropped
    },

    get version () { return engineVersion },
    get size () { return store.size },
    /** Hit-rate and counters for observability — never any content. */
    snapshot () {
      const total = stats.hits + stats.negativeHits + stats.misses
      return { ...stats, size: store.size, engineVersion, hitRate: total ? (stats.hits + stats.negativeHits) / total : 0 }
    },
    clear () { store.clear() }
  }
}
