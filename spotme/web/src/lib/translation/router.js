/**
 * Spot Me — the routing engine (design §5).
 *
 * This replaces the hardcoded engine ordering in `handler()` with a scored
 * table. It does two separable things:
 *
 *   route(request)   — a pure DECISION. Apply the hard gates, score whoever
 *                      survives, and return a RoutingDecision: who was chosen,
 *                      the fallback chain, and — legibly — who was gated out and
 *                      why. No provider is called. This is what shadow-routing
 *                      and the admin surface read, and what the suite asserts.
 *
 *   execute(request) — WALK that decision. Call the chosen provider, then the
 *                      chain on failure/timeout/wrong-script, driving each
 *                      provider's circuit breaker. Returns the result plus the
 *                      decision annotated with what actually happened.
 *
 * THE HARD GATES, IN THE DESIGN'S ORDER (§5.1). Any failure excludes a provider
 * from candidacy — it cannot be scored back in:
 *   G_supports  provider declares the required capability
 *   G_pair      languagePairs(src,tgt) > 0
 *   G_circuit   breaker not OPEN
 *   G_allow     provider in the tenant's allow-list
 *   G_privacy   tenant policy admits the provider's privacy posture
 *
 * NO NETWORK IN route(). Given the same registry, breakers, quality and policy,
 * route() is a deterministic fixture — the property the whole abstraction is
 * for. execute() only reaches a network if the registered providers do; with
 * the fake providers the suite injects, it stays offline.
 */
import { CAPABILITY_METHOD, ROUTING_PROFILES, pairKey } from './types.js'
import { providerSupports } from './ITranslationProvider.js'
import { score } from './scoring.js'
import { scriptOk } from './detect.js'

/** Capabilities whose output is text and must pass the wrong-script gate. */
const SCRIPT_CHECKED = new Set(['translate', 'transliterate', 'comprehend', 'adjudicate'])

/** Normalise a quality input (store with .get, or a plain function) to a fn. */
function asQualityFn (quality) {
  if (quality && typeof quality.get === 'function') {
    return (id, pair) => quality.get(id, pair)
  }
  if (typeof quality === 'function') return quality
  return () => undefined // scorer seeds when undefined
}

/**
 * Default privacy policy: an enterprise tenant (a request carrying a tenantId)
 * admits only contract providers — keyless vendors have no DPA (§12.3). A
 * consumer request (no tenantId) may reach the keyless last-resort tail.
 */
function defaultPrivacyPolicy (posture, tenantId) {
  if (tenantId) return posture !== 'cloud-keyless'
  return true
}

/** Is `id` allowed for `tenantId` under `allowList`? Missing list = allow all. */
function allowed (allowList, id, tenantId) {
  if (!allowList) return true
  if (typeof allowList === 'function') return allowList(id, tenantId) !== false
  if (allowList instanceof Set) return allowList.has(id)
  if (allowList instanceof Map) {
    if (tenantId == null) return true
    const set = allowList.get(tenantId)
    return set ? set.has(id) : true // no entry for a tenant = no restriction
  }
  return true
}

/**
 * Create a router. Everything it needs is injected, so it is a pure function of
 * its inputs and testable without a clock or a socket.
 *
 * @param {{registry: any, breakers?: any, quality?: any, policy?: any, now?: () => number}} deps
 */
