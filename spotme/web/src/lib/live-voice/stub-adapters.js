/**
 * Spot Me — deterministic STUB streaming adapters for live voice. ADR-011.
 *
 * These conform to IStreamingStt/Mt/Tts (streaming-interfaces.js) but call NO
 * real provider: no ElevenLabs, no translation endpoint, no network at all. They
 * exist so the orchestrator skeleton can run end-to-end in a unit test with a
 * fully deterministic result — the only way to test pipeline wiring, the state
 * machine, and the latency budget without a live cloud dependency or flakiness.
 *
 * DETERMINISM IS THE WHOLE POINT. Every stub:
 *   • derives its output purely from its input (a scripted transcript in, a
 *     tagged translation out, a synthetic audio token out) — same in, same out;
 *   • emits partials then a final across microtask ticks, so `cancel()` has a
 *     real gap to act in and barge-in is testable;
 *   • advances an INJECTED clock by a configured per-stage latency to SIMULATE
 *     provider time, so the latency budget measures real deltas without any wall
 *     clock. Swap the clock for a fake one and the arithmetic is reproducible.
 *
 * They are not a preview of the real providers' quality — they are a harness.
 * The real streaming providers are DEFERRED (see ADR-011 IMPLEMENTED vs
 * DEFERRED).
 */

import {
  StreamingStatus,
  assertImplementsStreamingStt,
  assertImplementsStreamingMt,
  assertImplementsStreamingTts,
  normalizeHandlers
} from './streaming-interfaces.js'

/** A manual clock for deterministic tests: `now()` reads, `advance(ms)` steps. */
export function makeManualClock (start = 0) {
  let t = start
  return {
    now: () => t,
    advance: (ms) => { t += ms; return t },
    reset: (to = 0) => { t = to }
  }
}

/* One microtask hop. `cancel()` called before the next hop resolves stops the
 * stream — a real, if tiny, window, which is exactly what makes barge-in
 * testable rather than theoretical. */
const tick = () => Promise.resolve()

function b64 (s) {
  // Node and browser both: produce base64 TEXT (frames.js requires text, not
  // binary). btoa where present, Buffer otherwise.
  try { if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(s))) } catch { /* fall through */ }
  return Buffer.from(s, 'utf8').toString('base64')
}

const CAPS = Object.freeze({ partial: true, firstToken: true, cancel: true, streaming: true, provider: 'stub' })

/**
 * Stub streaming STT. Input: `{ script, lang }` — the ground-truth transcript it
 * "hears". Emits a growing partial per word, then the full final. `lang` is
 * echoed back as the detected language (§6.2.4).
 */
export function createStubStreamingStt ({ clock, firstTokenMs = 400, finalMs = 300 } = {}) {
  let status = StreamingStatus.IDLE
  const adapter = {
    open () { status = StreamingStatus.OPEN; return Promise.resolve() },
    close () { status = StreamingStatus.CLOSED; return Promise.resolve() },
    status: () => status,
    capabilities: () => CAPS,
    transcribe (input, handlers) {
      const h = normalizeHandlers(handlers)
      const words = String(input?.script ?? '').trim().split(/\s+/).filter(Boolean)
      const lang = input?.lang ?? 'auto'
      let cancelled = null
      status = StreamingStatus.STREAMING
      const done = (async () => {
        await tick()
        if (cancelled) return { cancelled: cancelled }
        if (clock) clock.advance(firstTokenMs)
        let acc = ''
        for (let i = 0; i < words.length; i++) {
          acc = acc ? `${acc} ${words[i]}` : words[i]
          if (i === 0) h.onFirstToken({ kind: 'partial', text: acc, lang })
          h.onPartial({ text: acc, lang, partial: true })
          await tick()
          if (cancelled) return { cancelled }
        }
        if (clock) clock.advance(finalMs)
        const text = words.join(' ')
        const result = { text, lang, final: true }
        h.onFinal(result)
        status = StreamingStatus.OPEN
        return result
      })().catch((e) => { status = StreamingStatus.FAILED; h.onError(e); throw e })
      return { cancel: (reason = 'cancelled') => { cancelled = reason }, done }
    }
  }
  assertImplementsStreamingStt(adapter, 'StubStreamingStt')
  return adapter
}

/**
 * Stub streaming MT. Input: `{ text, sourceLang, targetLang }`. Deterministic
 * translation: an injected `phrasebook` map wins, else the text is tagged with
 * the target language so a test can assert an exact string. Emits per-word
 * partials then the final line.
 */
