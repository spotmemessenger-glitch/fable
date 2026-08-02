/**
 * Spot Me — the shared vocabulary of the translation platform, as DATA.
 *
 * JavaScript has no enums or interfaces, so the design doc's TypeScript-flavoured
 * types (priority-2/02-translation-platform.md §3.1) land here as frozen arrays
 * and a couple of frozen maps. Everything downstream — the provider contract,
 * the capability matrix, the router, the scorer — validates against THESE, so a
 * typo like `latencyClass: 'quick'` is caught at registration, not in
 * production. Freezing them makes the vocabulary the single source of truth
 * rather than a comment that drifts.
 *
 * @typedef {string} LanguageCode  BCP-47 subset, e.g. "ta", "pt-BR", "ta-Latn"
 * @typedef {string} ScriptCode    ISO-15924, e.g. "Latn", "Taml", "Deva"
 * @typedef {string} ProviderId
 * @typedef {'translate'|'detect'|'transliterate'|'comprehend'|'adjudicate'|'detectScript'|'stt'|'tts'|'clone'} Capability
 * @typedef {'realtime'|'fast'|'medium'|'slow'} LatencyClass
 * @typedef {'free'|'cheap'|'metered'|'premium'} CostClass
 * @typedef {'reference'|'high'|'general'|'fallback'} QualityTier
 * @typedef {'on-device'|'cloud-contract'|'cloud-keyless'} PrivacyPosture
 * @typedef {'accuracy'|'latency'|'cost'} RoutingProfile
 * @typedef {'closed'|'open'|'half-open'} CircuitState
 *
 * @typedef {Object} TranslateRequest
 * @property {string} text
 * @property {LanguageCode} [sourceLang]  a CLAIM, not a fact
 * @property {LanguageCode} targetLang
 * @property {Capability} [requiredCapability]
 * @property {RoutingProfile} [routingProfile]
 * @property {string} [tenantId]
 * @property {boolean} [verify]
 *
 * @typedef {Object} ProviderCapabilities
 * @property {Capability[]} supports
 * @property {(src: LanguageCode, tgt: LanguageCode) => number} languagePairs  0..1 fitness
 * @property {ScriptCode[]} scripts
 * @property {boolean} streaming
 * @property {QualityTier} qualityTier
 * @property {LatencyClass} latencyClass
 * @property {CostClass} costClass
 * @property {PrivacyPosture} privacy
 * @property {{rpm?: number, note?: string}} rateLimit
 *
 * @typedef {Object} HealthSnapshot
 * @property {CircuitState} circuit
 * @property {number} p50Ms
 * @property {number} p95Ms
 * @property {number} errorRate
 * @property {string} [lastError]  internal only, never relayed
 *
 * @typedef {Object} PriceSignal
 * @property {'char'|'token'|'call'|'none'} unit
 * @property {number} estimatedUnits
 * @property {CostClass} costClass
 *
 * @typedef {Object} RoutingDecision
 * @property {RoutingProfile} profile
 * @property {Capability} requiredCapability
 * @property {Array<{id: ProviderId, score: number, gatedOut?: string}>} candidates
 * @property {ProviderId|string|null} chosen
 * @property {ProviderId[]} fallbacksTaken
 * @property {'agree'|'adjudicated'|'single'|'none'} verified
 * @property {ProviderId} [adjudicator]
 * @property {ProviderId[]} breakerTrips
 * @property {string} policyVersion
 */

/** Every capability a provider may declare. */
export const CAPABILITIES = Object.freeze([
  'translate', 'detect', 'transliterate', 'comprehend', 'adjudicate',
  'detectScript', 'stt', 'tts', 'clone'
])

/**
 * Which declared capability requires which method on the adapter.
 *
 * A provider that lists `translate` in `supports` MUST expose a `translate()`
 * method; the contract check (ITranslationProvider) enforces exactly this map.
 * Voice legs (stt/tts/clone) are declaration-only here — they are the ③
 * live-voice substrate (ADR-011), not executed by the text platform — so they
 * are absent from this map and require no text method.
 */
export const CAPABILITY_METHOD = Object.freeze({
  translate: 'translate',
  detect: 'detectLanguage',
  transliterate: 'transliterate',
  comprehend: 'comprehend',
  adjudicate: 'adjudicate',
  detectScript: 'detectScript'
})

/** Capabilities that map to an executable text method (subset of CAPABILITIES). */
export const TEXT_CAPABILITIES = Object.freeze(Object.keys(CAPABILITY_METHOD))

/** Voice capabilities — declared for the ③ substrate, not run here. */
export const VOICE_CAPABILITIES = Object.freeze(['stt', 'tts', 'clone'])

/** Budget tiers a provider's measured latency falls into. */
export const LATENCY_CLASSES = Object.freeze(['realtime', 'fast', 'medium', 'slow'])

/** Cost tiers, cheapest first. */
export const COST_CLASSES = Object.freeze(['free', 'cheap', 'metered', 'premium'])

/** Quality tiers, best first. `reference` is the specialist ceiling (Sarvam/Indic). */
export const QUALITY_TIERS = Object.freeze(['reference', 'high', 'general', 'fallback'])

/**
 * Privacy posture. `on-device` is the only one that preserves the E2E property
 * (nothing leaves the phone); `cloud-keyless` has no data-processing contract
 * and is denied to enterprise tenants by default (§12.3).
 */
export const PRIVACY_POSTURES = Object.freeze(['on-device', 'cloud-contract', 'cloud-keyless'])

/** The three weight-preset profiles the router selects with (§5.2). */
export const ROUTING_PROFILES = Object.freeze(['accuracy', 'latency', 'cost'])

/** Circuit-breaker states (§10.2). */
export const CIRCUIT_STATES = Object.freeze(['closed', 'open', 'half-open'])

/** The providers the existing engine already speaks to (§4). */
export const PROVIDER_IDS = Object.freeze([
  'device', 'google', 'azure', 'sarvam', 'gemini', 'openai', 'anthropic',
  'google-inputtools', 'elevenlabs', 'gtx', 'mymemory'
])

/** Which `?op=` on the existing engine maps to which required capability. */
export const OP_CAPABILITY = Object.freeze({
  translate: 'translate',
  detect: 'detect',
  translit: 'transliterate',
  read: 'comprehend'
})

/** True when `v` is a member of the frozen vocabulary `set`. */
export function isMember (set, v) {
  return Array.isArray(set) && set.includes(v)
}

/** Canonical "src|tgt" key for per-pair lookups (quality store, overrides). */
export function pairKey (src, tgt) {
  const base = (c) => String(c || '').toLowerCase().split('-')[0]
  return `${base(src) || '*'}|${base(tgt) || '*'}`
}
