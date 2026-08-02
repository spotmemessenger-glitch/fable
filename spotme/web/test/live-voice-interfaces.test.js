/**
 * Live-voice streaming contracts + the OFF flag (ADR-011, §6.3).
 *
 * Two guarantees here. First, the three provider interfaces are a real contract:
 * the stub adapters satisfy them, and an adapter that leaks a retention surface
 * (§6.3/§6.4 forbid retaining raw audio/transcripts) or cannot do the streaming
 * three (partial/first-token/cancel) is rejected — the same "prohibition is a
 * test" stance the transport layer takes on key surface. Second, and non-
 * negotiable this cycle: the feature flag defaults OFF and the wire-in door
 * refuses to open. Nothing here enables anything.
 */
import {
  StreamingStatus, FORBIDDEN_RETENTION_SURFACE,
  STREAMING_STT_METHODS, STREAMING_MT_METHODS, STREAMING_TTS_METHODS,
  assertImplementsStreamingStt, assertImplementsStreamingMt, assertImplementsStreamingTts,
  assertStreamController, normalizeHandlers
} from '../src/lib/live-voice/streaming-interfaces.js'
import {
  makeManualClock,
  createStubStreamingStt, createStubStreamingMt, createStubStreamingTts
} from '../src/lib/live-voice/stub-adapters.js'
import { isLiveVoiceEnabled, setLiveVoiceOverride, LIVE_VOICE_FLAG } from '../src/lib/live-voice/flags.js'
import { bootLiveVoice } from '../src/lib/live-voice/index.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn) => { try { fn(); return false } catch { return true } }

const clock = makeManualClock(0)

/* -------- stub conformance -------- */
check('the stub STT/MT/TTS satisfy their interfaces', () => {
  assertImplementsStreamingStt(createStubStreamingStt({ clock }))
  assertImplementsStreamingMt(createStubStreamingMt({ clock }))
  assertImplementsStreamingTts(createStubStreamingTts({ clock }))
  return true
})
check('each interface names exactly its lifecycle + one role method', () =>
  STREAMING_STT_METHODS.includes('transcribe') && STREAMING_MT_METHODS.includes('translate') &&
  STREAMING_TTS_METHODS.includes('synthesize') &&
  ['open', 'close', 'status', 'capabilities'].every((m) => STREAMING_STT_METHODS.includes(m)))

/* -------- contract enforcement -------- */
check('an adapter missing the role method is rejected', () => {
  const bad = { open () {}, close () {}, status: () => StreamingStatus.IDLE, capabilities: () => ({ partial: true, firstToken: true, cancel: true }) }
  return throws(() => assertImplementsStreamingStt(bad))
})
check('an adapter that cannot stream (partial=false) is rejected', () => {
  const bad = {
    open () {}, close () {}, transcribe () {}, status: () => StreamingStatus.IDLE,
    capabilities: () => ({ partial: false, firstToken: true, cancel: true })
  }
  return throws(() => assertImplementsStreamingStt(bad))
})
check('an adapter exposing a retention surface (e.g. store/history) is rejected', () => {
  const leaky = {
    open () {}, close () {}, transcribe () {}, status: () => StreamingStatus.IDLE,
    capabilities: () => ({ partial: true, firstToken: true, cancel: true }),
    history: [] // forbidden — retaining transcripts contradicts §6.3/§6.4
  }
  return throws(() => assertImplementsStreamingStt(leaky))
})
check('every forbidden name is actually enforced', () => {
  return FORBIDDEN_RETENTION_SURFACE.every((banned) => {
    const a = {
      open () {}, close () {}, transcribe () {}, status: () => StreamingStatus.IDLE,
      capabilities: () => ({ partial: true, firstToken: true, cancel: true }),
      [banned]: true
    }
    return throws(() => assertImplementsStreamingStt(a))
  })
})

/* -------- stream controller + handlers -------- */
await checkAsync('a role method returns a valid StreamController { cancel, done }', async () => {
  const stt = createStubStreamingStt({ clock })
  const ctrl = stt.transcribe({ script: 'hi there', lang: 'en' }, {})
  assertStreamController(ctrl)
  const r = await ctrl.done
  return r.text === 'hi there'
})
check('normalizeHandlers fills missing hooks with no-ops and drops unknowns', () => {
  const h = normalizeHandlers({ onPartial: () => 1, bogus: () => 2 })
  return typeof h.onFirstToken === 'function' && typeof h.onFinal === 'function' &&
    typeof h.onError === 'function' && !('bogus' in h)
})

/* -------- THE FLAG IS OFF -------- */
check('the flag defaults to OFF', () => isLiveVoiceEnabled() === false)
check('the env var name is exactly LIVE_VOICE_ENABLED', () => LIVE_VOICE_FLAG === 'LIVE_VOICE_ENABLED')
check('bootLiveVoice() refuses to start while the flag is off', () => {
  const r = bootLiveVoice()
  return r.started === false && typeof r.reason === 'string'
})
check('even forced ON, the runtime is not implemented (scaffolding only)', () => {
  // Prove the override plumbing works AND that nothing real starts — then reset.
  setLiveVoiceOverride(true)
  const on = isLiveVoiceEnabled() === true
  const r = bootLiveVoice()
  setLiveVoiceOverride(null)               // leave the flag OFF, as found.
  return on && r.started === false && isLiveVoiceEnabled() === false
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  live-voice interfaces — contract + OFF')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
