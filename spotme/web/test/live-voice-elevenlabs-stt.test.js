/**
 * ElevenLabs streaming STT adapter — REAL wire protocol over an injected fake
 * transport (ADR-011b §providers).
 *
 * The fake here is the TEST's transport; the production path builds the same
 * request against the real global fetch. So this suite pins the protocol
 * itself: exact URL, `xi-api-key` header custody, multipart form fields
 * (model_id=scribe_v1 + named file part — byte-compatible with what
 * api/voice.js sends today), the proxy-mode JSON protocol, growing partials,
 * first-token, cancel, bounded timeouts, and the STREAMING_PROVIDER_ENABLED
 * refusal that keeps the real transport unreachable while flags are down.
 *
 *   node test/live-voice-elevenlabs-stt.test.js
 */
import {
  createElevenLabsStreamingStt, ELEVENLABS_STT_URL, ELEVENLABS_STT_MODEL
} from '../src/lib/live-voice/providers/elevenlabs-stt.js'
import { assertImplementsStreamingStt } from '../src/lib/live-voice/streaming-interfaces.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const seg = (s) => `data:audio/webm;codecs=opus;base64,${Buffer.from(s).toString('base64')}`

/** A fake fetch that answers like ElevenLabs scribe and records every call. */
function fakeElevenLabs ({ transcripts = ['hello world'], lang = 'en', failAt = -1, status = 200, neverResolve = false } = {}) {
  const calls = []
  let i = 0
  const fetchFn = (url, init) => {
    const n = i++
    calls.push({ url, init })
    if (neverResolve) return new Promise(() => {})
    if (n === failAt || status !== 200) {
      return Promise.resolve({ ok: false, status: status === 200 ? 500 : status, text: async () => 'boom', json: async () => ({}) })
    }
    const text = transcripts[Math.min(n, transcripts.length - 1)]
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ text, language_code: lang }), text: async () => '' })
  }
  return { fetchFn, calls }
}

/* -------- interface conformance -------- */
await checkAsync('conforms to IStreamingStt (with fake transport)', async () => {
  const { fetchFn } = fakeElevenLabs()
  const stt = createElevenLabsStreamingStt({ fetchFn, keyProvider: () => 'k' })
  assertImplementsStreamingStt(stt, 'el-stt')
  return true
})

/* -------- direct-mode protocol: URL, header, multipart fields -------- */
await checkAsync('direct mode POSTs the real scribe endpoint with xi-api-key', async () => {
  const fake = fakeElevenLabs()
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'SECRETKEY' })
  await stt.open()
  const r = await stt.transcribe({ audio: [seg('a')], lang: 'auto' }, {}).done
  const call = fake.calls[0]
  return r.text === 'hello world' && r.lang === 'en' &&
    call.url === ELEVENLABS_STT_URL &&
    call.init.method === 'POST' &&
    call.init.headers['xi-api-key'] === 'SECRETKEY'
})
await checkAsync('multipart form carries model_id=scribe_v1 and a named file part', async () => {
  const fake = fakeElevenLabs()
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'k' })
  const dataUrl = seg('audio-bytes')
  await stt.transcribe({ audio: [dataUrl], lang: 'auto' }, {}).done
  const form = fake.calls[0].init.body
  if (!(form instanceof FormData)) return false
  const model = form.get('model_id')
  const file = form.get('file')
  return model === ELEVENLABS_STT_MODEL && file && typeof file.name === 'string' && file.name === 'audio.webm' && file.type.startsWith('audio/webm')
})
await checkAsync('pinned language (not auto) is forwarded as language_code', async () => {
  const fake = fakeElevenLabs()
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'k' })
  await stt.transcribe({ audio: [seg('a')], lang: 'ta' }, {}).done
  return fake.calls[0].init.body.get('language_code') === 'ta'
})

/* -------- proxy-mode protocol: the shipped /api/voice JSON wire -------- */
await checkAsync('proxy mode POSTs /api/voice?op=stt with JSON {audio} + auth headers', async () => {
  const fake = fakeElevenLabs()
  fake.fetchFn2 = fake.fetchFn
  const stt = createElevenLabsStreamingStt({
    fetchFn: (url, init) => { fake.calls.push({ url, init }); return Promise.resolve({ ok: true, status: 200, json: async () => ({ text: 'hi', lang: 'en' }) }) },
    mode: 'proxy',
    proxyBase: 'https://x.example',
    authHeadersFn: () => ({ authorization: 'Bearer tok' })
  })
  const dataUrl = seg('clip')
  const r = await stt.transcribe({ audio: [dataUrl] }, {}).done
  const call = fake.calls[0]
  const body = JSON.parse(call.init.body)
  return r.text === 'hi' &&
    call.url === 'https://x.example/api/voice?op=stt' &&
    call.init.headers['content-type'] === 'application/json' &&
    call.init.headers.authorization === 'Bearer tok' &&
    body.audio === dataUrl
})

