/**
 * Spot Me — the media/UI integration seam for live voice translation.
 * WS3 design §3.2 step 1, §6.4, §9.5; ADR-011b. FLAG-GATED, ADDITIVE.
 *
 * THE GATE IS THE FIRST LINE OF attach(). Unless BOTH `LIVE_VOICE_ENABLED`
 * (master) and `LIVE_TRANSLATION_ENABLED` (layered) are on, attach() returns
 * `{ attached: false }` having touched NOTHING: no track tapped, no adapter
 * constructed, no listener registered, no event emitted. The app with flags
 * off is byte-identical because this module — like the rest of live-voice —
 * is imported by nothing in the app; and even a future caller that imports it
 * cannot start anything while the flags are down.
 *
 * THE TAP IS A SECOND CONSUMER, NEVER A REWIRE. The existing call keeps its
 * own MediaStream exactly as `src/lib/rooms.js startCall/acceptCall` built it
 * (`{ audio: true }`, untouched). This seam CLONES the local audio track —
 * `track.clone()` yields an independent consumer of the same capture — and
 * feeds the CLONE to the pipeline. Stopping the clone cannot stop the call;
 * ending the call stops the source and the clone dies with it. Constraints
 * (echoCancellation/noiseSuppression — quality/constraints.js) apply to the
 * clone only.
 *
 * WHAT THE UI GETS IS AN EVENT/CONTROL SURFACE, NOT SCREENS. This module
 * deliberately builds no DOM: it exposes the typed events below plus control
 * methods, and `docs/live-voice/05-ui-architecture.md` maps every UI element
 * (dual subtitles, language pills, confidence cue, AI-voice indicator,
 * latency chip, toggles, replay, pin) onto them. Chat/room screens stay
 * untouched; adopting the surface is one deliberate hook-point call.
 */

import { isLiveVoiceEnabled, isLiveTranslationEnabled, isVoiceCloneEnabled, isLiveCaptionsEnabled, isGroupTranslationEnabled } from './flags.js'
import { createLiveVoiceSession } from './live-session.js'
import { applyLiveVoiceConstraints } from './quality/constraints.js'
import { FRAME_TYPES, CONTROL_SIGNALS } from './frames.js'

/** Every event the UI may subscribe to. Unknown names are refused loudly. */
export const UI_EVENTS = Object.freeze({
  CAPTION_ORIGINAL: 'caption-original',       // { speakerId, text, lang, partial }
  CAPTION_TRANSLATED: 'caption-translated',   // { speakerId, text, lang, partial } (dual subtitles)
  LANGUAGE: 'language',                       // { speakerId, sourceLang, targetLang }
  CONFIDENCE: 'confidence',                   // { utteranceId, confidence } per utterance
  VOICE_CLONE_ACTIVE: 'voice-clone-active',   // { active, voice: 'clone'|'generic' }
  LATENCY: 'latency',                         // { utteranceId, measuredMs, withinBudget, p50, p95 }
  TRANSLATED_AUDIO: 'translated-audio',       // { chunk, seq, final } — the playout feed
  DEGRADATION: 'degradation',                 // { tier, reason } ladder announcements
  REPLAY: 'replay',                           // { utteranceId, captions, audio }
  PINNED: 'pinned',                           // { speakerId|null }
  STATE: 'state'                              // { attached|detached|suspended|resumed|muted... }
})

const EVENT_SET = new Set(Object.values(UI_EVENTS))

/**
 * Create the integration. Every environment-shaped dependency is injectable
 * so the seam is fully testable without a browser:
 *
 * @param {{
 *   call: { local?: { getAudioTracks?: () => any[] } },   // conn.call shape
 *   participants: Array<{id, listenLang, speakLang?, voiceId?, consented?}>,
 *   selfId: string,
 *   adapters: { stt, mt, tts, corrector? },
 *   player?: { schedule: (chunk) => any },   // translated-audio sink (self)
 *   flagsFn?: () => object,                  // test seam; defaults to real flags
 *   clock?: () => number,
 *   sessionFactory?: typeof createLiveVoiceSession
 * }} opts
 */
