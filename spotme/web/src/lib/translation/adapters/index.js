/**
 * Spot Me — register the shipped engine's providers as adapters.
 *
 * This is the one place that turns `api/translate.js`'s eight vendors into
 * registrations the router can score. Every id here has a row in the §4 matrix
 * and a thin adapter (providers.js) that delegates to the engine port. Nothing
 * is wired to the live engine unless a delegate is passed in — the default port
 * is inert (engine-port.js), so calling `registerBuiltinProviders` never spends
 * a vendor call.
 */
import { createProviderRegistry } from '../registry.js'
import { createEnginePort } from './engine-port.js'
import { createEngineProvider } from './providers.js'

/**
 * The providers the engine already speaks to (design §4). The task's named six
 * — openai, gemini, azure, sarvam, google, elevenlabs — plus the rest of the
 * incumbent stack the engine uses today.
 */
export const BUILTIN_PROVIDER_IDS = Object.freeze([
  'google', 'azure', 'sarvam', 'gemini', 'openai', 'anthropic',
  'google-inputtools', 'elevenlabs', 'device', 'gtx', 'mymemory'
])

/**
 * Register the builtin providers into `registry`, wiring each to `port` and,
 * when given, its circuit breaker (so health snapshots reflect breaker state).
 *
 * @param {object} registry            a provider registry (registry.js)
 * @param {object} [port]              the engine port; defaults to the inert one
 * @param {{only?: string[], breakers?: object}} [opts]
 */
export function registerBuiltinProviders (registry, port = createEnginePort(), opts = {}) {
  const ids = opts.only || BUILTIN_PROVIDER_IDS
  for (const id of ids) {
    const breaker = opts.breakers ? opts.breakers.get(id) : null
    registry.register(createEngineProvider(id, port, { breaker }))
  }
  return registry
}

/**
 * Convenience: a fresh registry with every builtin provider registered against
 * the inert port. Used by the suite and by `buildTranslationPlatform`.
 */
export function createBuiltinRegistry (port = createEnginePort(), opts = {}) {
  return registerBuiltinProviders(createProviderRegistry(), port, opts)
}
