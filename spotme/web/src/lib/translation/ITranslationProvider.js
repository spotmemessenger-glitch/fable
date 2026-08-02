/**
 * Spot Me — the translation provider contract, made checkable.
 *
 * Modelled on `src/lib/transport/ITransportAdapter.js`: JavaScript has no
 * interfaces, so the contract is a list of required methods, a list of members
 * that must NOT exist, and an assertion that runs in tests rather than a comment
 * nobody executes. Every adapter (OpenAI, Gemini, Azure, Sarvam, Google,
 * ElevenLabs) is validated against this before the registry will accept it.
 *
 * TWO HALVES, LIKE THE TRANSPORT CONTRACT:
 *  1. Shape — the operational methods every provider must answer (capabilities,
 *     health, priceSignal) plus the per-capability operations it declared.
 *  2. Prohibition — an adapter must carry NO vendor secret. Keys live in the
 *     serverless engine (`api/translate.js`, `_auth.js` rationale), and the
 *     adapters DELEGATE to it; a key surfacing on an adapter means someone
 *     duplicated the provider logic the design forbids. The prohibition is a
 *     test, not a paragraph — exactly the discipline `FORBIDDEN_KEY_SURFACE`
 *     encodes for transports.
 */
import {
  CAPABILITIES, CAPABILITY_METHOD, TEXT_CAPABILITIES, CIRCUIT_STATES,
  LATENCY_CLASSES, COST_CLASSES, QUALITY_TIERS, PRIVACY_POSTURES, isMember
} from './types.js'

/** Every provider must implement exactly these operational methods. */
export const PROVIDER_REQUIRED_METHODS = Object.freeze([
  'capabilities',  // () -> ProviderCapabilities   (the §4 row, as data)
  'health',        // () -> HealthSnapshot          (cheap, from rolling state)
  'priceSignal'    // (req) -> PriceSignal           (estimate BEFORE calling)
])

/** Operations a provider MAY implement — one per capability it declares. */
export const PROVIDER_OPTIONAL_METHODS = Object.freeze([
  'translate', 'detectLanguage', 'detectScript', 'transliterate',
  'comprehend', 'adjudicate'
])

/**
 * Members an adapter must NOT have — a duplicated-secret tripwire.
 *
 * The engine holds every vendor key and does every fenced prompt and every
 * vendor fetch; adapters are thin registrations that delegate to it. An adapter
 * that grew an `apiKey`, a `secret`, or its own `fetch`/`endpoint` is an adapter
 * that started re-implementing `api/translate.js` — the one thing the design's
 * "registration, not rewrite" rule forbids. Caught here, refused there.
 */
export const FORBIDDEN_SECRET_SURFACE = Object.freeze([
  'apiKey', 'secret', 'token', 'privateKey', 'credentials', 'endpoint', 'fetch'
])

/**
 * Throw unless `provider` satisfies the contract. Returns nothing and throws on
 * the first violation, deliberately: a partially conforming provider is worse
 * than an absent one because it fails later and further from the cause.
 */
export function assertImplementsProvider (provider, label = 'provider') {
  if (!provider || typeof provider !== 'object') {
    throw new Error(`${label}: not an object`)
  }
  if (typeof provider.id !== 'string' || !provider.id) {
    throw new Error(`${label}: missing string id`)
  }
  for (const m of PROVIDER_REQUIRED_METHODS) {
    if (typeof provider[m] !== 'function') {
      throw new Error(`${label}: missing required method ${m}()`)
    }
  }
  for (const banned of FORBIDDEN_SECRET_SURFACE) {
    if (banned in provider) {
      throw new Error(
        `${label}: exposes "${banned}" — adapters carry no vendor secret and ` +
        'must delegate to the engine (design §3 "registration, not rewrite")'
      )
    }
  }

  const caps = provider.capabilities()
  assertCapabilitiesShape(caps, label)

  // Every DECLARED text capability must have its method. Voice capabilities
  // (stt/tts/clone) are declaration-only and require no method here.
  for (const cap of caps.supports) {
    const method = CAPABILITY_METHOD[cap]
    if (method && typeof provider[method] !== 'function') {
      throw new Error(
        `${label}: declares "${cap}" but has no ${method}() method`
      )
    }
  }

  const health = provider.health()
  if (!health || !isMember(CIRCUIT_STATES, health.circuit)) {
    throw new Error(`${label}: health().circuit is not a CircuitState`)
  }

  const price = provider.priceSignal({ text: 'x', targetLang: 'en' })
  if (!price || !['char', 'token', 'call', 'none'].includes(price.unit)) {
    throw new Error(`${label}: priceSignal().unit is not a valid unit`)
  }
}

/** Validate a ProviderCapabilities object against the frozen vocabulary. */
export function assertCapabilitiesShape (caps, label = 'capabilities') {
  if (!caps || typeof caps !== 'object') {
    throw new Error(`${label}: capabilities() did not return an object`)
  }
  if (!Array.isArray(caps.supports) || caps.supports.length === 0) {
    throw new Error(`${label}: supports must be a non-empty array`)
  }
  for (const cap of caps.supports) {
    if (!isMember(CAPABILITIES, cap)) {
      throw new Error(`${label}: unknown capability "${cap}"`)
    }
  }
  if (typeof caps.languagePairs !== 'function') {
    throw new Error(`${label}: languagePairs must be a function`)
  }
  if (!Array.isArray(caps.scripts)) {
    throw new Error(`${label}: scripts must be an array`)
  }
  if (!isMember(QUALITY_TIERS, caps.qualityTier)) {
    throw new Error(`${label}: qualityTier "${caps.qualityTier}" invalid`)
  }
  if (!isMember(LATENCY_CLASSES, caps.latencyClass)) {
    throw new Error(`${label}: latencyClass "${caps.latencyClass}" invalid`)
  }
  if (!isMember(COST_CLASSES, caps.costClass)) {
    throw new Error(`${label}: costClass "${caps.costClass}" invalid`)
  }
  if (!isMember(PRIVACY_POSTURES, caps.privacy)) {
    throw new Error(`${label}: privacy "${caps.privacy}" invalid`)
  }
}

/** Does this provider declare (and therefore implement) `capability`? */
export function providerSupports (provider, capability) {
  try {
    const caps = provider.capabilities()
    if (!caps.supports.includes(capability)) return false
    const method = CAPABILITY_METHOD[capability]
    // A text capability is only "supported" if the method is actually callable.
    if (method) return typeof provider[method] === 'function'
    return true
  } catch {
    return false
  }
}

/** The capabilities that map to a runnable text method (re-exported for callers). */
export { TEXT_CAPABILITIES }
