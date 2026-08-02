/**
 * Spot Me — the live MT stage (IStreamingMt) over the #51 Translation
 * Platform. ADR-011b, WS3 design §3.2 step 6, §7.3.
 *
 * The live pipeline does NOT grow its own translator. Routing, failover,
 * circuit breakers, confidence, cost governance, privacy postures and bounded
 * conversation context all already exist in `src/lib/translation/` — this
 * stage CONSUMES that platform per caption segment and streams the answers
 * through the IStreamingMt contract the orchestrator expects. Nothing from
 * the platform is duplicated here; the platform's own files are not touched.
 *
 * WHAT FLOWS THROUGH, PER SEGMENT:
 *   routing/failover — platform.run() walks the scored chain (#51 router)
 *   confidence       — the derived confidence + band ride the final result
 *   cost/privacy     — the pipeline's own gates apply per call
 *   context          — a BOUNDED window (translation/context.js) carries the
 *                      conversation so "varen" translates as the promise it
 *                      is; turns are added here, capped there
 *   glossary/names   — passed straight to buildContext (§8 six inputs)
 *
 * STRICT PRIVACY REFUSES, BY DESIGN. `strict` means on-device only
 * (translation/privacy.js MODE_POSTURES). There is no on-device streaming MT
 * provider in this build, so a strict-mode live translation is REFUSED with a
 * typed error rather than silently downgraded — the session layer turns that
 * into original-captions-only. The refusal is the privacy feature: plaintext
 * captions never leave the device in strict mode. (In `standard`/`sensitive`
 * the platform's own posture gates pick which providers may see text.)
 *
 * STREAMING SEMANTICS, HONESTLY. The platform is request/response per
 * segment; the live feel comes from SEGMENTATION (clause-sized units arrive
 * continuously), not from pretending a batch call streams. For multi-part
 * inputs (`input.segments`) each part translates in order and the growing
 * text streams out as partials; a single segment emits one partial then the
 * final. First answer fires `onFirstToken` — the `mt` latency mark.
 */

import { StreamingStatus, assertImplementsStreamingMt, normalizeHandlers } from './streaming-interfaces.js'
import { createContextWindow } from '../translation/context.js'
import { normalizeMode } from '../translation/privacy.js'

/** The typed refusal reason for strict privacy mode. */
export const STRICT_PRIVACY_REFUSAL = 'strict-privacy: live translation is cloud-routed and strict mode is on-device only — captions stay original'

const DEFAULTS = Object.freeze({
  segmentTimeoutMs: 6_000,   // ceiling per platform call — bounded, always
  maxDecisionLog: 32         // bounded routing-evidence memory
})

const CAPS = Object.freeze({
  partial: true, firstToken: true, cancel: true, streaming: true,
  provider: 'translation-platform', role: 'mt', wire: 'segment-batch-over-#51'
})

/**
 * Create the MT stage.
 *
 * @param {{
 *   platform?: { run: Function },        // buildTranslationPlatform() result
 *   pipeline?: { translate: Function },  // or a bare createPipeline() result
 *   window?: object,                     // translation createContextWindow()
 *   glossary?: string[],
 *   prefs?: object,                      // per-conversation prefs (incl. privacyMode)
 *   privacyMode?: string,                // session-level mode; tightens, never loosens
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 *   segmentTimeoutMs?: number
 * }} [opts]
 */