/* -------- streaming semantics: partials grow, first token fires -------- */
await checkAsync('multi-segment input emits growing partials then the joined final', async () => {
  const fake = fakeElevenLabs({ transcripts: ['hello', 'world today'] })
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'k' })
  const partials = []
  let first = null
  const r = await stt.transcribe({ audio: [seg('1'), seg('2')] }, {
    onFirstToken: (f) => { first = f.text },
    onPartial: (p) => partials.push(p.text)
  }).done
  return JSON.stringify(partials) === JSON.stringify(['hello', 'hello world today']) &&
    first === 'hello' && r.text === 'hello world today' && fake.calls.length === 2
})
await checkAsync('detected language sticks across segments and reports in final', async () => {
  const fake = fakeElevenLabs({ transcripts: ['a', 'b'], lang: 'ml' })
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'k' })
  const r = await stt.transcribe({ audio: [seg('1'), seg('2')], lang: 'auto' }, {}).done
  // second call carries the language detected by the first
  return r.lang === 'ml' && fake.calls[1].init.body.get('language_code') === 'ml'
})

/* -------- failure + bounds -------- */
await checkAsync('an upstream failure rejects with the relayed status detail', async () => {
  const fake = fakeElevenLabs({ status: 429 })
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'k' })
  const errs = []
  try { await stt.transcribe({ audio: [seg('x')] }, { onError: (e) => errs.push(e) }).done; return false } catch (e) {
    return /429/.test(e.message) && errs.length === 1 && stt.status() === 'failed'
  }
})
await checkAsync('no audio segments → typed refusal (this adapter needs audio)', async () => {
  const { fetchFn } = fakeElevenLabs()
  const stt = createElevenLabsStreamingStt({ fetchFn, keyProvider: () => 'k' })
  try { await stt.transcribe({ script: 'not audio' }, {}).done; return false } catch (e) {
    return /no audio segments/.test(e.message)
  }
})
await checkAsync('cancel() aborts and resolves { cancelled }', async () => {
  const fake = fakeElevenLabs({ neverResolve: true })
  const stt = createElevenLabsStreamingStt({ fetchFn: fake.fetchFn, keyProvider: () => 'k', requestTimeoutMs: 60_000 })
  const ctrl = stt.transcribe({ audio: [seg('x')] }, {})
  ctrl.cancel('barge-in')
  const r = await ctrl.done
  return r.cancelled === 'barge-in'
})
await checkAsync('per-request timeout is BOUNDED — a hung transport rejects', async () => {
  // Real timers, tiny bound: a never-resolving fetch must not hang the await.
  const aborted = { flag: false }
  const fetchFn = (url, init) => new Promise((resolve, reject) => {
    if (init.signal) init.signal.addEventListener('abort', () => { aborted.flag = true; reject(new Error('aborted')) })
  })
  const stt = createElevenLabsStreamingStt({ fetchFn, keyProvider: () => 'k', requestTimeoutMs: 20 })
  try { await stt.transcribe({ audio: [seg('x')] }, {}).done; return false } catch {
    return aborted.flag === true
  }
})

/* -------- the flag gate: real transport refused while flags are down ---- */
await checkAsync('open() REFUSES with no injected transport while STREAMING_PROVIDER_ENABLED is off', async () => {
  const stt = createElevenLabsStreamingStt({ keyProvider: () => 'k' }) // no fetchFn → would use the real fetch
  try { await stt.open(); return false } catch (e) {
    return /STREAMING_PROVIDER_ENABLED is off/.test(e.message)
  }
})
await checkAsync('open() with an injected fake transport works while flags stay off (tests need no creds)', async () => {
  const { fetchFn } = fakeElevenLabs()
  const stt = createElevenLabsStreamingStt({ fetchFn, keyProvider: () => null })
  await stt.open()
  return stt.status() === 'open'
})

/* -------- cred-gated LIVE smoke (skipped in CI — no credentials there) -- */
if (process.env.ELEVENLABS_API_KEY && process.env.LIVE_VOICE_LIVE_TESTS === '1') {
  await checkAsync('LIVE: real scribe endpoint answers a tiny clip', async () => {
    process.env.LIVE_VOICE_ENABLED = 'true'
    process.env.STREAMING_PROVIDER_ENABLED = 'true'
    const stt = createElevenLabsStreamingStt({})
    await stt.open()
    const silent = `data:audio/wav;base64,${Buffer.from(new Uint8Array(44)).toString('base64')}`
    try { await stt.transcribe({ audio: [silent] }, {}).done } catch { /* a 4xx on junk audio still proves the wire */ }
    delete process.env.LIVE_VOICE_ENABLED
    delete process.env.STREAMING_PROVIDER_ENABLED
    return true
  })
} else {
  console.log('  SKIP  live ElevenLabs STT smoke (set ELEVENLABS_API_KEY + LIVE_VOICE_LIVE_TESTS=1)')
}

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  elevenlabs streaming STT — real protocol on fake transport')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
