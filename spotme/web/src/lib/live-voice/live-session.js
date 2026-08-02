/**
 * Spot Me — the LiveVoiceSession manager. WS3 design §6/§8/§11, ADR-011b.
 *
 * One object owns a whole translated conversation: the per-direction
 * pipelines of a 1:1 call, or the per-speaker × per-distinct-language fan-out
 * of a group — built ON the scaffold's orchestrator and state machines, not
 * beside them. Each utterance runs the proven STT→MT→(LLM)→TTS→playback
 * pipeline; this layer adds what a CALL needs around it:
 *
 *   SHARED STT      one transcription per speaker per utterance, fanned to
 *                   every leg (shared-stt.js; §6.3).
 *   FAN-OUT         legs per DISTINCT listen-language (fanout.js); same-
 *                   language listeners get original captions; the speaker
 *                   gets nothing added.
 *   BARGE-IN        new speech from a speaker cancels their in-flight
 *                   utterance's every leg mid-stream (§8.4).
 *   ORDERING        captions always lead audio (pipeline order), and legs
 *                   deliver per-listener so no listener sees another's lane.
 *   LADDER          the degradation ladder decides, per utterance, whether
 *                   voice or only captions or nothing is attempted; outcomes
 *                   feed back (over-budget/dropped → breach; clean → clean).
 *   RECONNECT       suspend() cancels in-flight and marks the session
 *                   DEGRADED; resume() re-activates with per-speaker cursors
 *                   (§8.5 — live-only resume, no backfill).
 *   ACCOUNTING      every leg's latency-budget report folds into the
 *                   p50/p95/p99 aggregator (metrics.js).
 *
 * GROUP MEDIA IS A DECLARED DEPENDENCY, NOT A FAKE. The fan-out, addressing
 * and delivery envelopes here are real session logic over injected playback
 * sinks. Actually moving group audio between >2 devices needs the group-call
 * media plane (roadmap Priority 5) and is documented as blocked on it —
 * nothing here pretends to be an SFU.
 *
 * DELIVERIES, NOT BARE FRAMES. Every emission is `{ to: [participantIds],
 * frame }` — the wire frames stay exactly the scaffold's validated schemas;
 * addressing rides the envelope. No audio or transcript is retained beyond
 * the bounded one-utterance replay ring the UI's replay control reads.
 */

import { createLiveVoiceOrchestrator } from './orchestrator.js'
import { createSessionMachine, SESSION_STATES as S } from './session-state.js'
import { beginSharedSttUtterance } from './shared-stt.js'
import { fanoutForUtterance } from './fanout.js'
import { createDegradationLadder } from './quality/degradation-ladder.js'
import { createLatencyAggregator } from './metrics.js'
import { makeControlFrame, makePartialCaptionFrame, CONTROL_SIGNALS } from './frames.js'
import { STRICT_PRIVACY_REFUSAL } from './mt-stage.js'

/**
 * A neutral, LABELLED ElevenLabs premade voice for consented speakers with no
 * clone (or when VOICE_CLONE_ENABLED is off): "Rachel", the default premade
 * voice every ElevenLabs account carries. Deliveries using it say
 * `voice: 'generic'` — never a silent substitution, never someone else's
 * clone (§5.1).
 */
export const NEUTRAL_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'

const MODES = Object.freeze({ VOICE: 'voice', CAPTIONS: 'captions', ORIGINAL: 'original' })

/**
 * @param {{
 *   sessionId: string,
 *   participants: Array<{id, listenLang, speakLang?, voiceId?, consented?}>,
 *   adapters: { stt, mt, tts, corrector? },   // IStreaming* (chains welcome)
 *   playbackFor?: (participantId) => { schedule: Function },
 *   deliver?: (delivery) => void,             // { to, frame } sink
 *   flags: { liveTranslation?: boolean, voiceClone?: boolean,
 *            liveCaptions?: boolean, groupTranslation?: boolean },
 *   ladder?: object, aggregator?: object, clock?: () => number,
 *   neutralVoiceId?: string|null
 * }} opts
 */
