/**
 * Spot Me — translation observability (design §14). The engine computes a great
 * deal it never records: which engine served, whether a fallback fired, whether a
 * wrong-script answer was shed, whether a judge was called. This module is the
 * sink for all of it — as AGGREGATES, never content. Every number here can be
 * exposed on a health surface without leaking a single message, a key, or a
 * user: it is counts, rates, and latency/confidence percentiles.
 *
 * WHAT IT TRACKS (the design §14 list): requests by provider and by language
 * pair; success/failure; latency percentiles; confidence + quality; fallback and
 * adjudication counts; cache hit rate; estimated cost; circuit state (read from
 * the breakers on demand); wrong-script rejections; and user-visible uncertainty.
 *
 * NO SECRETS, BY CONSTRUCTION. `record()` reads only aggregate-safe fields; there
 * is no field on a metrics event that can carry plaintext, and `readiness()`
 * returns booleans, counts and states — never a key, an endpoint, or a message.
 */

/** Keep the last N latency/confidence samples for percentile estimation. */
export const RESERVOIR = 2000

/** Percentiles from an unsorted sample array. Returns 0s for an empty set. */
export function percentiles (samples, ps = [0.5, 0.9, 0.95, 0.99]) {
  const s = [...samples].sort((a, b) => a - b)
  const out = {}
  for (const p of ps) {
    const key = `p${Math.round(p * 100)}`
    out[key] = s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0
  }
  out.n = s.length
  out.min = s.length ? s[0] : 0
  out.max = s.length ? s[s.length - 1] : 0
  out.mean = s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0
  return out
}

/** A bounded ring of numeric samples (keeps memory flat under load). */
function reservoir (cap = RESERVOIR) {
  const buf = []
  return {
    push (v) { if (Number.isFinite(v)) { buf.push(v); if (buf.length > cap) buf.shift() } },
    values () { return buf },
    get size () { return buf.length }
  }
}

const inc = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by)

/**
 * Create a metrics collector. Pure in-memory aggregation; the durable
 * TranslationRoutingEvent table (design §13) replaces the in-memory maps behind
 * this same `record()` shape, gated, when the DB work lands.
 */
export function createMetrics () {
  const counters = {
    requests: 0, success: 0, fail: 0, fallbacks: 0, adjudications: 0,
    wrongScriptRejections: 0, uncertain: 0, cacheHits: 0, cacheMisses: 0,
    breakerTrips: 0, retries: 0, estimatedMicroUsd: 0
  }
  const byProvider = new Map() // id -> count served
  const byPair = new Map() // "src|tgt" -> count
  const byBand = new Map() // confidence band -> count
  const latency = reservoir()
  const confidence = reservoir()

  return {
    /**
     * Record one completed translation. Every field is optional and
     * aggregate-safe; unknown fields are ignored, so a caller can never smuggle
     * content through. `provider`/`pair`/`band` are short codes, not text.
     */
    record (ev = {}) {
      counters.requests += 1
      if (ev.ok) counters.success += 1; else counters.fail += 1
      if (ev.provider) inc(byProvider, String(ev.provider))
      if (ev.pair) inc(byPair, String(ev.pair))
      if (Number.isFinite(ev.latencyMs)) latency.push(ev.latencyMs)
      if (Number.isFinite(ev.confidence)) confidence.push(ev.confidence)
      if (ev.confidenceBand) inc(byBand, String(ev.confidenceBand))
      counters.fallbacks += Number(ev.fallbacks || 0)
      counters.adjudications += ev.adjudicated ? 1 : 0
      counters.wrongScriptRejections += Number(ev.wrongScript || 0)
      counters.uncertain += ev.uncertain ? 1 : 0
      counters.breakerTrips += Number(ev.breakerTrips || 0)
      counters.retries += Number(ev.retries || 0)
      if (ev.cacheHit === true) counters.cacheHits += 1
      else if (ev.cacheHit === false) counters.cacheMisses += 1
      counters.estimatedMicroUsd += Number(ev.estimatedMicroUsd || 0)
      return this
    },

    /** A full aggregate snapshot — safe to expose; no content, no secrets. */
    snapshot () {
      const cacheTotal = counters.cacheHits + counters.cacheMisses
      return {
        ...counters,
        successRate: counters.requests ? counters.success / counters.requests : 0,
        uncertaintyRate: counters.requests ? counters.uncertain / counters.requests : 0,
        cacheHitRate: cacheTotal ? counters.cacheHits / cacheTotal : 0,
        latencyMs: percentiles(latency.values()),
        confidence: percentiles(confidence.values(), [0.5, 0.9]),
        byProvider: Object.fromEntries(byProvider),
        byPair: Object.fromEntries(byPair),
        byBand: Object.fromEntries(byBand)
      }
    },

    reset () {
      for (const k of Object.keys(counters)) counters[k] = 0
      byProvider.clear(); byPair.clear(); byBand.clear()
    }
  }
}

/**
 * A readiness/health view for a load balancer or an admin. Returns whether the
 * platform CAN serve a translate request right now, the flag state, provider and
 * capability counts, and each breaker's circuit — and NOTHING a secret could hide
 * in. `ready` is true when at least one provider can translate and not every such
 * provider's breaker is open.
 *
 * @param {{ registry?: object, breakers?: object, flags?: object, cache?: object,
 *           cost?: object, metrics?: object }} deps
 */
export function readiness (deps = {}) {
  const registry = deps.registry
  const breakers = deps.breakers
  const flags = deps.flags || {}

  const translators = registry ? registry.capableOf('translate') : []
  const circuits = breakers ? breakers.snapshot() : {}
  const openTranslators = translators.filter((id) => circuits[id]?.circuit === 'open')
  const ready = translators.length > 0 && openTranslators.length < translators.length

  return {
    ready,
    flags,
    providers: registry ? registry.size : 0,
    capable: registry
      ? {
          translate: registry.capableOf('translate'),
          detect: registry.capableOf('detect'),
          transliterate: registry.capableOf('transliterate'),
          adjudicate: registry.capableOf('adjudicate')
        }
      : {},
    circuits, // id -> {circuit, ...} — states only, no content
    cache: deps.cache ? deps.cache.snapshot() : null,
    cost: deps.cost ? deps.cost.snapshot() : null,
    metrics: deps.metrics ? deps.metrics.snapshot() : null
  }
}
