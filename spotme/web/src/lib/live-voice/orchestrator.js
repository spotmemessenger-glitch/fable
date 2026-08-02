/**
 * Spot Me — the live-voice pipeline orchestrator SKELETON. §6.2, ADR-011.
 *
 * This is the seam that will one day drive a real call, wired here only to STUB
 * adapters. It does three real things and defers everything provider-specific:
 *
 *   1. WIRES the three streaming interfaces in the §6.2 order —
 *      STT → MT → (optional LLM correction) → TTS → playback — passing each
 *      stage's output to the next and every emission out as a typed frame.
 *   2. DRIVES the utterance state machine (session-state.js) across the stages,
 *      so an illegal order or a stall shows up as a refused transition, not
 *      garbled audio.
 *   3. ACCOUNTS latency against the <2.5 s budget (latency-budget.js), marking
 *      each stage at the moment it reports first-token/final, and FALLING BACK
 *      to captions (§6.2.8) the instant the budget is blown — rather than
 *      spending the whole budget to deliver late audio.
 *
 * WHAT IS DEFERRED, ON PURPOSE (see ADR-011): microphone capture and WebRTC
 * ingress, voice-activity detection, the network wire that carries the frames,
 * real provider SDKs, provider routing/fallback-by-quality, and playback
 * scheduling that actually preserves conversational order. Those are the real
 * implementation; this proves the shape.
 *
 * NOT WIRED IN. Nothing in the app imports this. The flag (flags.js) is OFF.
 * A caller must inject adapters explicitly; there is no default that reaches a
 * live provider.
 */

import {
  UTTERANCE_STATES as U,
  createLiveTranslationSession
} from './session-state.js'
import { createLatencyBudget } from './latency-budget.js'
import { assertStreamController } from './streaming-interfaces.js'
import {
  makePartialCaptionFrame,
  makeTranslatedAudioOutFrame,
  makeControlFrame,
  CONTROL_SIGNALS
} from './frames.js'

/** A frame sink that just collects, for tests and for the future wire-in to
 *  replace with a real transport publish. */
export function createFrameCollector () {
  const frames = []
  return { emit: (f) => { frames.push(f); return f }, get frames () { return frames.slice() } }
}

function defaultClock () {
  try { if (typeof performance !== 'undefined' && performance.now) return performance.now() } catch { /* none */ }
  return Date.now()
}

/**
 * Build an orchestrator over injected dependencies. Every provider is a
 * parameter — there is no hidden default — which is what keeps §6.3's
 * "replaceable modules" true and lets a test run the whole pipeline on stubs.
 *
 * @param {object} deps
 * @param {object} deps.stt        IStreamingStt
 * @param {object} deps.mt         IStreamingMt
 * @param {object} deps.tts        IStreamingTts
 * @param {object} [deps.corrector] optional LLM corrector: `correct({text,...}) -> {text}`
 * @param {object} deps.playback   `schedule(chunk) -> Promise`
 * @param {function} [deps.emit]   frame sink; defaults to a collector
 * @param {function} [deps.clock]  ms clock; injected for deterministic tests
 */