export function createTranslationPlatformMt (opts = {}) {
  const runFn = opts.platform && typeof opts.platform.run === 'function'
    ? (req, o) => opts.platform.run(req, o)
    : opts.pipeline && typeof opts.pipeline.translate === 'function'
      ? (req, o) => opts.pipeline.translate(req, o)
      : null
  if (!runFn) throw new Error('mt-stage: a translation platform ({platform} or {pipeline}) is required — this stage does not translate by itself')

  const cfg = { ...DEFAULTS, ...opts }
  const timers = opts.timers || { setTimeout, clearTimeout }
  const window = opts.window || createContextWindow()
  const glossary = Array.isArray(opts.glossary) ? opts.glossary.slice() : []
  const prefs = { ...(opts.prefs || {}) }
  const sessionMode = normalizeMode(opts.privacyMode || prefs.privacyMode)
  const decisions = [] // bounded evidence: what the platform decided per segment
  let status = StreamingStatus.IDLE

  function recordDecision (d) {
    decisions.push(d)
    while (decisions.length > cfg.maxDecisionLog) decisions.shift()
  }

  async function translateSegment (text, sourceLang, targetLang, signalState) {
    const request = {
      text,
      sourceLang: sourceLang === 'auto' ? undefined : sourceLang,
      targetLang,
      privacyMode: sessionMode,
      kind: 'live-caption'
    }
    const platformOpts = { window, glossary, prefs: { ...prefs, privacyMode: sessionMode } }
    let timer = null
    try {
      const result = await Promise.race([
        runFn(request, platformOpts),
        new Promise((_, reject) => { timer = timers.setTimeout(() => reject(new Error(`mt-stage: segment exceeded ${cfg.segmentTimeoutMs}ms ceiling`)), cfg.segmentTimeoutMs) })
      ])
      if (signalState.cancelled) return null
      recordDecision({
        provider: result?.provider ?? null,
        confidence: result?.confidence ?? null,
        // The platform names the band `band` on the single path and
        // `confidenceBand` on the verified path — accept either.
        confidenceBand: result?.confidenceBand ?? result?.band ?? null,
        uncertain: Boolean(result?.uncertain),
        cacheHit: Boolean(result?.cacheHit),
        latencyMs: result?.latencyMs ?? null,
        reason: result?.uncertain ? (result?.note || result?.reason || 'uncertain') : 'ok'
      })
      return result
    } finally {
      if (timer != null) timers.clearTimeout(timer)
    }
  }

  const adapter = {
    open () {
      if (sessionMode === 'strict') {
        status = StreamingStatus.FAILED
        return Promise.reject(new Error(STRICT_PRIVACY_REFUSAL))
      }
      status = StreamingStatus.OPEN
      return Promise.resolve()
    },
    close () { status = StreamingStatus.CLOSED; return Promise.resolve() },
    status: () => status,
    capabilities: () => CAPS,

    /**
     * Translate one stabilised caption unit. `input`: `{ text | segments[],
     * sourceLang, targetLang, speaker? }`. Emits growing partials per
     * translated sub-segment, then a final carrying the platform's provider,
     * confidence and band. The final transcript turn is added to the bounded
     * context window so the NEXT segment translates in conversation.
     */
    translate (input, handlers) {
      const h = normalizeHandlers(handlers)
      const segments = Array.isArray(input?.segments) && input.segments.length
        ? input.segments.map((s) => String(s))
        : [String(input?.text ?? '')]
      const sourceLang = input?.sourceLang ?? 'auto'
      const targetLang = input?.targetLang ?? 'en'
      const speaker = input?.speaker || 'speaker'
      const signalState = { cancelled: null }
      status = StreamingStatus.STREAMING

      const done = (async () => {
        // Defense in depth: the session layer should never construct this
        // stage in strict mode, and if it does, no text leaves anyway.
        if (sessionMode === 'strict') throw new Error(STRICT_PRIVACY_REFUSAL)
        const parts = []
        let last = null
        let worst = null // the LOWEST confidence seen — honesty over averaging
        for (let i = 0; i < segments.length; i++) {
          if (signalState.cancelled) return { cancelled: signalState.cancelled }
          const seg = segments[i].trim()
          if (!seg) continue
          const r = await translateSegment(seg, sourceLang, targetLang, signalState)
          if (signalState.cancelled) return { cancelled: signalState.cancelled }
          if (!r || r.uncertain || !r.text) {
            const err = new Error(`mt-stage: platform uncertain — ${r?.note || r?.reason || 'no eligible provider / all failed'}`)
            err.uncertain = true
            throw err
          }
          last = r
          if (worst == null || (typeof r.confidence === 'number' && r.confidence < worst)) worst = r.confidence ?? worst
          parts.push(r.text)
          const acc = parts.join(' ').replace(/\s+/g, ' ').trim()
          if (parts.length === 1) h.onFirstToken({ kind: 'partial', text: acc, targetLang })
          h.onPartial({ text: acc, targetLang, partial: true, confidence: r.confidence ?? null })
        }
        const text = parts.join(' ').replace(/\s+/g, ' ').trim()
        // Conversation memory: the finished turn joins the BOUNDED window
        // (translation/context.js caps turns AND chars) for the next segment.
        window.add({ speaker, text: String(input?.text ?? segments.join(' ')), lang: sourceLang === 'auto' ? null : sourceLang })
        const result = {
          text,
          targetLang,
          final: true,
          provider: last?.provider ?? null,
          confidence: worst ?? last?.confidence ?? null,
          confidenceBand: last?.confidenceBand ?? last?.band ?? null,
          privacyNotice: last?.privacyNotice
        }
        h.onFinal(result)
        status = StreamingStatus.OPEN
        return result
      })().catch((e) => {
        status = StreamingStatus.FAILED
        h.onError(e)
        throw e
      })

      return {
        cancel: (reason = 'cancelled') => { signalState.cancelled = reason },
        done
      }
    },

    /** The bounded routing-evidence log (provider, confidence, reasons). */
    decisionLog: () => decisions.slice(),
    /** The privacy mode this stage was built with (normalised). */
    privacyMode: () => sessionMode
  }

  assertImplementsStreamingMt(adapter, 'TranslationPlatformMt')
  return adapter
}
