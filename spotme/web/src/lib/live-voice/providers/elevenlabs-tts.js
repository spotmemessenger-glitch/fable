/**
 * Spot Me — ElevenLabs STREAMING TTS adapter (IStreamingTts). ADR-011b, WS3
 * design §7.1/§7.2.
 *
 * This speaks the REAL ElevenLabs input-streaming WebSocket protocol —
 * `wss://api.elevenlabs.io/v1/text-to-speech/{voiceId}/stream-input` — the
 * streaming form of the exact REST call the shipped voice-note path makes in
 * `api/voice.js tts()` (`POST /v1/text-to-speech/{voiceId}`). Same provider,
 * same consented clone `voiceId`, same server-side-key custody; different wire
 * so first audio arrives before the sentence is finished (§4 of the design:
 * TTS first-audio is the second dominant latency term).
 *
 * WIRE PROTOCOL (documented ElevenLabs stream-input framing):
 *   → BOS   { text: " ", voice_settings, generation_config }
 *   → text  { text: "chunk ", try_trigger_generation: true }   (trailing space)
 *   → EOS   { text: "" }
 *   ← audio { audio: "<base64>", isFinal: null, normalizedAlignment, alignment }
 *   ← final { isFinal: true }
 *
 * KEY CUSTODY — THE api/voice.js PATTERN, UNCHANGED. The `xi-api-key` header
 * goes on the WebSocket HANDSHAKE, which means this adapter's real transport
 * can only run where the key lives: server-side (the LTMS role), exactly as
 * `elHeaders()` does for the batch proxy. There is NO client-bundle key path:
 * a browser WebSocket cannot even set the header. `keyProvider` is a function
 * so the key is read at open-time from env, never captured in module state.
 *
 * INJECTABLE TRANSPORT. `wsFactory(url, {headers})` builds the socket. Tests
 * inject a deterministic fake and assert the exact frames; production omits it
 * and gets the real constructor — but ONLY when STREAMING_PROVIDER_ENABLED is
 * on (flags.js, layered, default OFF). Flag off + no injected transport =
 * open() refuses. No network can happen by accident.
 *
 * EVERY PATH IS BOUNDED: connect, first-audio, inactivity, and overall
 * deadlines, all cancellable. `cancel()` is the barge-in seam (§8.4): it
 * closes the socket, so ElevenLabs stops synthesizing and billing.
 */

import { StreamingStatus, assertImplementsStreamingTts, normalizeHandlers } from '../streaming-interfaces.js'
import { isStreamingProviderEnabled } from '../flags.js'
import { mapProsodyToVoiceSettings } from './prosody.js'

/** The real endpoint template. Exported so tests pin the exact URL built. */
export const ELEVENLABS_TTS_WS_BASE = 'wss://api.elevenlabs.io/v1/text-to-speech'

/**
 * Streaming-capable models, best-latency first. The batch path's `eleven_v3`
 * is NOT in this list: it does not serve the stream-input websocket; Flash and
 * Turbo are ElevenLabs' documented realtime models (design §4 lever 2, §18.2
 * "TTS default: Flash/Turbo, expressive on headroom").
 */
export const ELEVENLABS_TTS_STREAM_MODELS = Object.freeze([
  'eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'
])

/** mp3 output keeps the frames.js default codec ('mp3') true on the wire. */
export const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_64'

const DEFAULTS = Object.freeze({
  model: ELEVENLABS_TTS_STREAM_MODELS[0],
  outputFormat: DEFAULT_OUTPUT_FORMAT,
  connectTimeoutMs: 5_000,
  firstAudioTimeoutMs: 8_000,
  inactivityTimeoutMs: 10_000,
  overallTimeoutMs: 60_000,
  maxTextChars: 2_500 // same ceiling as api/voice.js MAX_TTS_CHARS
})

const CAPS = Object.freeze({
  partial: true, firstToken: true, cancel: true, streaming: true,
  provider: 'elevenlabs', role: 'tts', wire: 'websocket-stream-input'
})