export function createLiveVoiceOrchestrator (deps = {}) {
  const { stt, mt, tts, corrector = null, playback } = deps
  if (!stt || !mt || !tts || !playback) throw new Error('orchestrator: stt, mt, tts, playback are required')
  const clock = deps.clock || defaultClock
  const collector = deps.emit ? { emit: deps.emit } : createFrameCollector()
  const emit = collector.emit

  /**
   * Start one utterance through the pipeline. Returns a handle:
   *   `{ done, cancel(reason), get state(), get budget() }`
   * `done` resolves to a typed result; it never rejects — a failure becomes a
   * DROPPED utterance with a fallback, because a thrown pipeline stage would
   * take the whole call down with it (§6.3: calls must survive translation
   * failure).
   */
  function start (spec = {}) {
    const {
      sessionId = 'sess', utteranceId: fixedId = null,
      script, sourceLang = 'auto', targetLang = 'en', voiceProfileId = null
    } = spec

    const session = createLiveTranslationSession({ sessionId, sourceLang, targetLang, voiceProfileId, clock })
    const { id: utteranceId, machine } = session.newUtterance()
    const uid = fixedId || utteranceId
    const budget = createLatencyBudget({ clock })

    let seq = 0
    const nextSeq = () => seq++
    let activeController = null
    let cancelled = null

    const frameBase = () => ({ sessionId, utteranceId: uid })

    const emitCaption = ({ text, translatedText = null, partial }) => emit(makePartialCaptionFrame({
      ...frameBase(), seq: nextSeq(), t: clock(),
      sourceLang, targetLang: translatedText != null ? targetLang : null,
      text, translatedText, partial
    }))

    const emitAudio = ({ chunk, firstAudio, final }) => emit(makeTranslatedAudioOutFrame({
      ...frameBase(), seq: nextSeq(), t: clock(),
      chunk, targetLang, voiceId: voiceProfileId, firstAudio, final
    }))

    const emitControl = (signal, reason = null) => emit(makeControlFrame({
      ...frameBase(), seq: nextSeq(), t: clock(), signal, reason
    }))

    // A cancellation checkpoint between/after stages: returns true if the caller
    // must stop. A cancel can originate here (`cancelled` set by the handle) OR
    // be reported by a stage that stopped mid-stream (`r.cancelled`) — both must
    // move the machine, so the stage result is considered, not just the flag.
    // Moves LISTENING…PLAYING → INTERRUPTED → DROPPED and signals the barge-in.
    const interrupted = (r = null) => {
      if (!cancelled && !r?.cancelled) return false
      if (!cancelled && r?.cancelled) cancelled = r.cancelled
      if (activeController) { try { activeController.cancel(cancelled) } catch { /* already done */ } }
      if (machine.can(U.INTERRUPTED)) machine.to(U.INTERRUPTED, { reason: cancelled })
      if (machine.can(U.DROPPED)) machine.to(U.DROPPED, { reason: 'interrupted' })
      emitControl(CONTROL_SIGNALS.INTERRUPT, cancelled)
      return true
    }

    // Fall back to captions and drop the audio for this utterance (§6.2.8).
    const fallback = (reason) => {
      emitControl(CONTROL_SIGNALS.FALLBACK_CAPTIONS, reason)
      emitControl(CONTROL_SIGNALS.VOICE_ACTIVE_OFF, reason)
      if (machine.can(U.DROPPED)) machine.to(U.DROPPED, { reason })
      emitControl(CONTROL_SIGNALS.DROP, reason)
    }

    const done = (async () => {
      budget.begin()
      // ---- capture / VAD (§6.2.1–2). DEFERRED to real mic; the segment is the
      //      input `script` here. We still cost & state it so the shape holds.
      machine.to(U.LISTENING)
      budget.mark('capture')
      if (interrupted()) return result({ interrupted: true })

      // ---- streaming STT (§6.2.3–4) --------------------------------------
      machine.to(U.TRANSCRIBING)
      let transcript = ''
      let detectedLang = sourceLang
      {
        const ctrl = stt.transcribe({ script, lang: sourceLang }, {
          onFirstToken: () => budget.mark('stt_partial'),
          onPartial: ({ text }) => emitCaption({ text, partial: true }),
          onFinal: ({ text, lang }) => { transcript = text; detectedLang = lang; budget.mark('stt_final') }
        })
        assertStreamController(ctrl, 'stt.transcribe')
        activeController = ctrl
        const r = await ctrl.done
        if (interrupted(r)) return result({ interrupted: true })
        emitCaption({ text: transcript, partial: false })
      }

      // ---- streaming MT (§6.2.5) -----------------------------------------
      machine.to(U.TRANSLATING)
      let translation = ''
      let mtConfidence = null   // carried when the MT stage reports one (the
      let mtProvider = null     // #51-platform stage does; stubs need not)
      {
        const ctrl = mt.translate({ text: transcript, sourceLang: detectedLang, targetLang }, {
          onPartial: ({ text }) => emitCaption({ text: transcript, translatedText: text, partial: true }),
          onFinal: ({ text, confidence, provider }) => {
            translation = text
            if (typeof confidence === 'number') mtConfidence = confidence
            if (provider != null) mtProvider = provider
            budget.mark('mt')
          }
        })
        assertStreamController(ctrl, 'mt.translate')
        activeController = ctrl
        const r = await ctrl.done
        if (interrupted(r)) return result({ interrupted: true })
        emitCaption({ text: transcript, translatedText: translation, partial: false })
      }

      // ---- optional LLM correction (CORRECTING is skippable) --------------
      if (corrector) {
        machine.to(U.CORRECTING)
        const { text } = await corrector.correct({ text: translation, sourceLang: detectedLang, targetLang })
        translation = text
        budget.mark('llm_correct')
        if (interrupted()) return result({ interrupted: true })
        emitCaption({ text: transcript, translatedText: translation, partial: false })
      }

      // ---- budget gate: if we are already over, fall back to captions -----
      if (budget.overBudget()) {
        fallback('over-budget-before-tts')
        return result({ fallback: true, transcript, detectedLang, translation, budget: budget.report() })
      }

      // ---- streaming TTS in the consented voice (§6.2.6) ------------------
      // No voice profile → no synthesized audio; captions carry the meaning.
      if (!voiceProfileId) {
        fallback('no-voice-profile')
        return result({ fallback: true, transcript, detectedLang, translation, budget: budget.report() })
      }
      machine.to(U.SYNTHESIZING)
      emitControl(CONTROL_SIGNALS.VOICE_ACTIVE_ON)
      const audioChunks = []
      {
        const ctrl = tts.synthesize({ text: translation, voiceId: voiceProfileId, targetLang }, {
          onFirstToken: () => budget.mark('tts_first_audio'),
          onPartial: ({ chunk, firstAudio, final }) => { audioChunks.push(chunk); emitAudio({ chunk, firstAudio, final }) }
        })
        assertStreamController(ctrl, 'tts.synthesize')
        activeController = ctrl
        const r = await ctrl.done
        if (interrupted(r)) return result({ interrupted: true })
      }

      // ---- scheduled playback (§6.2.7) — DEFERRED ordering logic ----------
      machine.to(U.PLAYING)
      for (const chunk of audioChunks) await playback.schedule(chunk)
      budget.mark('playback_schedule')
      emitControl(CONTROL_SIGNALS.VOICE_ACTIVE_OFF)

      machine.to(U.COMPLETED)
      return result({ completed: true, transcript, detectedLang, translation, mtConfidence, mtProvider, audioChunks, budget: budget.report() })
    })().catch((err) => {
      // Any unexpected throw becomes a drop + caption fallback, never a rejected
      // promise — the call must outlive a translation failure (§6.3).
      try { fallback(`error:${err?.message || err}`) } catch { /* machine already terminal */ }
      return result({ dropped: true, error: String(err?.message || err), budget: budget.report() })
    })

    function result (extra) {
      return {
        sessionId, utteranceId: uid, sourceLang, targetLang, voiceProfileId,
        state: machine.state, history: machine.history,
        frames: collector.frames ? collector.frames : undefined,
        budget: budget.report(),
        ...extra
      }
    }

    return {
      done,
      cancel: (reason = 'barge-in') => { cancelled = reason; if (activeController) { try { activeController.cancel(reason) } catch { /* done */ } } },
      get state () { return machine.state },
      get budget () { return budget },
      utteranceId: uid
    }
  }

  return {
    start,
    /** Convenience: run one utterance to completion and resolve its result. */
    processUtterance (spec) { return start(spec).done },
    get frames () { return collector.frames ? collector.frames : [] }
  }
}
