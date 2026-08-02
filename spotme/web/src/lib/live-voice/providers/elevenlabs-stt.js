/**
 * Spot Me — ElevenLabs STREAMING STT adapter (IStreamingStt). ADR-011b, WS3
 * design §7.1/§7.2.
 *
 * PROTOCOL: the CHUNKED Scribe API. The mission's contract allows "scribe
 * websocket/chunked"; this adapter speaks the chunked wire because it is the
 * protocol this app already runs in production — `api/voice.js stt()` POSTs
 * `multipart/form-data { model_id: scribe_v1, file }` to
 * `https://api.elevenlabs.io/v1/speech-to-text` and reads `{ text,
 * language_code }`. Streaming here means VAD-CLOSED SUB-SEGMENTS: the session
 * layer hands this adapter an ordered list of segment audio chunks (each a
 * base64 data URL, exactly the shape `src/lib/voice.js blobToDataURL`
 * produces); each segment POSTs the moment it exists, its transcript is
 * emitted as a growing PARTIAL, and the joined transcript is the FINAL. First
 * response fires `onFirstToken` — the stt_partial latency mark. A Scribe
 * realtime-websocket variant remains open as a second registration once its
 * frame schema is verified against live docs (known-limitations doc).
 *
 * TWO REAL TRANSPORT MODES, one custody rule (keys stay server-side):
 *   direct — POST straight to ElevenLabs with the `xi-api-key` header from
 *            env (the api/voice.js `elHeaders()` pattern). LTMS/server role.
 *   proxy  — POST to our own authed proxy `/api/voice?op=stt` with JSON
 *            `{ audio: dataURL }` (the shipped `src/lib/voice.js call()`
 *            protocol). Client role; the proxy attaches the vendor key.
 *
 * INJECTABLE TRANSPORT: `fetchFn` substitutes a deterministic fake in tests;
 * production omits it and uses the real global — but ONLY when
 * STREAMING_PROVIDER_ENABLED is on (layered flag, default OFF). Every request
 * carries an AbortController timeout; `cancel()` aborts in-flight work.
 */

import { StreamingStatus, assertImplementsStreamingStt, normalizeHandlers } from '../streaming-interfaces.js'
import { isStreamingProviderEnabled } from '../flags.js'

/** The real REST endpoint (same constant family as api/voice.js EL_BASE). */
export const ELEVENLABS_STT_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
/** The model api/voice.js ships with — reused, not re-decided. */
export const ELEVENLABS_STT_MODEL = 'scribe_v1'

const DEFAULTS = Object.freeze({
  mode: 'direct',                 // 'direct' | 'proxy'
  proxyBase: '',                  // e.g. API_BASE; proxy mode posts `${proxyBase}/api/voice?op=stt`
  requestTimeoutMs: 10_000,       // per segment POST — bounded, always
  overallTimeoutMs: 45_000,       // whole utterance ceiling
  maxSegments: 64,                // bounded memory: an utterance is not a podcast
  maxAudioChars: 8_000_000        // same ceiling as api/voice.js MAX_AUDIO_CHARS
})

const CAPS = Object.freeze({
  partial: true, firstToken: true, cancel: true, streaming: true,
  provider: 'elevenlabs', role: 'stt', wire: 'scribe-chunked'
})

function envKeyProvider () {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.ELEVENLABS_API_KEY) {
      return process.env.ELEVENLABS_API_KEY
    }
  } catch { /* no process */ }
  return null
}

/** data URL → { blob, name } with the parameterised-mime lesson from voice.js. */
function dataUrlToPart (dataURL, maxChars) {
  if (typeof dataURL !== 'string' || dataURL.length > maxChars) throw new Error('elevenlabs stt: audio segment missing or too large')
  const match = /^data:([^,]*?);base64,(.+)$/.exec(dataURL)
  if (!match) throw new Error('elevenlabs stt: audio must be a base64 data URL')
  const type = match[1]
  const bin = typeof Buffer !== 'undefined'
    ? Buffer.from(match[2], 'base64')
    : Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
  const name = type.includes('ogg') ? 'audio.ogg' : type.includes('wav') ? 'audio.wav' : type.includes('mp4') ? 'audio.m4a' : type.includes('mpeg') || type.includes('mp3') ? 'audio.mp3' : 'audio.webm'
  return { blob: new Blob([bin], { type }), name }
}

/**
 * Create the streaming STT adapter.
 *
 * @param {{
 *   fetchFn?: typeof fetch, keyProvider?: () => string|null,
 *   authHeadersFn?: () => Promise<object>|object,   // proxy mode: bearer/JWT headers
 *   mode?: 'direct'|'proxy', proxyBase?: string,
 *   requestTimeoutMs?: number, overallTimeoutMs?: number,
 *   timers?: {setTimeout: Function, clearTimeout: Function}
 * }} [opts]
 */