/** Build the exact stream-input URL for a voice/model/format triple. */
export function buildTtsStreamUrl ({ voiceId, model = DEFAULTS.model, outputFormat = DEFAULTS.outputFormat, baseUrl = ELEVENLABS_TTS_WS_BASE }) {
  if (!/^[A-Za-z0-9]{8,64}$/.test(String(voiceId || ''))) throw new Error('elevenlabs tts: voiceId must be a valid ElevenLabs id')
  const q = new URLSearchParams({ model_id: model, output_format: outputFormat })
  return `${baseUrl}/${voiceId}/stream-input?${q.toString()}`
}

/* The default key provider: env only, read at call time — the elHeaders()
 * custody rule from api/voice.js, verbatim in spirit. */
function envKeyProvider () {
  try {
    if (typeof process !== 'undefined' && process.env && process.env.ELEVENLABS_API_KEY) {
      return process.env.ELEVENLABS_API_KEY
    }
  } catch { /* no process */ }
  return null
}

/* Split text into websocket-sized chunks on word boundaries. ElevenLabs wants
 * chunks ending in a space; the final flush closes the stream. */
export function chunkTextForStreaming (text, maxLen = 120) {
  const words = String(text || '').split(/\s+/).filter(Boolean)
  const chunks = []
  let acc = ''
  for (const w of words) {
    if (acc && (acc.length + w.length + 1) > maxLen) { chunks.push(acc + ' '); acc = w } else { acc = acc ? `${acc} ${w}` : w }
  }
  if (acc) chunks.push(acc + ' ')
  return chunks
}

/**
 * Create the streaming TTS adapter.
 *
 * @param {{
 *   wsFactory?: (url: string, opts: {headers: object}) => WebSocketLike,
 *   keyProvider?: () => string|null,
 *   clock?: {now: () => number}|null,
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   model?: string, outputFormat?: string, baseUrl?: string,
 *   connectTimeoutMs?: number, firstAudioTimeoutMs?: number,
 *   inactivityTimeoutMs?: number, overallTimeoutMs?: number
 * }} [opts]
 */
