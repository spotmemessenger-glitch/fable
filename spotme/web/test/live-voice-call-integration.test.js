/**
 * Call-integration seam — the FLAG-GATED media/UI surface (ADR-011b; mission
 * item 5). The two properties that make this shippable dark:
 *
 *   FLAGS OFF → NOTHING. attach() returns { attached: false } and provably
 *   touches nothing: no track tapped, no session built, no event emitted.
 *   FLAGS ON → the tap is a track CLONE (second consumer — the call's own
 *   stream is never touched), and the UI gets the full typed event/control
 *   surface: dual captions, language, confidence, clone indicator, latency,
 *   toggles, replay, live language switch, pin-speaker.
 *
 *   node test/live-voice-call-integration.test.js
 */
import { createCallIntegration, UI_EVENTS } from '../src/lib/live-voice/call-integration.js'
import { bootLiveVoice, setLiveVoiceOverride, setLiveVoiceSubOverride } from '../src/lib/live-voice/index.js'
import { createStubStreamingStt, createStubStreamingMt, createStubStreamingTts, makeManualClock } from '../src/lib/live-voice/stub-adapters.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const A = { id: 'A', listenLang: 'en', speakLang: 'en', voiceId: 'VOICEaaaa1111', consented: true }
const B = { id: 'B', listenLang: 'ta', speakLang: 'ta', voiceId: 'VOICEbbbb2222', consented: true }

/** A fake call whose track records every clone/stop — the tap audit. */
function fakeCall () {
  const audit = { clones: 0, stops: 0, constraints: 0, trackStopped: false }
  const clonedTrack = { stop: () => { audit.stops += 1 }, applyConstraints: async () => { audit.constraints += 1 } }
  const track = { clone: () => { audit.clones += 1; return clonedTrack }, stop: () => { audit.trackStopped = true } }
  return { call: { local: { getAudioTracks: () => [track] } }, audit }
}

function build ({ flags = { liveVoice: true, liveTranslation: true, voiceClone: true, liveCaptions: true }, participants = [A, B] } = {}) {
  const clock = makeManualClock(0)
  const { call, audit } = fakeCall()
  const played = []
  const integration = createCallIntegration({
    call,
    participants,
    selfId: 'A',
    adapters: {
      stt: createStubStreamingStt({ clock }),
      mt: createStubStreamingMt({ clock }),
      tts: createStubStreamingTts({ clock })
    },
    player: { schedule: (c) => { played.push(c); return Promise.resolve() } },
    flagsFn: () => flags,
    clock: clock.now
  })
  return { integration, audit, played, flags }
}

/* ==================== FLAGS OFF: byte-identical nothing ==================== */
await checkAsync('flags off → attach refuses, taps NOTHING, builds NOTHING', async () => {
  const { integration, audit } = build({ flags: { liveVoice: false, liveTranslation: false } })
  const r = integration.attach()
  return r.attached === false && /flags-off/.test(r.reason) &&
    audit.clones === 0 && integration.attached === false && integration.session === null
})
await checkAsync('master on but LIVE_TRANSLATION off → still refuses (both required)', async () => {
  const { integration, audit } = build({ flags: { liveVoice: true, liveTranslation: false } })
  return integration.attach().attached === false && audit.clones === 0
})
await checkAsync('bootLiveVoice keeps refusing while flags are down (and with deps missing)', async () => {
  const off = bootLiveVoice({})
  setLiveVoiceOverride(true)
  const masterOnly = bootLiveVoice({})
  setLiveVoiceSubOverride('LIVE_TRANSLATION_ENABLED', true)
  const noDeps = bootLiveVoice({})
  setLiveVoiceSubOverride('LIVE_TRANSLATION_ENABLED', null)
  setLiveVoiceOverride(null)
  return off.started === false && /LIVE_VOICE_ENABLED is off/.test(off.reason) &&
    masterOnly.started === false && /LIVE_TRANSLATION_ENABLED is off/.test(masterOnly.reason) &&
    noDeps.started === false && /missing deps/.test(noDeps.reason)
})

/* ==================== FLAGS ON: the tap is a CLONE ==================== */
await checkAsync('attach clones the mic track ONCE and applies constraints to the clone', async () => {
  const { integration, audit } = build()
  const r = integration.attach()
  await Promise.resolve() // constraints apply is async best-effort
  return r.attached === true && r.tapped === true &&
    audit.clones === 1 && audit.constraints === 1 &&
    audit.trackStopped === false // the CALL's track is never touched
})
await checkAsync('detach stops the CLONE only; attach is idempotent', async () => {
  const { integration, audit } = build()
  integration.attach()
  const again = integration.attach()
  await integration.detach()
  return again.already === true && audit.clones === 1 &&
    audit.stops === 1 && audit.trackStopped === false && integration.attached === false
})

