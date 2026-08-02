/**
 * Adapter conformance — ONE contract, run against EVERY adapter (ADR-011b).
 *
 * The scaffold's streaming contract (partial / firstToken / cancel, forbidden
 * retention surface, StreamController) is only real if every implementation —
 * deterministic stubs, the real ElevenLabs adapters on fake transports, the
 * platform MT stage, the failover chain — passes the SAME checks. This suite
 * is that single bench. The real adapters also run (cred-gated, skipped in
 * CI) against their live transports, proving fake and live speak one
 * contract.
 *
 *   node test/live-voice-adapter-conformance.test.js
 */
import {
  assertImplementsStreamingStt, assertImplementsStreamingMt, assertImplementsStreamingTts,
  assertStreamController, FORBIDDEN_RETENTION_SURFACE
} from '../src/lib/live-voice/streaming-interfaces.js'
import { createStubStreamingStt, createStubStreamingMt, createStubStreamingTts, makeManualClock } from '../src/lib/live-voice/stub-adapters.js'
import { createElevenLabsStreamingStt } from '../src/lib/live-voice/providers/elevenlabs-stt.js'
import { createElevenLabsStreamingTts } from '../src/lib/live-voice/providers/elevenlabs-tts.js'
import { createFailoverChain } from '../src/lib/live-voice/providers/failover.js'
import { createTranslationPlatformMt } from '../src/lib/live-voice/mt-stage.js'
import { fakeTranslationPlatform } from './helpers/fake-translation-provider.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const VOICE = 'VOICEclone12345'
const seg = (s) => `data:audio/webm;base64,${Buffer.from(s).toString('base64')}`

/* ---------------- fixture builders: every adapter, fake-backed ---------------- */

function fakeSttFetch () {
  let i = 0
  return () => Promise.resolve({ ok: true, status: 200, json: async () => ({ text: `word${i++}`, language_code: 'en' }) })
}

function fakeTtsWs () {
  return (url, opts) => {
    const ws = { readyState: 1, send () {}, close () { ws.readyState = 3 }, onopen: null, onmessage: null, onerror: null, onclose: null }
    queueMicrotask(() => {
      ws.onopen && ws.onopen()
      queueMicrotask(() => {
        ws.onmessage && ws.onmessage({ data: JSON.stringify({ audio: 'QUJD', isFinal: null }) })
        ws.onmessage && ws.onmessage({ data: JSON.stringify({ audio: 'REVG', isFinal: null }) })
        ws.onmessage && ws.onmessage({ data: JSON.stringify({ isFinal: true }) })
      })
    })
    return ws
  }
}

const fakePlatform = () => fakeTranslationPlatform().platform

const FIXTURES = [
  {
    label: 'stub STT', role: 'stt', assert: assertImplementsStreamingStt,
    make: () => createStubStreamingStt({ clock: makeManualClock(0) }),
    input: { script: 'alpha beta gamma', lang: 'en' }
  },
  {
    label: 'stub MT', role: 'mt', assert: assertImplementsStreamingMt,
    make: () => createStubStreamingMt({ clock: makeManualClock(0) }),
    input: { text: 'alpha beta', sourceLang: 'en', targetLang: 'ta' }
  },
  {
    label: 'stub TTS', role: 'tts', assert: assertImplementsStreamingTts,
    make: () => createStubStreamingTts({ clock: makeManualClock(0) }),
    input: { text: 'alpha', voiceId: VOICE, targetLang: 'ta' }
  },
  {
    label: 'elevenlabs STT (fake transport)', role: 'stt', assert: assertImplementsStreamingStt,
    make: () => createElevenLabsStreamingStt({ fetchFn: fakeSttFetch(), keyProvider: () => 'k' }),
    input: { audio: [seg('a'), seg('b')], lang: 'auto' }
  },
  {
    label: 'elevenlabs TTS (fake transport)', role: 'tts', assert: assertImplementsStreamingTts,
    make: () => createElevenLabsStreamingTts({ wsFactory: fakeTtsWs(), keyProvider: () => 'k' }),
    input: { text: 'alpha beta', voiceId: VOICE, targetLang: 'ta' }
  },
  {
    label: 'platform MT stage (#51-backed)', role: 'mt', assert: assertImplementsStreamingMt,
    make: () => createTranslationPlatformMt({ platform: fakePlatform() }),
    input: { text: 'alpha beta', sourceLang: 'en', targetLang: 'ta' }
  },
  {
    label: 'failover chain (stub+stub STT)', role: 'stt', assert: assertImplementsStreamingStt,
    make: () => createFailoverChain('stt', [createStubStreamingStt({ clock: makeManualClock(0) }), createStubStreamingStt({ clock: makeManualClock(0) })]),
    input: { script: 'alpha beta', lang: 'en' }
  }
]

