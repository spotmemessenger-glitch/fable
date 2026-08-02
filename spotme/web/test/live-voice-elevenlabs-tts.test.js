/**
 * ElevenLabs streaming TTS adapter — the REAL stream-input websocket protocol
 * over an injected fake socket (ADR-011b §providers).
 *
 * Pins: the exact URL (voice, model, output format), header custody
 * (`xi-api-key` on the handshake — server-side only), the BOS/text/EOS
 * message framing with voice_settings from the prosody mapping, base64 audio
 * chunk emission with firstAudio/final marks + alignment passthrough,
 * cancel-closes-socket (barge-in stops billing), bounded connect/idle
 * deadlines, and the flag refusal. Plus the prosody mapping itself.
 *
 *   node test/live-voice-elevenlabs-tts.test.js
 */
import {
  createElevenLabsStreamingTts, buildTtsStreamUrl, chunkTextForStreaming,
  ELEVENLABS_TTS_WS_BASE, ELEVENLABS_TTS_STREAM_MODELS
} from '../src/lib/live-voice/providers/elevenlabs-tts.js'
import { mapProsodyToVoiceSettings, isLegalVoiceSettings, SPEED_RANGE } from '../src/lib/live-voice/providers/prosody.js'
import { assertImplementsStreamingTts } from '../src/lib/live-voice/streaming-interfaces.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const VOICE = 'VOICEclone12345'

/** A scripted fake stream-input socket. */
function fakeWsFactory ({ audioChunks = ['QUJD', 'REVG'], sendFinal = true, failOnOpen = false, silent = false } = {}) {
  const record = { url: null, headers: null, sent: [], closed: 0 }
  const factory = (url, { headers }) => {
    record.url = url
    record.headers = headers
    const ws = {
      readyState: 0,
      send: (s) => { record.sent.push(JSON.parse(s)) },
      close: () => { record.closed += 1; ws.readyState = 3; if (ws.onclose) queueMicrotask(() => ws.onclose()) },
      onopen: null, onmessage: null, onerror: null, onclose: null
    }
    queueMicrotask(() => {
      if (failOnOpen) { ws.onerror && ws.onerror(new Error('handshake refused')); return }
      ws.readyState = 1
      ws.onopen && ws.onopen()
      if (silent) return // never sends audio — the idle deadline must fire
      queueMicrotask(() => {
        let i = 0
        for (const a of audioChunks) {
          ws.onmessage && ws.onmessage({ data: JSON.stringify({ audio: a, isFinal: null, normalizedAlignment: { chars: ['a'], charStartTimesMs: [i * 100] } }) })
          i += 1
        }
        if (sendFinal) ws.onmessage && ws.onmessage({ data: JSON.stringify({ isFinal: true }) })
        else ws.close()
      })
    })
    return ws
  }
  return { factory, record }
}

/* -------- URL + framing -------- */
await checkAsync('conforms to IStreamingTts (with fake transport)', async () => {
  const { factory } = fakeWsFactory()
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  assertImplementsStreamingTts(tts, 'el-tts')
  return true
})
await checkAsync('builds the real stream-input URL with model + output format', async () => {
  const url = buildTtsStreamUrl({ voiceId: VOICE })
  return url === `${ELEVENLABS_TTS_WS_BASE}/${VOICE}/stream-input?model_id=eleven_flash_v2_5&output_format=mp3_44100_64`
})
await checkAsync('rejects a malformed voiceId before any network', async () => {
  try { buildTtsStreamUrl({ voiceId: '../evil' }); return false } catch (e) { return /voiceId/.test(e.message) }
})
await checkAsync('handshake carries xi-api-key; BOS → text(+space) → EOS framing', async () => {
  const { factory, record } = fakeWsFactory()
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'SECRET' })
  await tts.open()
  await tts.synthesize({ text: 'hello world', voiceId: VOICE, targetLang: 'ta' }, {}).done
  const [bos, ...rest] = record.sent
  const eos = rest[rest.length - 1]
  const textMsgs = rest.slice(0, -1)
  return record.headers['xi-api-key'] === 'SECRET' &&
    bos.text === ' ' && isLegalVoiceSettings(bos.voice_settings) && Array.isArray(bos.generation_config.chunk_length_schedule) &&
    textMsgs.every((m) => m.text.endsWith(' ') && m.try_trigger_generation === true) &&
    textMsgs.map((m) => m.text).join('') === 'hello world ' &&
    eos.text === ''
})
await checkAsync('prosody input maps into the BOS voice_settings', async () => {
  const { factory, record } = fakeWsFactory()
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  await tts.synthesize({ text: 'x', voiceId: VOICE, prosody: { emotion: 1, intonation: 1, pace: 1.5, energy: 1 } }, {}).done
  const vs = record.sent[0].voice_settings
  return vs.style === 1 && vs.stability === 0.15 && vs.speed === SPEED_RANGE.max && vs.use_speaker_boost === true
})