export function createCallIntegration (opts = {}) {
  const {
    call, participants = [], selfId, adapters,
    player = { schedule: () => Promise.resolve() }
  } = opts
  const flagsFn = typeof opts.flagsFn === 'function'
    ? opts.flagsFn
    : () => ({
        liveVoice: isLiveVoiceEnabled(),
        liveTranslation: isLiveTranslationEnabled(),
        voiceClone: isVoiceCloneEnabled(),
        liveCaptions: isLiveCaptionsEnabled(),
        groupTranslation: isGroupTranslationEnabled()
      })
  const sessionFactory = opts.sessionFactory || createLiveVoiceSession
  const clock = opts.clock || (() => Date.now())

  const listeners = new Map()   // event -> Set<cb>
  let session = null
  let tappedTrack = null
  let mutedTranslated = false
  let listenOriginalOnly = false
  let pinned = null

  function on (event, cb) {
    if (!EVENT_SET.has(event)) throw new Error(`call-integration: unknown event "${event}" — use UI_EVENTS`)
    if (typeof cb !== 'function') throw new Error('call-integration: listener must be a function')
    let set = listeners.get(event)
    if (!set) { set = new Set(); listeners.set(event, set) }
    set.add(cb)
    return () => set.delete(cb)
  }

  function emit (event, payload) {
    const set = listeners.get(event)
    if (!set) return
    for (const cb of set) { try { cb(payload) } catch { /* a UI throw must not kill the pipeline */ } }
  }

  /** Session deliveries → typed UI events (only those addressed to self). */
  function onDelivery (delivery) {
    const { to, frame, speakerId, targetLang, voice } = delivery
    if (Array.isArray(to) && selfId && !to.includes(selfId)) return
    if (frame.type === FRAME_TYPES.PARTIAL_CAPTION) {
      if (frame.text) emit(UI_EVENTS.CAPTION_ORIGINAL, { speakerId, text: frame.text, lang: frame.sourceLang, partial: frame.partial, utteranceId: frame.utteranceId })
      if (frame.translatedText != null) emit(UI_EVENTS.CAPTION_TRANSLATED, { speakerId, text: frame.translatedText, lang: frame.targetLang, partial: frame.partial, utteranceId: frame.utteranceId })
      emit(UI_EVENTS.LANGUAGE, { speakerId, sourceLang: frame.sourceLang, targetLang: frame.targetLang ?? targetLang ?? null })
      return
    }
    if (frame.type === FRAME_TYPES.TRANSLATED_AUDIO_OUT) {
      emit(UI_EVENTS.TRANSLATED_AUDIO, { speakerId, chunk: frame.chunk, seq: frame.seq, final: frame.final, utteranceId: frame.utteranceId, voice })
      return
    }
    if (frame.type === FRAME_TYPES.CONTROL) {
      if (frame.signal === CONTROL_SIGNALS.VOICE_ACTIVE_ON) emit(UI_EVENTS.VOICE_CLONE_ACTIVE, { active: true, voice: voice || 'clone' })
      if (frame.signal === CONTROL_SIGNALS.VOICE_ACTIVE_OFF) emit(UI_EVENTS.VOICE_CLONE_ACTIVE, { active: false, voice: voice || 'clone' })
      if (frame.signal === CONTROL_SIGNALS.FALLBACK_CAPTIONS) emit(UI_EVENTS.DEGRADATION, { tier: 'captions', reason: frame.reason })
    }
  }

  /**
   * Attach to a live call. THE GATE: both flags or nothing happens at all.
   * `{ attached: false, reason }` is the complete flag-off behaviour.
   */
  function attach () {
    const f = flagsFn()
    if (f.liveVoice !== true || f.liveTranslation !== true) {
      return { attached: false, reason: 'flags-off (LIVE_VOICE_ENABLED && LIVE_TRANSLATION_ENABLED required)' }
    }
    if (session) return { attached: true, already: true }

    // Tap the local mic as a SECOND consumer: clone, never move or stop.
    const track = call?.local?.getAudioTracks?.()[0] || null
    if (track && typeof track.clone === 'function') {
      tappedTrack = track.clone()
      void applyLiveVoiceConstraints(tappedTrack) // best effort, clone only
    }

    session = sessionFactory({
      sessionId: `live:${selfId || 'self'}:${Math.floor(clock())}`,
      participants,
      adapters,
      flags: f,
      clock,
      deliver: onDelivery,
      playbackFor: (participantId) => (participantId === selfId && !mutedTranslated && !listenOriginalOnly ? player : { schedule: () => Promise.resolve() })
    })
    emit(UI_EVENTS.STATE, { state: 'attached', tapped: Boolean(tappedTrack) })
    return { attached: true, tapped: Boolean(tappedTrack) }
  }

  /** One utterance from a speaker (driven by VAD upstream). */
  async function speech (speakerId, input) {
    if (!session) throw new Error('call-integration: not attached')
    const r = await session.speech(speakerId, input)
    for (const leg of r.legs || []) {
      if (leg && leg.budget) {
        const snap = session.metrics()
        emit(UI_EVENTS.LATENCY, {
          utteranceId: r.utteranceId,
          measuredMs: leg.budget.measuredMs,
          withinBudget: leg.budget.withinBudget,
          p50: snap.stages.total?.p50 ?? null,
          p95: snap.stages.total?.p95 ?? null
        })
      }
      if (leg && typeof leg.mtConfidence === 'number') {
        emit(UI_EVENTS.CONFIDENCE, { utteranceId: r.utteranceId, confidence: leg.mtConfidence, targetLang: leg.targetLang })
      }
    }
    return r
  }

  /** Detach completely: end the session, stop the tapped clone, keep the call. */
  async function detach (reason = 'detached') {
    if (tappedTrack) { try { tappedTrack.stop() } catch { /* gone */ } tappedTrack = null }
    if (session) { await session.end(reason); session = null }
    emit(UI_EVENTS.STATE, { state: 'detached', reason })
    return { attached: false }
  }

  return {
    on,
    attach,
    detach,
    speech,
    get attached () { return Boolean(session) },
    get session () { return session },

    /* ------------------------------- controls (§9.5, the mission's list) */

    /** Mute the synthesized track locally; captions continue. */
    muteTranslated (onOff = true) {
      mutedTranslated = onOff === true
      emit(UI_EVENTS.STATE, { state: mutedTranslated ? 'muted-translated' : 'unmuted-translated' })
      return mutedTranslated
    },

    /** Listen to the original only (implies mute-translated; captions stay). */
    listenOriginal (onOff = true) {
      listenOriginalOnly = onOff === true
      emit(UI_EVENTS.STATE, { state: listenOriginalOnly ? 'listen-original' : 'listen-translated' })
      return listenOriginalOnly
    },

    /** Replay the last utterance (bounded, in-memory ring; never persisted). */
    replayLastUtterance () {
      if (!session) return null
      const r = session.replayFor(selfId)
      if (r) emit(UI_EVENTS.REPLAY, r)
      return r
    },

    /** Live language switch — next utterance fans out to the new language. */
    setListenLang (lang) {
      if (!session) throw new Error('call-integration: not attached')
      const out = session.setListenLang(selfId, lang)
      emit(UI_EVENTS.STATE, { state: 'listen-lang', lang })
      return out
    },

    /** Pin a speaker (UI focus + replay priority). Null unpins. */
    pinSpeaker (speakerId = null) {
      pinned = speakerId
      emit(UI_EVENTS.PINNED, { speakerId: pinned })
      return pinned
    },
    get pinnedSpeaker () { return pinned },

    /** Reconnect passthroughs (§8.5). */
    suspend: (reason) => { const s = session ? session.suspend(reason) : null; emit(UI_EVENTS.STATE, { state: 'suspended', reason }); return s },
    resume: () => { const s = session ? session.resume() : null; emit(UI_EVENTS.STATE, { state: 'resumed' }); return s }
  }
}