export function createLiveVoiceSession (opts = {}) {
  const {
    sessionId, participants = [], adapters = {}, flags = {},
    neutralVoiceId = NEUTRAL_VOICE_ID
  } = opts
  if (!sessionId || typeof sessionId !== 'string') throw new Error('live-session: sessionId required')
  if (!adapters.stt || !adapters.mt || !adapters.tts) throw new Error('live-session: stt, mt and tts adapters are required')
  if (participants.length < 2) throw new Error('live-session: at least two participants')
  if (participants.length > 2 && flags.groupTranslation !== true) {
    throw new Error('live-session: >2 participants requires GROUP_TRANSLATION_ENABLED (and group media is blocked on Priority-5 infra)')
  }
  if (flags.liveTranslation !== true && flags.liveCaptions !== true) {
    throw new Error('live-session: nothing enabled — need LIVE_TRANSLATION_ENABLED and/or LIVE_CAPTIONS_ENABLED')
  }

  const clock = opts.clock || (() => Date.now())
  const deliver = typeof opts.deliver === 'function' ? opts.deliver : () => {}
  const playbackFor = typeof opts.playbackFor === 'function' ? opts.playbackFor : () => ({ schedule: () => Promise.resolve() })
  const ladder = opts.ladder || createDegradationLadder({ clock: { now: clock } })
  const aggregator = opts.aggregator || createLatencyAggregator()
  const machine = createSessionMachine({ clock })
  machine.to(S.ACTIVE)

  const byId = new Map(participants.map((p) => [p.id, p]))
  const active = new Map()        // speakerId -> [{ cancel }] in-flight leg handles
  const cursors = new Map()       // speakerId -> completed utterance count
  const replayRing = new Map()    // listenerId -> last utterance { captions, audio } (BOUNDED: 1)
  let utteranceSeq = 0
  let strictRefused = false
  let mtOpened = false
  let controlSeq = 0

  const control = (signal, reason, to) => deliver({
    to,
    frame: makeControlFrame({ sessionId, utteranceId: 'session', seq: controlSeq++, t: clock(), signal, reason })
  })

  async function ensureMtOpen () {
    if (mtOpened || strictRefused) return
    try { await adapters.mt.open(); mtOpened = true } catch (e) {
      if (String(e?.message || e).startsWith('strict-privacy')) {
        strictRefused = true
        control(CONTROL_SIGNALS.FALLBACK_CAPTIONS, STRICT_PRIVACY_REFUSAL, participants.map((p) => p.id))
      } else { throw e }
    }
  }

  /** What may THIS utterance attempt, given flags + ladder + privacy?
   *  strict privacy, translation off, or a ladder at ORIGINAL_ONLY → original
   *  captions; ladder at CAPTIONS_ONLY → translated captions, no voice. */
  function modeNow () {
    const allow = ladder.allows()
    if (strictRefused || flags.liveTranslation !== true || !allow.translatedCaptions) return MODES.ORIGINAL
    if (!allow.voice) return MODES.CAPTIONS
    return MODES.VOICE
  }

  function voiceFor (speaker) {
    if (flags.voiceClone === true && speaker.consented === true && speaker.voiceId) {
      return { voiceId: speaker.voiceId, voice: 'clone' }
    }
    return neutralVoiceId ? { voiceId: neutralVoiceId, voice: 'generic' } : { voiceId: null, voice: 'none' }
  }

  function rememberReplay (listenerId, utteranceId, kind, payload) {
    let slot = replayRing.get(listenerId)
    if (!slot || slot.utteranceId !== utteranceId) {
      slot = { utteranceId, captions: [], audio: [] }
      replayRing.set(listenerId, slot) // ONE utterance per listener — bounded
    }
    const arr = kind === 'audio' ? slot.audio : slot.captions
    arr.push(payload)
    if (arr.length > 64) arr.shift() // hard cap even within one utterance
  }

  /**
   * One utterance from `speakerId`. `input`: `{ script?, audio?, sourceLang }`
   * (`script` drives deterministic tests; `audio` is the VAD-segment list the
   * real STT adapter posts). Resolves `{ utteranceId, legs: [legResult] }`.
   */
  async function speech (speakerId, input = {}) {
    if (machine.state !== S.ACTIVE) throw new Error(`live-session: not active (${machine.state})`)
    const speaker = byId.get(speakerId)
    if (!speaker) throw new Error(`live-session: unknown speaker "${speakerId}"`)

    bargeIn(speakerId, 'new-speech') // §8.4: new speech supersedes in-flight
    // Register the utterance TOKEN synchronously — a barge-in arriving during
    // the async setup below must still be able to supersede this utterance.
    const token = { cancelled: null, handles: [] }
    active.set(speakerId, token)

    await ensureMtOpen()

    // STRICT PRIVACY REFUSES THE WHOLE PIPELINE, not just MT: captions come
    // from cloud STT, so "no live translation" must mean no audio leaves at
    // all. The utterance is refused, nothing is transcribed, the original
    // E2E call carries on untouched (mission: strict = on-device/none).
    if (strictRefused) {
      if (active.get(speakerId) === token) active.delete(speakerId)
      return { utteranceId: null, mode: 'refused', legs: [], reason: STRICT_PRIVACY_REFUSAL }
    }

    const sourceLang = input.sourceLang || speaker.speakLang
    if (!sourceLang || sourceLang === 'auto') throw new Error('live-session: sourceLang must be supplied or resolved upstream')
    const utteranceId = `${sessionId}:${speakerId}:u${++utteranceSeq}`
    const mode = modeNow()
    const fan = fanoutForUtterance(participants, speakerId, sourceLang)
    const extra = {}
    if (input.audio) extra.audio = input.audio
    if (input.script != null) extra.script = input.script
    const shared = beginSharedSttUtterance(adapters.stt, extra)

    // Same-language listeners: original captions only, from the SHARED pass.
    const captionLegs = fan.captionOnly.map((c) => runOriginalCaptions(shared, speakerId, utteranceId, sourceLang, c.listeners, token))

    // Original-only mode: every listener gets original captions; no MT/TTS.
    const translateLegs = mode === MODES.ORIGINAL
      ? fan.legs.map((leg) => runOriginalCaptions(shared, speakerId, utteranceId, sourceLang, leg.listeners, token))
      : fan.legs.map((leg) => runTranslatedLeg({ shared, speaker, utteranceId, sourceLang, leg, mode, token, script: input.script }))

    const results = await Promise.all([...translateLegs, ...captionLegs])
    if (active.get(speakerId) === token) active.delete(speakerId)
    // The resume cursor counts DELIVERED utterances only (§8.5 "last
    // acknowledged") — a superseded or dropped one was never fully heard.
    const delivered = results.some((r) => r && (r.completed === true || r.fallback === true ||
      (r.captionsOnly === true && !r.cancelled && !r.dropped)))
    if (delivered) cursors.set(speakerId, (cursors.get(speakerId) || 0) + 1)

    // Ladder feedback: any leg over-budget/dropped is a breach; all clean is clean.
    const breached = results.find((r) => r && (r.dropped || (r.budget && r.budget.withinBudget === false)))
    if (breached) ladder.recordBreach(breached.dropped ? 'leg-dropped' : 'over-budget')
    else ladder.recordClean()

    return { utteranceId, mode, legs: results }
  }

  /** A translated fan-out leg: full pipeline to every listener of one language. */
  function runTranslatedLeg ({ shared, speaker, utteranceId, sourceLang, leg, mode, token, script }) {
    const to = leg.listeners
    const { voiceId, voice } = mode === MODES.VOICE ? voiceFor(speaker) : { voiceId: null, voice: 'none' }
    const playback = { schedule: (chunk) => Promise.all(to.map((id) => playbackFor(id).schedule(chunk))) }
    const orch = createLiveVoiceOrchestrator({
      stt: shared.legAdapter(),
      mt: adapters.mt,
      tts: adapters.tts,
      corrector: adapters.corrector || null,
      playback,
      clock,
      emit: (frame) => {
        deliver({ to, frame, speakerId: speaker.id, targetLang: leg.targetLang, voice })
        for (const id of to) {
          if (frame.type === 'partial-caption') rememberReplay(id, utteranceId, 'caption', frame)
          if (frame.type === 'translated-audio-out') rememberReplay(id, utteranceId, 'audio', frame)
        }
        return frame
      }
    })
    const h = orch.start({
      sessionId,
      utteranceId,
      script,
      sourceLang,
      targetLang: leg.targetLang,
      voiceProfileId: voiceId
    })
    token.handles.push(h)
    if (token.cancelled) { try { h.cancel(token.cancelled) } catch { /* done */ } }
    return h.done.then((r) => {
      aggregator.record(r.budget)
      return { ...r, targetLang: leg.targetLang, listeners: to, voice }
    })
  }

  /** Original-language captions from the shared STT pass (no MT, no TTS). */
  function runOriginalCaptions (shared, speakerId, utteranceId, sourceLang, to, token) {
    return new Promise((resolve) => {
      let seq = 0
      const leg = shared.legAdapter()
      const emitCaption = (text, partial) => {
        if (!text) return
        const frame = makePartialCaptionFrame({
          sessionId, utteranceId, seq: seq++, t: clock(), sourceLang, text, partial
        })
        deliver({ to, frame, speakerId, targetLang: null, voice: 'none' })
        for (const id of to) rememberReplay(id, utteranceId, 'caption', frame)
      }
      const ctrl = leg.transcribe({ lang: sourceLang }, {
        onPartial: ({ text }) => emitCaption(text, true),
        onFinal: ({ text }) => emitCaption(text, false)
      })
      token.handles.push(ctrl)
      if (token.cancelled) { try { ctrl.cancel(token.cancelled) } catch { /* done */ } }
      ctrl.done.then(
        (r) => resolve({ captionsOnly: true, listeners: to, transcript: r?.text ?? null, cancelled: r?.cancelled, interrupted: Boolean(r?.cancelled) }),
        (e) => resolve({ captionsOnly: true, listeners: to, dropped: true, error: String(e?.message || e) })
      )
    })
  }

  /** Cancel a speaker's in-flight utterance across all legs (§8.4). */
  function bargeIn (speakerId, reason = 'barge-in') {
    const token = active.get(speakerId)
    if (!token) return false
    token.cancelled = reason
    for (const h of token.handles) { try { h.cancel(reason) } catch { /* done */ } }
    active.delete(speakerId)
    return true
  }

  /** Network drop / app background: cancel everything, mark DEGRADED. */
  function suspend (reason = 'reconnect') {
    if (machine.state !== S.ACTIVE) return machine.state
    for (const id of [...active.keys()]) bargeIn(id, reason)
    machine.to(S.DEGRADED, { reason })
    control(CONTROL_SIGNALS.FALLBACK_CAPTIONS, `suspended:${reason}`, participants.map((p) => p.id))
    return machine.state
  }

  /** Resume after a drop. Live-only: cursors say where we were; no backfill. */
  function resume () {
    if (machine.state !== S.DEGRADED) return { state: machine.state, cursors: cursor() }
    machine.to(S.ACTIVE, { reason: 'resumed' })
    control(CONTROL_SIGNALS.START, 'resumed', participants.map((p) => p.id))
    return { state: machine.state, cursors: cursor() }
  }

  function cursor () {
    return Object.fromEntries([...cursors.entries()])
  }

  /**
   * Live language switch (§9.5 `lang.change`): the NEXT utterance's fan-out
   * uses the new listen language; nothing renegotiates, nothing restarts.
   */
  function setListenLang (participantId, listenLang) {
    const p = byId.get(participantId)
    if (!p) throw new Error(`live-session: unknown participant "${participantId}"`)
    if (typeof listenLang !== 'string' || !listenLang) throw new Error('live-session: listenLang required')
    p.listenLang = listenLang
    return { participantId, listenLang }
  }

  async function end (reason = 'ended') {
    for (const id of [...active.keys()]) bargeIn(id, reason)
    if (machine.can(S.ENDED)) machine.to(S.ENDED, { reason })
    control(CONTROL_SIGNALS.STOP, reason, participants.map((p) => p.id))
    replayRing.clear()
    try { await Promise.all([adapters.stt.close(), adapters.mt.close(), adapters.tts.close()]) } catch { /* closing */ }
  }

  return {
    sessionId,
    get state () { return machine.state },
    get strictRefused () { return strictRefused },
    speech,
    bargeIn,
    suspend,
    resume,
    cursor,
    setListenLang,
    end,
    /** The bounded last-utterance replay for a listener (UI replay control). */
    replayFor: (listenerId) => {
      const slot = replayRing.get(listenerId)
      return slot ? { utteranceId: slot.utteranceId, captions: slot.captions.slice(), audio: slot.audio.slice() } : null
    },
    metrics: () => aggregator.snapshot(),
    ladder: () => ({ tier: ladder.tier, allows: ladder.allows(), moves: ladder.moves() }),
    participants: () => participants.map((p) => ({ ...p }))
  }
}

export { MODES as SESSION_MODES }
