/**
 * Spot Me — the V2 translation platform, assembled. DEFAULT OFF, NOT WIRED IN.
 *
 * `buildTranslationPlatform()` composes the pieces — registry, circuit breakers,
 * quality store, router, and the provider adapters over the engine port — into
 * one object. Building it is pure and free: no network, no vendor key, no
 * mutation of the live translate path. Nothing in the app imports this file
 * (proved by `test/translation-v2-not-shipped.test.js`); it exists to be
 * exercised by the suite and to be the single on-ramp when the owner enables
 * the flag.
 *
 * THE GATE HAS TWO LEVELS:
 *   decide(req)   — a pure routing DECISION. Safe while OFF (no side effects,
 *                   no network) — this is exactly the design's "shadow routing"
 *                   rollout step 1: score, don't serve.
 *   execute(req)  — walks the chain and would reach the engine, so it is
 *                   REFUSED while the flag is OFF. There is no path to a vendor
 *                   call from a disabled platform.
 *
 * The structural guarantee (no importer in the app) is the real fence; the flag
 * is the eventual on-switch. Both must move, deliberately, before a single
 * request routes through here.
 */
import { isTranslationV2Enabled } from './flag.js'
import { createProviderRegistry } from './registry.js'
import { createBreakerRegistry } from './circuit-breaker.js'
import { createQualityStore } from './confidence.js'
import { createRouter } from './router.js'
import { createEnginePort } from './adapters/engine-port.js'
import { registerBuiltinProviders } from './adapters/index.js'

/**
 * Assemble the platform. All inputs are injectable so the suite can drive it
 * deterministically; with no inputs it builds the real (inert) configuration
 * and reports `enabled` from the flag.
 *
 * @param {{
 *   enabled?: boolean, registry?: object, breakers?: object, quality?: object,
 *   port?: object, engineDelegate?: object|null, policy?: object,
 *   policyVersion?: string, only?: string[], now?: () => number, circuit?: object
 * }} [opts]
 */
export function buildTranslationPlatform (opts = {}) {
  const enabled = opts.enabled != null ? Boolean(opts.enabled) : isTranslationV2Enabled()

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

  function ensureEnabled (what) {
    if (!enabled) {
      throw new Error(`translation V2 is disabled — ${what} refused (flag OFF)`)
    }
  }

  return {
    enabled,
    registry,
    breakers,
    quality,
    router,
    policy,
    /** Pure decision — allowed while OFF (shadow routing). */
    decide: (req) => router.route(req),
    /** Chain walk — reaches the engine, so refused while OFF. */
    execute: (req) => { ensureEnabled('execute'); return router.execute(req) }
  }
}

// Re-export the flag so a would-be integration checks it from one place.
export { isTranslationV2Enabled, TRANSLATION_V2_FLAG } from './flag.js'