export function createStubStreamingMt ({ clock, mtMs = 250, phrasebook = null } = {}) {
  let status = StreamingStatus.IDLE
  const translateText = (text, targetLang) => {
    if (phrasebook && Object.prototype.hasOwnProperty.call(phrasebook, text)) return phrasebook[text]
    return `⟨${targetLang}⟩ ${text}`
  }
  const adapter = {
    open () { status = StreamingStatus.OPEN; return Promise.resolve() },
    close () { status = StreamingStatus.CLOSED; return Promise.resolve() },
    status: () => status,
    capabilities: () => CAPS,
    translate (input, handlers) {
      const h = normalizeHandlers(handlers)
      const text = String(input?.text ?? '')
      const targetLang = input?.targetLang ?? 'en'
      const full = translateText(text, targetLang)
      const words = full.split(/\s+/).filter(Boolean)
      let cancelled = null
      status = StreamingStatus.STREAMING
      const done = (async () => {
        await tick()
        if (cancelled) return { cancelled }
        if (clock) clock.advance(mtMs)
        let acc = ''
        for (let i = 0; i < words.length; i++) {
          acc = acc ? `${acc} ${words[i]}` : words[i]
          if (i === 0) h.onFirstToken({ kind: 'partial', text: acc, targetLang })
          h.onPartial({ text: acc, targetLang, partial: true })
          await tick()
          if (cancelled) return { cancelled }
        }
        const result = { text: full, targetLang, final: true }
        h.onFinal(result)
        status = StreamingStatus.OPEN
        return result
      })().catch((e) => { status = StreamingStatus.FAILED; h.onError(e); throw e })
      return { cancel: (reason = 'cancelled') => { cancelled = reason }, done }
    }
  }
  assertImplementsStreamingMt(adapter, 'StubStreamingMt')
  return adapter
}

/**
 * Stub streaming TTS. Input: `{ text, voiceId, targetLang }`. Emits `chunks`
 * synthetic base64 audio chunks; the first carries `firstAudio: true` — the
 * frame whose arrival is the first-audio latency (§6.5). Requires a `voiceId`
 * (the CONSENTED profile — §6.3/§6.4); with none, `synthesize` rejects rather
 * than inventing a voice.
 */
export function createStubStreamingTts ({ clock, firstAudioMs = 350, tailMs = 0, chunks = 3 } = {}) {
  let status = StreamingStatus.IDLE
  const adapter = {
    open () { status = StreamingStatus.OPEN; return Promise.resolve() },
    close () { status = StreamingStatus.CLOSED; return Promise.resolve() },
    status: () => status,
    capabilities: () => CAPS,
    synthesize (input, handlers) {
      const h = normalizeHandlers(handlers)
      const text = String(input?.text ?? '')
      const voiceId = input?.voiceId
      const targetLang = input?.targetLang ?? 'en'
      let cancelled = null
      status = StreamingStatus.STREAMING
      const done = (async () => {
        if (!voiceId) throw new Error('stub tts: voiceId (consented profile) required')
        await tick()
        if (cancelled) return { cancelled }
        const emitted = []
        for (let i = 0; i < chunks; i++) {
          if (i === 0 && clock) clock.advance(firstAudioMs)
          if (i > 0 && clock) clock.advance(tailMs)
          const chunk = b64(`tts:${voiceId}:${targetLang}:${i}:${text}`)
          const frame = { chunk, index: i, firstAudio: i === 0, final: i === chunks - 1 }
          if (i === 0) h.onFirstToken({ kind: 'audio', ...frame })
          h.onPartial(frame)
          emitted.push(chunk)
          await tick()
          if (cancelled) return { cancelled }
        }
        const result = { chunks: emitted, voiceId, targetLang, final: true }
        h.onFinal(result)
        status = StreamingStatus.OPEN
        return result
      })().catch((e) => { status = StreamingStatus.FAILED; h.onError(e); throw e })
      return { cancel: (reason = 'cancelled') => { cancelled = reason }, done }
    }
  }
  assertImplementsStreamingTts(adapter, 'StubStreamingTts')
  return adapter
}

/**
 * Stub optional LLM corrector. Not a streaming interface — the correction pass
 * is optional (§6.2, CORRECTING is a skippable state). Deterministic: trims and,
 * if given a `fixups` map, applies exact replacements. Advances the clock.
 */
export function createStubCorrector ({ clock, correctMs = 150, fixups = null } = {}) {
  return {
    correct ({ text }) {
      if (clock) clock.advance(correctMs)
      let out = String(text ?? '').replace(/\s+/g, ' ').trim()
      if (fixups && Object.prototype.hasOwnProperty.call(fixups, out)) out = fixups[out]
      return Promise.resolve({ text: out })
    }
  }
}

/**
 * Stub playback sink. Collects scheduled audio chunks in order and advances the
 * clock by the schedule cost. Real playback buffers to preserve conversational
 * order (§6.2.7); the stub only needs to prove the orchestrator hands it chunks
 * in sequence.
 */
export function createStubPlayback ({ clock, scheduleMs = 30 } = {}) {
  const scheduled = []
  return {
    schedule (chunk) {
      if (clock) clock.advance(scheduleMs)
      scheduled.push(chunk)
      return Promise.resolve()
    },
    get scheduled () { return scheduled.slice() }
  }
}
