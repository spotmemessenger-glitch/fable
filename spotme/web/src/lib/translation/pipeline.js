/**
 * Spot Me — the enabled execution pipeline (design §5–§14, assembled). This is
 * the path a request takes ONCE the platform is on: it threads the request
 * through cache → context → routing → execution → cross-verification → cost →
 * metrics, each stage gated by its own layered flag so the platform can be turned
 * up one capability at a time (routing before verification before adjudication).
 *
 * ORDER IS DELIBERATE and matches the design's cost discipline:
 *   1. CONTEXT      bound the window, derive the privacy mode + cache fingerprint
 *   2. CACHE-FIRST  a hit answers with no call, no latency, no spend
 *   3. ROUTE        a pure decision (who, and the fallback chain) — no network
 *   4. COST GATE    estimate the chosen provider BEFORE calling; refuse if over
 *   5. EXECUTE      the primary + fallback chain, with bounded retry (retry.js)
 *   6. VERIFY       optional second opinion → consensus → optional judge
 *   7. RECORD       actual spend, metrics, and (if certain) the cache
 *
 * The privacy MODE is applied by building a fresh router per request with a
 * mode-derived privacy gate — routers are pure and cheap, so this needs no shared
 * mutable state and no edit to the router's own policy. NOTHING here calls a
 * vendor by itself; it drives the registered providers, inert until wired.
 */
import { createRouter } from './router.js'
import { buildContext } from './context.js'
import { normalizeMode, privacyPolicyForMode, privacyNotice } from './privacy.js'
import { resolve, outcomeConfidence, uncertainResult } from './verify.js'
import { makeAttempt } from './retry.js'
import { CAPABILITY_METHOD, pairKey } from './types.js'

const DEFAULT_FLAGS = Object.freeze({
  dynamicRouting: false, crossVerify: false, adjudication: false, cache: false, costGovernance: false
})

/**
 * Create the pipeline. Collaborators are injected so the whole thing is a pure
 * function of its inputs; `flags` is a plain booleans object (the integration
 * layer passes a live snapshot; a test passes exactly what it wants to exercise).
 *
 * @param {{ registry, breakers?, quality?, policy?, cache?, cost?, metrics?,
 *           retry?: object, flags?: object, now?: () => number }} deps
 */