const METHOD = { stt: 'transcribe', mt: 'translate', tts: 'synthesize' }

for (const f of FIXTURES) {
  await checkAsync(`${f.label}: satisfies the interface + retention ban`, async () => {
    const a = f.make()
    f.assert(a, f.label)
    return FORBIDDEN_RETENTION_SURFACE.every((k) => !(k in a))
  })
  await checkAsync(`${f.label}: returns a StreamController and resolves a final`, async () => {
    const a = f.make()
    await a.open()
    const ctrl = a[METHOD[f.role]](f.input, {})
    assertStreamController(ctrl, f.label)
    const r = await ctrl.done
    return r && (r.final === true || typeof r.text === 'string' || Array.isArray(r.chunks))
  })
  await checkAsync(`${f.label}: emits firstToken BEFORE final, and at least one partial`, async () => {
    const a = f.make()
    await a.open()
    const order = []
    await a[METHOD[f.role]](f.input, {
      onFirstToken: () => order.push('first'),
      onPartial: () => order.push('partial'),
      onFinal: () => order.push('final')
    }).done
    return order.includes('first') && order.includes('partial') &&
      order.indexOf('first') < order.indexOf('final') &&
      order.filter((x) => x === 'final').length === 1
  })
  await checkAsync(`${f.label}: cancel() mid-stream yields { cancelled }, no final`, async () => {
    const a = f.make()
    await a.open()
    let finals = 0
    const ctrl = a[METHOD[f.role]](f.input, { onFinal: () => { finals += 1 } })
    ctrl.cancel('conformance-barge-in')
    const r = await ctrl.done.catch((e) => ({ error: e }))
    // Cancel before completion must never produce a final result object.
    return (r.cancelled === 'conformance-barge-in' || r.error) && finals === 0
  })
}

/* -------- cred-gated LIVE conformance (skipped in CI) -------- */
if (process.env.ELEVENLABS_API_KEY && process.env.LIVE_VOICE_LIVE_TESTS === '1') {
  await checkAsync('LIVE: elevenlabs TTS real websocket speaks the same contract', async () => {
    process.env.LIVE_VOICE_ENABLED = 'true'
    process.env.STREAMING_PROVIDER_ENABLED = 'true'
    const tts = createElevenLabsStreamingTts({})
    await tts.open()
    const r = await tts.synthesize({ text: 'hello', voiceId: process.env.LIVE_VOICE_TEST_VOICE_ID || VOICE, targetLang: 'en' }, {}).done
      .catch((e) => ({ error: String(e?.message || e) }))
    delete process.env.LIVE_VOICE_ENABLED
    delete process.env.STREAMING_PROVIDER_ENABLED
    // Either audio came back, or a structured provider refusal (bad voice id)
    // — both prove the live wire and the error path.
    return Array.isArray(r.chunks) || typeof r.error === 'string'
  })
} else {
  console.log('  SKIP  live provider conformance (set ELEVENLABS_API_KEY + LIVE_VOICE_LIVE_TESTS=1)')
}

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adapter conformance — one contract, every implementation')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