export function createElevenLabsStreamingStt (opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const keyProvider = opts.keyProvider || envKeyProvider
  const timers = opts.timers || { setTimeout, clearTimeout }
  const injected = typeof opts.fetchFn === 'function'
  const fetchFn = injected ? opts.fetchFn : (...args) => fetch(...args)
  let status = StreamingStatus.IDLE

  async function postSegment (dataURL, lang, signal) {
    if (cfg.mode === 'proxy') {
      const extra = opts.authHeadersFn ? await opts.authHeadersFn() : {}
      const res = await fetchFn(`${cfg.proxyBase}/api/voice?op=stt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...extra },
        body: JSON.stringify({ audio: dataURL }),
        signal
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || json?.error) throw new Error(json?.error || `voice stt failed (${res.status})`)
      return { text: json.text || '', lang: json.lang || null }
    }
    // direct — the exact api/voice.js stt() upstream call.
    const { blob, name } = dataUrlToPart(dataURL, cfg.maxAudioChars)
    const form = new FormData()
    form.append('model_id', ELEVENLABS_STT_MODEL)
    if (lang && lang !== 'auto') form.append('language_code', lang)
    form.append('file', blob, name)
    const res = await fetchFn(ELEVENLABS_STT_URL, {
      method: 'POST',
      headers: { 'xi-api-key': keyProvider() || '' },
      body: form,
      signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`elevenlabs stt ${res.status}: ${text}`)
    }
    const json = await res.json()
    return { text: json.text || '', lang: json.language_code || null }
  }

  const adapter = {
    open () {
      if (!injected && !isStreamingProviderEnabled()) {
        status = StreamingStatus.FAILED
        return Promise.reject(new Error('elevenlabs stt: STREAMING_PROVIDER_ENABLED is off — real transport refused'))
      }
      if (!injected && cfg.mode === 'direct' && !keyProvider()) {
        status = StreamingStatus.FAILED
        return Promise.reject(new Error('elevenlabs stt: ELEVENLABS_API_KEY not configured'))
      }
      status = StreamingStatus.OPEN
      return Promise.resolve()
    },
    close () { status = StreamingStatus.CLOSED; return Promise.resolve() },
    status: () => status,
    capabilities: () => CAPS,

    /**
     * Transcribe one utterance. `input.audio` is an ordered array of base64
     * data-URL segments (VAD-closed sub-segments); each POSTs in order and the
     * growing transcript streams out as partials. `input.lang` pins the
     * language ('auto' → detect; detected language is sticky per §6.2.4 and is
     * reported in the final).
     */
    transcribe (input, handlers) {
      const h = normalizeHandlers(handlers)
      const segments = Array.isArray(input?.audio) ? input.audio.slice(0, cfg.maxSegments) : (input?.audio ? [input.audio] : [])
      const lang = input?.lang ?? 'auto'
      let cancelled = null
      const aborter = typeof AbortController === 'function' ? new AbortController() : null
      // The cancel race: even a transport that IGNORES the abort signal can
      // never hang this adapter — cancel/timeout settles the race instead.
      let unblock = null
      const unblocked = new Promise((resolve) => { unblock = resolve })
      status = StreamingStatus.STREAMING

      const done = (async () => {
        if (segments.length === 0) throw new Error('elevenlabs stt: no audio segments — this adapter transcribes audio, not scripts')
        const overallT = timers.setTimeout(() => { cancelled = cancelled || 'overall-timeout'; if (aborter) aborter.abort(); unblock({ timedOut: true }) }, cfg.overallTimeoutMs)
        try {
          const parts = []
          let detectedLang = lang
          for (let i = 0; i < segments.length; i++) {
            if (cancelled) return { cancelled }
            let requestT = null
            let raced
            try {
              // Per-request bound: the segment either answers inside the
              // window or the request aborts AND the race settles — never a
              // hung await, whatever the transport does.
              requestT = timers.setTimeout(() => { if (aborter) aborter.abort(); unblock({ timedOut: true }) }, cfg.requestTimeoutMs)
              raced = await Promise.race([
                postSegment(segments[i], detectedLang, aborter ? aborter.signal : undefined),
                unblocked
              ])
            } catch (e) {
              if (cancelled) return { cancelled }
              throw e
            } finally {
              if (requestT != null) timers.clearTimeout(requestT)
            }
            if (cancelled) return { cancelled }
            if (raced && raced.timedOut) throw new Error(`elevenlabs stt: segment ${i} exceeded ${cfg.requestTimeoutMs}ms bound`)
            if (raced.lang) detectedLang = raced.lang
            parts.push(raced.text)
            const acc = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
            if (i === 0) h.onFirstToken({ kind: 'partial', text: acc, lang: detectedLang })
            h.onPartial({ text: acc, lang: detectedLang, partial: true })
            if (cancelled) return { cancelled }
          }
          const text = parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
          const result = { text, lang: detectedLang, final: true }
          h.onFinal(result)
          status = StreamingStatus.OPEN
          return result
        } finally {
          timers.clearTimeout(overallT)
        }
      })().catch((e) => {
        status = StreamingStatus.FAILED
        h.onError(e)
        throw e
      })

      return {
        cancel: (reason = 'cancelled') => {
          cancelled = reason
          if (aborter) { try { aborter.abort() } catch { /* aborted */ } }
          unblock({ cancelled: reason })
        },
        done
      }
    }
  }

  assertImplementsStreamingStt(adapter, 'ElevenLabsStreamingStt')
  return adapter
}