/* ==================== the typed event surface ==================== */
await checkAsync('unknown event names are refused loudly', async () => {
  const { integration } = build()
  try { integration.on('not-an-event', () => {}); return false } catch (e) { return /unknown event/.test(e.message) }
})
await checkAsync('dual subtitles: original + translated caption events, in order', async () => {
  const { integration } = build()
  integration.attach()
  const seen = []
  integration.on(UI_EVENTS.CAPTION_ORIGINAL, (e) => seen.push(['orig', e.text, e.partial]))
  integration.on(UI_EVENTS.CAPTION_TRANSLATED, (e) => seen.push(['xlat', e.text, e.partial]))
  await integration.speech('B', { script: 'vanakkam nanba', sourceLang: 'ta' })
  const firstOrig = seen.findIndex((s) => s[0] === 'orig')
  const firstXlat = seen.findIndex((s) => s[0] === 'xlat')
  const finalXlat = seen.filter((s) => s[0] === 'xlat' && s[2] === false)
  return firstOrig >= 0 && firstXlat > firstOrig &&
    finalXlat.length === 1 && finalXlat[0][1] === '⟨en⟩ vanakkam nanba'
})
await checkAsync('language, clone-indicator, latency and confidence events fire', async () => {
  const { integration } = build()
  integration.attach()
  const got = { lang: null, voice: [], latency: null }
  integration.on(UI_EVENTS.LANGUAGE, (e) => { got.lang = e })
  integration.on(UI_EVENTS.VOICE_CLONE_ACTIVE, (e) => got.voice.push(e.active))
  integration.on(UI_EVENTS.LATENCY, (e) => { got.latency = e })
  await integration.speech('B', { script: 'hello', sourceLang: 'ta' })
  return got.lang && got.lang.sourceLang === 'ta' &&
    JSON.stringify(got.voice) === JSON.stringify([true, false]) && // on before audio, off after
    got.latency && typeof got.latency.measuredMs === 'number' && got.latency.withinBudget === true &&
    typeof got.latency.p50 === 'number'
})
await checkAsync('events only surface deliveries addressed to SELF', async () => {
  const { integration } = build()
  integration.attach()
  const texts = []
  integration.on(UI_EVENTS.CAPTION_TRANSLATED, (e) => texts.push(e.text))
  await integration.speech('A', { script: 'my own words', sourceLang: 'en' }) // A speaks → only B hears
  return texts.length === 0
})
await checkAsync('translated audio flows to the local player; chunks surface as events', async () => {
  const { integration, played } = build()
  integration.attach()
  const chunks = []
  integration.on(UI_EVENTS.TRANSLATED_AUDIO, (e) => chunks.push(e))
  await integration.speech('B', { script: 'listen to this', sourceLang: 'ta' })
  return played.length === 3 && chunks.length === 3 && chunks.every((c) => typeof c.chunk === 'string')
})

/* ==================== controls ==================== */
await checkAsync('muteTranslated stops local playout; unmute restores it', async () => {
  const { integration, played } = build()
  integration.attach()
  integration.muteTranslated(true)
  await integration.speech('B', { script: 'muted words', sourceLang: 'ta' })
  const during = played.length
  integration.muteTranslated(false)
  await integration.speech('B', { script: 'audible again', sourceLang: 'ta' })
  return during === 0 && played.length === 3
})
await checkAsync('listenOriginal suppresses playout too (captions continue)', async () => {
  const { integration, played } = build()
  integration.attach()
  const caps = []
  integration.on(UI_EVENTS.CAPTION_TRANSLATED, (e) => caps.push(e.text))
  integration.listenOriginal(true)
  await integration.speech('B', { script: 'original only', sourceLang: 'ta' })
  return played.length === 0 && caps.length > 0
})
await checkAsync('replayLastUtterance returns the bounded ring and emits the event', async () => {
  const { integration } = build()
  integration.attach()
  let replayed = null
  integration.on(UI_EVENTS.REPLAY, (r) => { replayed = r })
  await integration.speech('B', { script: 'first', sourceLang: 'ta' })
  await integration.speech('B', { script: 'replay me please', sourceLang: 'ta' })
  const r = integration.replayLastUtterance()
  return r && replayed === r && r.audio.length === 3 &&
    r.captions.some((f) => f.translatedText === '⟨en⟩ replay me please')
})
await checkAsync('setListenLang switches live; pinSpeaker round-trips', async () => {
  const { integration } = build()
  integration.attach()
  const texts = []
  integration.on(UI_EVENTS.CAPTION_TRANSLATED, (e) => texts.push(e.text))
  integration.setListenLang('ml')
  await integration.speech('B', { script: 'switched', sourceLang: 'ta' })
  integration.pinSpeaker('B')
  const pinned = integration.pinnedSpeaker
  integration.pinSpeaker(null)
  return texts[texts.length - 1] === '⟨ml⟩ switched' && pinned === 'B' && integration.pinnedSpeaker === null
})
await checkAsync('suspend/resume pass through to the session', async () => {
  const { integration } = build()
  integration.attach()
  const st = integration.suspend('drop')
  const back = integration.resume()
  return st === 'degraded' && back.state === 'active'
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  call integration — flag gate, clone tap, typed UI surface')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
