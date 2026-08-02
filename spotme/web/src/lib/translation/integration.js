/**
 * Spot Me — the integration seam between the app's entry points and the platform.
 *
 * This is where deliverable §9 lands WITHOUT touching the shipped engine. The
 * live path — `src/lib/translate.js` on the client, `api/translate.js` on the
 * server — is not edited (the not-shipped fence proves it), because the wiring
 * lives HERE as a gated adapter the app can adopt in one deliberate step:
 *
 *   createTranslationEntry({ engine, platform }).translate(request)
 *
 * FLAG-OFF IS BYTE-IDENTICAL, BY CONSTRUCTION. When the master flag is OFF, the
 * entry is a PURE DELEGATION: it calls the injected `engine` (today's translate
 * function) and returns its result verbatim — no cache read or write, no routing,
 * no metrics, no context, no cost accounting. There is no code path from a
 * disabled entry to the platform, so "OFF behaves exactly like today" is not a
 * promise, it is the only thing the function can do. `test/translation-integration
 * .test.js` proves the OFF result is the engine's own object, unmodified, and that
 * no platform collaborator was touched.
 *
 * WHEN ON, it runs the platform pipeline (cache→route→execute→verify→cost→
 * metrics). Single message, whole chat, batch and voice-note transcripts all go
 * through the same text path; STREAMING and live voice are an interface STUB
 * (ADR-011, deferred) — declared, never implemented, never a live-call.
 */
import { isPlatformV2Enabled } from './flag.js'

/**
 * Build the entry adapter.
 *
 * @param {{
 *   engine: (request: object, opts?: object) => Promise<any>,  // the legacy path
 *   platform?: { run: (request: object, opts?: object) => Promise<any> },
 *   isEnabled?: () => boolean                                   // defaults to the master flag
 * }} deps
 */
export function createTranslationEntry (deps = {}) {
  const engine = deps.engine
  const platform = deps.platform || null
  const isEnabled = typeof deps.isEnabled === 'function' ? deps.isEnabled : isPlatformV2Enabled

  if (typeof engine !== 'function') {
    throw new Error('createTranslationEntry: an `engine` delegate is required (the legacy translate path)')
  }

  /**
   * Translate one message. OFF → the engine verbatim; ON → the platform. The
   * OFF branch returns EXACTLY what the engine returned — same value, no wrapping.
   */
  async function translate (request, opts = {}) {
    if (!isEnabled()) return engine(request, opts) // byte-identical passthrough
    if (!platform || typeof platform.run !== 'function') {
      // Enabled but nothing to run — refuse rather than silently bypass the flag.
      throw new Error('translation platform enabled but not assembled (no platform.run)')
    }
    return platform.run(request, opts)
  }

  /**
   * Whole-chat / batch translation: many messages, one shared context/opts. OFF
   * → each delegates to the engine verbatim (so a batch is byte-identical to N
   * legacy calls); ON → each runs the pipeline, sharing the context window so the
   * conversation disambiguates itself. Sequential for deterministic ordering and
   * so the cost governor sees calls in order; a real deploy may bound-concurrent.
   */
  async function translateBatch (requests, opts = {}) {
    const list = Array.isArray(requests) ? requests : []
    const out = []
    for (const req of list) out.push(await translate(req, opts))
    return out
  }

  /**
   * A voice-note whose audio was already transcribed to `request.text` upstream.
   * The platform treats it as text (the STT leg is the ③ substrate, ADR-011, and
   * is NOT performed here). `kind` is carried through for observability only.
   */
  async function translateVoiceNote (request, opts = {}) {
    return translate({ ...request, kind: 'voice-note' }, opts)
  }

  return {
    translate,
    translateBatch,
    translateVoiceNote,
    streaming: createStreamingStub(),
    get enabled () { return isEnabled() }
  }
}

/** The message every streaming call throws — this is a stub, not an implementation. */
export const STREAMING_NOT_IMPLEMENTED =
  'streaming translation is an interface stub — no live-call/voice implementation ' +
  '(the ③ live-voice substrate is ADR-011, deferred and out of scope here)'

/**
 * The streaming INTERFACE, declared so callers can feature-detect it, with no
 * implementation behind it. `supported` is false; `stream()` is an async
 * generator that throws on first pull; `describe()` explains why. This exists so
 * the platform's shape is complete (design lists streaming as a capability) while
 * being honest that the live path does not exist here.
 */
export function createStreamingStub () {
  return {
    supported: false,
    describe () { return { supported: false, reason: STREAMING_NOT_IMPLEMENTED } },
    // eslint-disable-next-line require-yield
    async * stream () { throw new Error(STREAMING_NOT_IMPLEMENTED) }
  }
}