export function createPipeline (deps = {}) {
  if (!deps.registry) throw new Error('pipeline: a registry is required')
  const { registry } = deps
  const breakers = deps.breakers || null
  const quality = deps.quality || null
  const basePolicy = deps.policy || {}
  const cache = deps.cache || null
  const cost = deps.cost || null
  const metrics = deps.metrics || null
  const now = typeof deps.now === 'function' ? deps.now : Date.now
  const flags = { ...DEFAULT_FLAGS, ...(deps.flags || {}) }
  // Bounded transient-retry on the primary route, only when a policy is supplied.
  const attempt = deps.retry ? makeAttempt(deps.retry, { sleep: deps.sleep }) : undefined

  const accountOf = (req) => String(req.accountId || req.tenantId || 'anonymous')

  /** Build a router for THIS request: mode-derived privacy gate, flag-shaped. */
  function routerFor (privacyMode) {
    const policy = {
      ...basePolicy,
      // dynamic routing OFF → pin the accuracy profile (the frozen, legacy-like
      // order); ON → honour the request's routingProfile.
      profile: flags.dynamicRouting ? (basePolicy.profile || 'accuracy') : 'accuracy',
      privacyPolicy: privacyPolicyForMode(privacyMode)
    }
    return createRouter({
      registry,
      breakers,
      // dynamic routing OFF → ignore the quality feedback term (constant seed),
      // so the order does not drift with history — a static, predictable route.
      quality: flags.dynamicRouting ? quality : null,
      policy,
      attempt
    })
  }

  /** Call one provider's capability method directly (the cross-verify leg). */
  async function callProvider (id, method, request) {
    const provider = registry.get(id)
    if (!provider || typeof provider[method] !== 'function') return null
    const breaker = breakers ? breakers.get(id) : null
    if (breaker && !breaker.canRequest()) return null
    try {
      const out = await provider[method](request)
      if (breaker) breaker.onSuccess()
      const text = out && typeof out === 'object' ? out.text : out
      return { text: String(text ?? ''), engine: (out && out.engine) || id, provider: id }
    } catch {
      if (breaker) breaker.onFailure()
      return null
    }
  }

  /**
   * Translate one request through the enabled pipeline. `opts` may carry a
   * context `window` (createContextWindow), a `glossary`, per-conversation
   * `prefs`, and an `adjudicator` provider. Always returns a result carrying a
   * DERIVED confidence + band, `cacheHit`, `latencyMs`, and — when nothing met
   * the threshold — `uncertain: true` with the reason.
   */
  async function translate (request = {}, opts = {}) {
    const t0 = now()
    const cap = request.requiredCapability || 'translate'
    const method = CAPABILITY_METHOD[cap] || 'translate'
    const target = request.targetLang
    const pair = pairKey(request.sourceLang, target)
    const account = accountOf(request)
    const routeProfile = flags.dynamicRouting ? request.routingProfile : undefined

    // 1. CONTEXT — bounded window → privacy mode + cache fingerprint.
    const context = opts.context ||
      (opts.window ? buildContext(request.text, opts.window, opts) : null)
    const privacyMode = normalizeMode(context?.privacyMode || request.privacyMode)
    const contextFingerprint = context?.fingerprint || `none|${privacyMode}`
    const effective = { ...request, privacyMode, routingProfile: routeProfile }
    const router = routerFor(privacyMode)

    const meta = { cacheHit: false, fallbacks: 0, breakerTrips: 0, wrongScript: 0, adjudicated: false, retries: 0, estimatedMicroUsd: 0 }

    // 2. CACHE-FIRST.
    let cacheKey = null
    if (cache && flags.cache) {
      cacheKey = cache.keyFor(request, { privacyMode, contextFingerprint })
      const hit = cache.get(cacheKey)
      if (hit && !hit.negative) {
        return finish({ ...hit.value, cacheHit: true }, { ...meta, cacheHit: true }, pair, t0)
      }
      if (hit && hit.negative) {
        return finish({ text: request.text, engine: null, note: hit.reason }, { ...meta, cacheHit: true }, pair, t0)
      }
    }

    // 3. ROUTE — a pure decision.
    const decision = router.route(effective)
    if (!decision.chosen) {
      return finish(uncertainResult('no eligible provider for this request'), meta, pair, t0)
    }

    // 4. COST GATE — estimate the chosen provider before spending.
    if (cost && flags.costGovernance) {
      const est = cost.estimate(registry.get(decision.chosen), request)
      meta.estimatedMicroUsd = est
      const verdict = cost.check(account, est)
      if (!verdict.allowed) {
        return finish(uncertainResult(`cost ceiling: ${verdict.reason}`, null, { blocked: true }), meta, pair, t0)
      }
      meta.softWarning = verdict.softWarning
    }

    // 5. EXECUTE — primary + fallback chain (router applies scriptOk + breakers).
    const primary = await router.execute(effective)
    meta.fallbacks = primary.decision.fallbacksTaken.length
    meta.breakerTrips = primary.decision.breakerTrips.length
    const primaryResult = primary.result
      ? { text: primary.result.text, engine: primary.result.engine || primary.decision.chosen, provider: primary.decision.chosen }
      : null
    if (cost && flags.costGovernance && primaryResult) {
      cost.record(account, meta.estimatedMicroUsd, { estimate: meta.estimatedMicroUsd })
    }

    // 6. VERIFY — optional second opinion → consensus → optional judge.
    let final
    if (flags.crossVerify && primaryResult) {
      const secondId = pickSecond(decision, primary.decision.chosen, method)
      const second = secondId ? await callProvider(secondId, method, effective) : null
      if (cost && flags.costGovernance && second) cost.record(account, cost.estimate(registry.get(secondId), request))
      const candidates = [primaryResult, second].filter(Boolean)
      final = await resolve(candidates, target, {
        original: request.text,
        allowAdjudication: flags.adjudication,
        adjudicator: opts.adjudicator || firstAdjudicator(decision),
        onFanout: (reason) => fanoutPermitted(account, reason)
      })
      if (final.verified === 'adjudicated') meta.adjudicated = true
      if (final.wrongScript) meta.wrongScript = final.wrongScript
    } else if (primaryResult) {
      const conf = outcomeConfidence('single')
      final = { text: primaryResult.text, provider: primaryResult.provider, ...conf, uncertain: false }
    } else {
      final = uncertainResult('all providers failed', null)
    }

    // 7. RECORD — quality feedback, cache (if certain), metrics.
    if (quality && final && !final.uncertain && final.provider) {
      const sig = final.verified === 'agree' ? 'agree' : final.verified === 'adjudicated' ? 'adjudicationWin' : null
      if (sig) quality.record(String(final.provider).split(/[+/]/)[0], pair, sig)
    }
    if (cache && flags.cache && cacheKey && final && !final.uncertain && final.text) {
      cache.set(cacheKey, { text: final.text, engine: final.provider, confidence: final.confidence, confidenceBand: final.confidenceBand, verified: final.verified })
    }
    return finish(final, meta, pair, t0)
  }

  /** Attach metrics + a privacy notice, record, and return the final result. */
  function finish (result, meta, pair, t0) {
    const latencyMs = now() - t0
    const out = {
      ...result,
      cacheHit: meta.cacheHit,
      latencyMs,
      privacyNotice: result.provider ? privacyNotice(postureOf(result.provider)) : undefined
    }
    if (metrics) {
      metrics.record({
        ok: !result.uncertain && result.text != null,
        provider: String(result.provider || '').split(/[+/]/)[0] || undefined,
        pair,
        latencyMs,
        confidence: result.confidence,
        confidenceBand: result.confidenceBand,
        fallbacks: meta.fallbacks,
        breakerTrips: meta.breakerTrips,
        wrongScript: meta.wrongScript,
        adjudicated: meta.adjudicated,
        uncertain: Boolean(result.uncertain),
        retries: meta.retries,
        cacheHit: meta.cacheHit,
        estimatedMicroUsd: meta.estimatedMicroUsd
      })
    }
    return out
  }

  /** The privacy posture of whichever provider actually served. */
  function postureOf (providerId) {
    const id = String(providerId || '').split(/[+/]/)[0]
    const p = registry.get(id)
    try { return p ? p.capabilities().privacy : 'cloud-keyless' } catch { return 'cloud-keyless' }
  }

  /** A cost-governed fan-out gate for adjudication (records the reason). */
  function fanoutPermitted (account, reason) {
    if (!(cost && flags.costGovernance)) return true // ungoverned: allowed, reasoned upstream
    return cost.fanout(account, reason).allowed
  }

  /** The first fallback that can serve `method` — the cross-verify second leg. */
  function pickSecond (decision, chosen, method) {
    for (const id of decision.fallbackChain) {
      if (id === chosen) continue
      const p = registry.get(id)
      if (p && typeof p[method] === 'function') return id
    }
    return null
  }

  /** The first candidate (chosen or fallback) that can adjudicate, if any. */
  function firstAdjudicator (decision) {
    const ids = [decision.chosen, ...decision.fallbackChain]
    for (const id of ids) {
      const p = registry.get(id)
      if (p && typeof p.adjudicate === 'function') return p
    }
    return null
  }

  return { translate, flags }
}