export function createRouter (deps = {}) {
  const registry = deps.registry
  if (!registry) throw new Error('router: a registry is required')
  const breakers = deps.breakers || null
  const qualityFn = asQualityFn(deps.quality)
  const policy = deps.policy || {}
  const policyVersion = policy.policyVersion || 'rt-off'
  // Optional per-call wrapper (retry.js makeAttempt) so the pipeline can add a
  // bounded, transient-only retry to the primary route. Default is identity —
  // one call, exactly the behaviour every existing caller and test relies on.
  const attempt = typeof deps.attempt === 'function' ? deps.attempt : (fn) => fn()

  function circuitOf (id) {
    return breakers ? breakers.get(id) : null
  }

  /** The pure decision. */
  function route (request = {}) {
    const cap = request.requiredCapability || 'translate'
    const profile = ROUTING_PROFILES.includes(request.routingProfile)
      ? request.routingProfile
      : (ROUTING_PROFILES.includes(policy.profile) ? policy.profile : 'accuracy')
    const tenantId = request.tenantId ?? null
    const pair = pairKey(request.sourceLang, request.targetLang)
    const override = policy.pairOverrides ? policy.pairOverrides[pair] : null

    const gatedIn = []
    const gatedOut = []

    for (const provider of registry.list()) {
      const id = provider.id
      const caps = safeCaps(provider)

      // G_supports
      if (!providerSupports(provider, cap)) {
        gatedOut.push({ id, score: 0, gatedOut: `capability: no ${cap}` }); continue
      }
      // G_pair
      if (!caps || caps.languagePairs(request.sourceLang, request.targetLang) <= 0) {
        gatedOut.push({ id, score: 0, gatedOut: 'pair: unsupported' }); continue
      }
      // pairOverride deny
      if (override && Array.isArray(override.deny) && override.deny.includes(id)) {
        gatedOut.push({ id, score: 0, gatedOut: 'override: denied for pair' }); continue
      }
      // G_circuit
      const breaker = circuitOf(id)
      if (breaker && breaker.state() === 'open') {
        gatedOut.push({ id, score: 0, gatedOut: 'circuit: open' }); continue
      }
      // G_allow
      if (!allowed(policy.allowList, id, tenantId)) {
        gatedOut.push({ id, score: 0, gatedOut: 'allow: not in tenant list' }); continue
      }
      // G_privacy
      const privacyPolicy = policy.privacyPolicy || defaultPrivacyPolicy
      if (!privacyPolicy(caps.privacy, tenantId)) {
        gatedOut.push({ id, score: 0, gatedOut: `privacy: ${caps.privacy}` }); continue
      }

      const s = score(provider, request, { profile, quality: qualityFn(id, pair) })
      gatedIn.push({ id, score: s })
    }

    // Stable sort by score desc; registry order breaks ties (V8 sort is stable).
    gatedIn.sort((a, b) => b.score - a.score)

    // A pinned provider, if it survived the gates, is forced to the front.
    if (override && override.pin) {
      const idx = gatedIn.findIndex((c) => c.id === override.pin)
      if (idx > 0) {
        const [pinned] = gatedIn.splice(idx, 1)
        gatedIn.unshift(pinned)
      }
    }

    const chosen = gatedIn.length ? gatedIn[0].id : null
    const fallbackChain = gatedIn.slice(1).map((c) => c.id)

    return {
      profile,
      requiredCapability: cap,
      candidates: [...gatedIn, ...gatedOut],
      chosen,
      fallbackChain,      // the scored candidate list beyond the primary
      fallbacksTaken: [], // filled by execute() as the chain is walked
      verified: 'none',
      breakerTrips: [],
      policyVersion
    }
  }

  /**
   * Walk the decision. Calls the chosen provider, then the chain, driving the
   * circuit breakers. A wrong-script answer is a failure (the same gate the
   * engine's fallback loop applies), not a success — so it sheds the provider
   * and moves on rather than shipping unusable text.
   */
  async function execute (request = {}) {
    const decision = route(request)
    const method = CAPABILITY_METHOD[decision.requiredCapability]
    if (!method) {
      return { result: null, decision, error: new Error(`no method for ${decision.requiredCapability}`) }
    }

    const chain = decision.chosen ? [decision.chosen, ...decision.fallbackChain] : []
    let lastError = null

    for (const id of chain) {
      const provider = registry.get(id)
      if (!provider || typeof provider[method] !== 'function') continue
      const breaker = circuitOf(id)
      if (breaker && !breaker.canRequest()) { decision.fallbacksTaken.push(id); continue }

      const before = breaker ? breaker.state() : 'closed'
      try {
        const out = await attempt(() => provider[method](request), { id })
        const text = out && typeof out === 'object' ? out.text : out
        if (SCRIPT_CHECKED.has(decision.requiredCapability) &&
            text != null && !scriptOk(text, request.targetLang)) {
          lastError = new Error(`${id} answered in the wrong script for ${request.targetLang}`)
          if (breaker) { breaker.onFailure(); if (before !== 'open' && breaker.state() === 'open') decision.breakerTrips.push(id) }
          decision.fallbacksTaken.push(id)
          continue
        }
        if (breaker) breaker.onSuccess()
        if (id !== decision.chosen) decision.chosen = id // record who actually served
        decision.fallbacksTaken = decision.fallbacksTaken.filter((f) => f !== id)
        decision.verified = 'single'
        return { result: out, decision, error: null }
      } catch (err) {
        lastError = err
        if (breaker) { breaker.onFailure(); if (before !== 'open' && breaker.state() === 'open') decision.breakerTrips.push(id) }
        decision.fallbacksTaken.push(id)
      }
    }

    decision.verified = 'none'
    return { result: null, decision, error: lastError || new Error('all candidates exhausted') }
  }

  return { route, execute, policyVersion }
}

/** capabilities() that never throws — a broken provider is simply un-routable. */
function safeCaps (provider) {
  try { return provider.capabilities() } catch { return null }
}