/* -------- audio emission -------- */
await checkAsync('emits base64 chunks with firstAudio flag + alignment, then resolves', async () => {
  const { factory } = fakeWsFactory({ audioChunks: ['AAAA', 'BBBB', 'CCCC'] })
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  const partials = []
  let first = null
  const r = await tts.synthesize({ text: 'hi', voiceId: VOICE }, {
    onFirstToken: (f) => { first = f },
    onPartial: (p) => partials.push(p)
  }).done
  return r.final === true && r.chunks.length === 3 &&
    partials[0].firstAudio === true && partials[1].firstAudio === false &&
    partials.every((p) => typeof p.chunk === 'string') &&
    partials[0].alignment != null &&
    first && first.kind === 'audio'
})
await checkAsync('server close after audio (no isFinal) still resolves with what played', async () => {
  const { factory } = fakeWsFactory({ audioChunks: ['XYZ1'], sendFinal: false })
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  const r = await tts.synthesize({ text: 'x', voiceId: VOICE }, {}).done
  return r.final === true && r.closedEarly === true && r.chunks.length === 1
})
await checkAsync('missing voiceId REFUSES — no invented voice, ever (§6.4)', async () => {
  const { factory } = fakeWsFactory()
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  try { await tts.synthesize({ text: 'x' }, {}).done; return false } catch (e) { return /voiceId/.test(e.message) }
})

/* -------- bounds + cancel -------- */
await checkAsync('connect deadline is bounded (a dead socket rejects)', async () => {
  const factory = () => ({ send () {}, close () {}, readyState: 0, onopen: null, onmessage: null, onerror: null, onclose: null }) // never opens
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k', connectTimeoutMs: 15 })
  try { await tts.synthesize({ text: 'x', voiceId: VOICE }, {}).done; return false } catch (e) { return /connect timeout/.test(e.message) }
})
await checkAsync('idle deadline is bounded (an open-but-silent socket rejects)', async () => {
  const { factory } = fakeWsFactory({ silent: true })
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k', firstAudioTimeoutMs: 15 })
  const errs = []
  try { await tts.synthesize({ text: 'x', voiceId: VOICE }, { onError: (e) => errs.push(e) }).done; return false } catch (e) {
    return /idle > 15ms/.test(e.message) && errs.length === 1
  }
})
await checkAsync('cancel() closes the socket (synthesis + billing stop) and resolves { cancelled }', async () => {
  const { factory, record } = fakeWsFactory({ silent: true })
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  const ctrl = tts.synthesize({ text: 'long text to cut off', voiceId: VOICE }, {})
  ctrl.cancel('barge-in')
  const r = await ctrl.done
  return r.cancelled === 'barge-in' && record.closed >= 1
})
await checkAsync('a socket error rejects (and status() reports failed)', async () => {
  const { factory } = fakeWsFactory({ failOnOpen: true })
  const tts = createElevenLabsStreamingTts({ wsFactory: factory, keyProvider: () => 'k' })
  try { await tts.synthesize({ text: 'x', voiceId: VOICE }, {}).done; return false } catch {
    return tts.status() === 'failed'
  }
})

/* -------- the flag gate -------- */
await checkAsync('open() REFUSES with no injected transport while STREAMING_PROVIDER_ENABLED is off', async () => {
  const tts = createElevenLabsStreamingTts({ keyProvider: () => 'k' })
  try { await tts.open(); return false } catch (e) { return /STREAMING_PROVIDER_ENABLED is off/.test(e.message) }
})

/* -------- prosody mapping unit checks -------- */
await checkAsync('neutral prosody maps to legal, stable defaults', async () => {
  const vs = mapProsodyToVoiceSettings()
  return isLegalVoiceSettings(vs) && vs.stability > 0.6 && vs.speed === 1
})
await checkAsync('pace clamps to the ElevenLabs legal range both ways', async () => {
  return mapProsodyToVoiceSettings({ pace: 3 }).speed === SPEED_RANGE.max &&
    mapProsodyToVoiceSettings({ pace: 0.1 }).speed === SPEED_RANGE.min
})
await checkAsync('mapping is deterministic and always legal across a grid', async () => {
  for (let e = 0; e <= 10; e++) {
    for (let i = 0; i <= 10; i++) {
      const a = mapProsodyToVoiceSettings({ emotion: e / 10, intonation: i / 10, pace: 0.5 + e / 10, energy: i / 10 })
      const b = mapProsodyToVoiceSettings({ emotion: e / 10, intonation: i / 10, pace: 0.5 + e / 10, energy: i / 10 })
      if (JSON.stringify(a) !== JSON.stringify(b) || !isLegalVoiceSettings(a)) return false
    }
  }
  return true
})
await checkAsync('text chunking ends every chunk with a space and loses no words', async () => {
  const text = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen'
  const chunks = chunkTextForStreaming(text, 20)
  return chunks.every((c) => c.endsWith(' ')) && chunks.join('').trim() === text
})
await checkAsync('streaming model list excludes the batch-only eleven_v3', async () => {
  return !ELEVENLABS_TTS_STREAM_MODELS.includes('eleven_v3') && ELEVENLABS_TTS_STREAM_MODELS[0] === 'eleven_flash_v2_5'
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  elevenlabs streaming TTS — stream-input protocol on fake socket')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