export function createElevenLabsStreamingTts (opts = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const keyProvider = opts.keyProvider || envKeyProvider
  const timers = opts.timers || { setTimeout, clearTimeout }
  const injected = typeof opts.wsFactory === 'function'
  let status = StreamingStatus.IDLE

  function realWsFactory (url, { headers }) {
    // Server-side only: Node's undici WebSocket (>=22) accepts headers; a
    // browser WebSocket cannot, and must go through the server proxy instead.
    if (typeof WebSocket !== 'function') throw new Error('elevenlabs tts: no WebSocket implementation available')
    return new WebSocket(url, { headers })
  }

  const wsFactory = injected ? opts.wsFactory : realWsFactory

  const adapter = {
    open () {
      // THE GATE: a real (non-injected) transport may only be constructed when
      // the layered flag says so. Tests inject fakes and are unaffected.
      if (!injected && !isStreamingProviderEnabled()) {
        status = StreamingStatus.FAILED
        return Promise.reject(new Error('elevenlabs tts: STREAMING_PROVIDER_ENABLED is off — real transport refused'))
      }
      if (!injected && !keyProvider()) {
        status = StreamingStatus.FAILED
        return Promise.reject(new Error('elevenlabs tts: ELEVENLABS_API_KEY not configured'))
      }
      status = StreamingStatus.OPEN
      return Promise.resolve()
    },
    close () { status = StreamingStatus.CLOSED; return Promise.resolve() },
    status: () => status,
    capabilities: () => CAPS,

    /**
     * Synthesize `input.text` in `input.voiceId` (the CONSENTED clone — §6.4)
     * over one stream-input session. `input.prosody` maps via prosody.js.
     * Emits base64 audio chunks through `onPartial`; first chunk carries
     * `firstAudio: true` and fires `onFirstToken`.
     */
    synthesize (input, handlers) {
      const h = normalizeHandlers(handlers)
      const text = String(input?.text ?? '').slice(0, cfg.maxTextChars)
      const voiceId = input?.voiceId
      const targetLang = input?.targetLang ?? 'en'
      let cancelled = null
      let ws = null
      const pendingTimers = new Set()
      const arm = (ms, fn) => { const t = timers.setTimeout(fn, ms); pendingTimers.add(t); return t }
      const disarmAll = () => { for (const t of pendingTimers) timers.clearTimeout(t); pendingTimers.clear() }

      status = StreamingStatus.STREAMING
      const done = new Promise((resolve, reject) => {
        if (!voiceId) { status = StreamingStatus.FAILED; reject(new Error('elevenlabs tts: voiceId (consented profile) required — never invent a voice')); return }
        let url
        try { url = buildTtsStreamUrl({ voiceId, model: cfg.model, outputFormat: cfg.outputFormat, baseUrl: cfg.baseUrl }) } catch (e) { status = StreamingStatus.FAILED; reject(e); return }

        const emitted = []
        let index = 0
        let settled = false
        const finish = (fn, v) => {
          if (settled) return
          settled = true
          disarmAll()
          try { if (ws && ws.readyState === 1) ws.close() } catch { /* closed */ }
          status = fn === resolve ? StreamingStatus.OPEN : StreamingStatus.FAILED
          fn(v)
        }
        const fail = (err) => { h.onError(err); finish(reject, err) }
        const cancelOut = () => finish(resolve, { cancelled })

        try {
          ws = wsFactory(url, { headers: { 'xi-api-key': keyProvider() || '' } })
        } catch (e) { fail(e); return }

        const overall = arm(cfg.overallTimeoutMs, () => fail(new Error(`elevenlabs tts: overall deadline ${cfg.overallTimeoutMs}ms exceeded`)))
        let idle = arm(cfg.connectTimeoutMs, () => fail(new Error(`elevenlabs tts: connect timeout ${cfg.connectTimeoutMs}ms`)))
        const rearmIdle = (ms) => { timers.clearTimeout(idle); pendingTimers.delete(idle); idle = arm(ms, () => fail(new Error(`elevenlabs tts: stream idle > ${ms}ms`))) }

        ws.onopen = () => {
          if (cancelled) { cancelOut(); return }
          rearmIdle(cfg.firstAudioTimeoutMs)
          const voiceSettings = mapProsodyToVoiceSettings(input?.prosody)
          // BOS — a single space, per the protocol, carrying the settings.
          ws.send(JSON.stringify({ text: ' ', voice_settings: voiceSettings, generation_config: { chunk_length_schedule: [120, 160, 250, 290] } }))
          for (const chunk of chunkTextForStreaming(text)) {
            ws.send(JSON.stringify({ text: chunk, try_trigger_generation: true }))
          }
          ws.send(JSON.stringify({ text: '' })) // EOS
        }

        ws.onmessage = (ev) => {
          if (cancelled) { cancelOut(); return }
          let msg
          try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return /* non-JSON frame: ignore */ }
          if (msg.error) { fail(new Error(`elevenlabs tts: ${msg.error}`)); return }
          if (typeof msg.audio === 'string' && msg.audio.length > 0) {
            rearmIdle(cfg.inactivityTimeoutMs)
            const frame = {
              chunk: msg.audio, // base64 TEXT — the frames.js pinned lesson
              index,
              firstAudio: index === 0,
              final: msg.isFinal === true,
              alignment: msg.normalizedAlignment || msg.alignment || null
            }
            if (index === 0) h.onFirstToken({ kind: 'audio', ...frame })
            h.onPartial(frame)
            emitted.push(msg.audio)
            index += 1
          }
          if (msg.isFinal === true) {
            const result = { chunks: emitted, voiceId, targetLang, final: true }
            h.onFinal(result)
            finish(resolve, result)
          }
        }

        ws.onerror = (err) => fail(err instanceof Error ? err : new Error(`elevenlabs tts: socket error${err?.message ? `: ${err.message}` : ''}`))
        ws.onclose = () => {
          if (settled) return
          if (cancelled) { cancelOut(); return }
          if (emitted.length > 0) {
            // Server closed after audio without an isFinal marker — treat what
            // we have as the final result rather than dropping played audio.
            const result = { chunks: emitted, voiceId, targetLang, final: true, closedEarly: true }
            h.onFinal(result)
            finish(resolve, result)
          } else {
            fail(new Error('elevenlabs tts: socket closed before any audio'))
          }
        }
        void overall
      })

      return {
        cancel: (reason = 'cancelled') => {
          cancelled = reason
          try { if (ws) ws.close() } catch { /* already closed */ }
        },
        done
      }
    }
  }

  assertImplementsStreamingTts(adapter, 'ElevenLabsStreamingTts')
  return adapter
}
