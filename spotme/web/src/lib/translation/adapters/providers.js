/**
 * Spot Me — the provider adapters. Thin registrations, not rewrites.
 *
 * Each adapter is the design's §3 mapping made concrete: it declares a
 * provider's capability row (from ../capabilities.js) and exposes exactly the
 * operations that row supports, each DELEGATING to the engine port. There is no
 * vendor key here, no vendor URL, no prompt — those stay in `api/translate.js`.
 * That is enforced, not just intended: the contract's FORBIDDEN_SECRET_SURFACE
 * refuses any adapter that grew one.
 *
 *   googleTranslate            -> google.translate
 *   azureTranslate/-lit/-detect-> azure.translate / .transliterate / .detectLanguage
 *   sarvamTranslate/-lit       -> sarvam.translate / .transliterate
 *   geminiTranslate/askGemini  -> gemini.translate / .comprehend / .adjudicate
 *   askOpenAI / askAnthropic   -> openai/anthropic .comprehend / .adjudicate
 *   googleTransliterate        -> google-inputtools.transliterate
 *   sttBlob/ttsClone/cloneVoice-> elevenlabs .stt/.tts/.clone (declaration-only)
 *
 * The health snapshot is derived from the matrix's latency class and the
 * provider's breaker, so the router's latency/circuit terms are meaningful even
 * before real telemetry exists (design §14 fills these from observability). No
 * message content ever appears in a health snapshot.
 */
import { CAPABILITY_METHOD } from '../types.js'
import { providerCapabilities } from '../capabilities.js'

/** Sensible default p95 by latency class, so scoring differentiates providers. */
const P95_BY_CLASS = Object.freeze({ realtime: 60, fast: 900, medium: 2200, slow: 4200 })

/** LLM legs are billed per token, statistical engines per character. */
const TOKEN_PROVIDERS = new Set(['openai', 'anthropic', 'gemini'])
const CALL_PROVIDERS = new Set(['google-inputtools', 'elevenlabs'])

function priceUnitFor (id, costClass) {
  if (costClass === 'free' && CALL_PROVIDERS.has(id)) return 'call'
  if (id === 'elevenlabs') return 'call'
  if (TOKEN_PROVIDERS.has(id)) return 'token'
  return 'char'
}

/** Build a health snapshot: the breaker's circuit + a class-derived latency. */
function healthOf (id, caps, breaker, override) {
  if (typeof override === 'function') return override()
  const p95 = P95_BY_CLASS[caps.latencyClass] ?? 2000
  return {
    circuit: breaker ? breaker.state() : 'closed',
    p50Ms: Math.round(p95 / 2),
    p95Ms: p95,
    errorRate: breaker ? Math.min(1, (breaker.snapshot().failureCount || 0) / 10) : 0
  }
}

/**
 * Create one provider adapter.
 *
 * @param {string} id                  a ProviderId present in the matrix
 * @param {object} port                the engine port (../adapters/engine-port.js)
 * @param {{breaker?: object, health?: Function}} [opts]
 */
export function createEngineProvider (id, port, opts = {}) {
  const caps = providerCapabilities(id)
  if (!caps) throw new Error(`no capability row for provider "${id}"`)
  const breaker = opts.breaker || null

  const adapter = {
    id,
    capabilities: () => providerCapabilities(id), // fresh copy each call — data, not shared mutable state
    health: () => healthOf(id, caps, breaker, opts.health),
    priceSignal (req) {
      const unit = priceUnitFor(id, caps.costClass)
      const text = String(req?.text || '')
      const estimatedUnits = unit === 'token'
        ? Math.ceil(text.length / 4) // ~4 chars/token, the usual rule of thumb
        : unit === 'char' ? text.length : 1
      return { unit, estimatedUnits, costClass: caps.costClass }
    }
  }

  // Attach exactly the operations this provider's row declares — each a thin
  // delegation to the port. Voice capabilities (stt/tts/clone) declare no text
  // method and are intentionally not attached here.
  for (const cap of caps.supports) {
    const method = CAPABILITY_METHOD[cap]
    if (!method) continue
    switch (method) {
      case 'translate':
        adapter.translate = (req) => port.translate({ ...req, provider: id })
        break
      case 'detectLanguage':
        adapter.detectLanguage = (text) => port.detectLanguage(text)
        break
      case 'transliterate':
        adapter.transliterate = (req) => port.transliterate({ ...req, provider: id })
        break
      case 'comprehend':
        adapter.comprehend = (req) => port.comprehend({ ...req, provider: id })
        break
      case 'adjudicate':
        adapter.adjudicate = (req) => port.adjudicate({ ...req, provider: id })
        break
      default:
        break
    }
  }

  return adapter
}
