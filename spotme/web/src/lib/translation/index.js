/**
 * Spot Me — the V2 translation platform, assembled. DEFAULT OFF, NOT WIRED IN.
 *
 * `buildTranslationPlatform()` composes the pieces — registry, circuit breakers,
 * quality store, router, cache, cost governor, metrics, and the execution
 * pipeline — into one object over the provider adapters and the engine port.
 * Building it is pure and free: no network, no vendor key, no mutation of the
 * live translate path. The app imports the ENTRY surface (integration.js), never
 * the live engine's guts; the not-shipped fence proves the live path is untouched.
 *
 * THE GATE HAS THREE LEVELS:
 *   decide(req)   — a pure routing DECISION. Safe while OFF (no side effects, no
 *                   network) — the design's "shadow routing" rollout step 1.
 *   execute(req)  — walks the routed chain; reaches the engine, so REFUSED while
 *                   the flag is OFF.
 *   run(req,opts) — the full pipeline (cache→context→route→execute→verify→cost→
 *                   metrics); also REFUSED while OFF. There is no path to a vendor
 *                   call from a disabled platform.
 *
 * The structural guarantee (no app importer of the engine internals) is the real
 * fence; the flag is the eventual on-switch. Both must move, deliberately, before
 * a single request routes through here.
 */
import { isPlatformV2Enabled, translationFlagSnapshot } from './flag.js'
import { createProviderRegistry } from './registry.js'
import { createBreakerRegistry } from './circuit-breaker.js'
import { createQualityStore } from './confidence.js'
import { createRouter } from './router.js'
import { createEnginePort } from './adapters/engine-port.js'
import { registerBuiltinProviders } from './adapters/index.js'
import { createTranslationCache } from './cache.js'
import { createCostGovernor } from './cost.js'
import { createMetrics, readiness as computeReadiness } from './metrics.js'
import { createPipeline } from './pipeline.js'

/**
 * Assemble the platform. All inputs are injectable so the suite can drive it
 * deterministically; with no inputs it builds the real (inert) configuration and
 * reports `enabled` from the master flag.
 *
 * @param {{
 *   enabled?: boolean, registry?: object, breakers?: object, quality?: object,
 *   port?: object, engineDelegate?: object|null, policy?: object,
 *   policyVersion?: string, only?: string[], now?: () => number, circuit?: object,
 *   flags?: object, cache?: object, cost?: object, metrics?: object,
 *   cacheOptions?: object, costLimits?: object, retry?: object
 * }} [opts]
 */
export function buildTranslationPlatform (opts = {}) {
  const enabled = opts.enabled != null ? Boolean(opts.enabled) : isPlatformV2Enabled()
  const flags = opts.flags || translationFlagSnapshot()

  const breakers = opts.breakers || createBreakerRegistry(opts.circuit || {})
  const quality = opts.quality || createQualityStore()
  const port = opts.port || createEnginePort(opts.engineDelegate || null)

  const registry = opts.registry || createProviderRegistry()
  if (!opts.registry) registerBuiltinProviders(registry, port, { breakers, only: opts.only })

  const policy = {
    profile: 'accuracy',
    // OFF reproduces today's behaviour; policyVersion is the rollback unit
    // (design §17.5). "rt-off" while disabled makes the state legible.
    policyVersion: enabled ? (opts.policyVersion || 'rt-2026.08.1') : 'rt-off',
    ...(opts.policy || {})
  }
  const router = createRouter({ registry, breakers, quality, policy, now: opts.now })

  // The completed-platform collaborators. Pure, in-memory, and inert while OFF.
  const cache = opts.cache || createTranslationCache({ ...(opts.cacheOptions || {}), engineVersion: policy.policyVersion, now: opts.now })
  const cost = opts.cost || createCostGovernor({ limits: opts.costLimits, now: opts.now })
  const metrics = opts.metrics || createMetrics()

  const pipeline = createPipeline({
    registry, breakers, quality, policy, cache, cost, metrics,
    flags, retry: opts.retry, now: opts.now
  })

  function ensureEnabled (what) {
    if (!enabled) {
      throw new Error(`translation V2 is disabled — ${what} refused (flag OFF)`)
    }
  }

  return {
    enabled,
    flags,
    registry,
    breakers,
    quality,
    router,
    policy,
    cache,
    cost,
    metrics,
    pipeline,
    /** Pure decision — allowed while OFF (shadow routing). */
    decide: (req) => router.route(req),
    /** Chain walk — reaches the engine, so refused while OFF. */
    execute: (req) => { ensureEnabled('execute'); return router.execute(req) },
    /** Full pipeline — refused while OFF; the enabled entry path. */
    run: (req, o) => { ensureEnabled('run'); return pipeline.translate(req, o) },
    /** Readiness/health — safe to call anytime; no secrets, no content. */
    readiness: () => computeReadiness({ registry, breakers, flags, cache, cost, metrics })
  }
}

// Re-export the flags so a would-be integration checks them from one place.
export {
  isTranslationV2Enabled, isPlatformV2Enabled, translationFlagSnapshot,
  isDynamicRoutingEnabled, isCrossVerifyEnabled, isAdjudicationEnabled,
  isCacheEnabled, isCostGovernanceEnabled, TRANSLATION_V2_FLAG,
  TRANSLATION_PLATFORM_V2_FLAG, TRANSLATION_SUBFLAGS
} from './flag.js'
