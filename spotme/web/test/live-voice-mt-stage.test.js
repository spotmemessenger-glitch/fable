/**
 * MT stage — the live pipeline CONSUMES the #51 translation platform
 * (ADR-011b; mission item 2). Proves per-segment routing + failover through
 * the real router, confidence passthrough, BOUNDED conversation context,
 * glossary passthrough, the strict-privacy refusal, cancel, and the bounded
 * segment timeout. All deterministic; the platform runs entirely on
 * registered fake providers (no vendor, no network).
 *
 *   node test/live-voice-mt-stage.test.js
 */
import { createTranslationPlatformMt, STRICT_PRIVACY_REFUSAL } from '../src/lib/live-voice/mt-stage.js'
import { createContextWindow, CONTEXT_DEFAULTS } from '../src/lib/translation/context.js'
import { fakeProvider, fakeTranslationPlatform } from './helpers/fake-translation-provider.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* -------- happy path: platform answers, metadata rides the final -------- */
await checkAsync('translates a segment through the platform pipeline', async () => {
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform })
  await mt.open()
  const partials = []
  let first = null
  const r = await mt.translate({ text: 'hello there', sourceLang: 'en', targetLang: 'ta' }, {
    onFirstToken: (f) => { first = f.text },
    onPartial: (p) => partials.push(p.text)
  }).done
  return r.text === '⟨ta⟩ hello there' && r.final === true &&
    r.provider === 'google' && first === '⟨ta⟩ hello there' && partials.length === 1
})
await checkAsync('confidence + band from the platform ride the final result', async () => {
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform })
  const r = await mt.translate({ text: 'x', sourceLang: 'en', targetLang: 'ta' }, {}).done
  return typeof r.confidence === 'number' && r.confidence > 0 && typeof r.confidenceBand === 'string'
})

/* -------- routing + failover THROUGH the #51 router -------- */
await checkAsync('a dead primary fails over via the platform router (reason recorded)', async () => {
  const dead = fakeProvider('google', { translate: async () => { throw new Error('google down') } })
  const alive = fakeProvider('azure', { qualityTier: 'general', translate: async ({ text, targetLang }) => ({ text: `⟨${targetLang}⟩ ${text}`, engine: 'azure' }) })
  const { platform } = fakeTranslationPlatform([dead, alive])
  const mt = createTranslationPlatformMt({ platform })
  const r = await mt.translate({ text: 'failover me', sourceLang: 'en', targetLang: 'ta' }, {}).done
  const log = mt.decisionLog()
  return r.text === '⟨ta⟩ failover me' && String(r.provider).includes('azure') &&
    log.length === 1 && log[0].reason === 'ok'
})
await checkAsync('ALL providers dead → typed uncertain error, decision logged', async () => {
  const dead1 = fakeProvider('google', { translate: async () => { throw new Error('down') } })
  const dead2 = fakeProvider('azure', { translate: async () => { throw new Error('down') } })
  const { platform } = fakeTranslationPlatform([dead1, dead2])
  const mt = createTranslationPlatformMt({ platform })
  try { await mt.translate({ text: 'x', sourceLang: 'en', targetLang: 'ta' }, {}).done; return false } catch (e) {
    return e.uncertain === true && /uncertain/.test(e.message)
  }
})

/* -------- conversation context: BOUNDED, and it flows to the provider ---- */
await checkAsync('finished turns land in the window; the window stays BOUNDED', async () => {
  const window = createContextWindow()
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform, window })
  for (let i = 0; i < CONTEXT_DEFAULTS.maxTurns + 5; i++) {
    await mt.translate({ text: `turn number ${i}`, sourceLang: 'en', targetLang: 'ta', speaker: 'A' }, {}).done
  }
  return window.size === CONTEXT_DEFAULTS.maxTurns &&
    window.turns()[window.size - 1].text === `turn number ${CONTEXT_DEFAULTS.maxTurns + 4}`
})
await checkAsync('glossary + prefs pass through to the platform call', async () => {
  let seen = null
  const spyPlatform = { run: async (req, opts) => { seen = { req, opts }; return { text: 'ok', provider: 'google', confidence: 0.9, confidenceBand: 'high' } } }
  const mt = createTranslationPlatformMt({ platform: spyPlatform, glossary: ['Spot Me', 'Chennai'], prefs: { formality: 'informal' } })
  await mt.translate({ text: 'meet me in Chennai', sourceLang: 'en', targetLang: 'ta' }, {}).done
  return Array.isArray(seen.opts.glossary) && seen.opts.glossary.includes('Chennai') &&
    seen.opts.prefs.formality === 'informal' &&
    typeof seen.opts.window?.turns === 'function' &&
    seen.req.kind === 'live-caption'
})

/* -------- strict privacy: REFUSE, don't leak -------- */
await checkAsync('strict privacy mode: open() refuses with the typed reason', async () => {
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform, privacyMode: 'strict' })
  try { await mt.open(); return false } catch (e) { return e.message === STRICT_PRIVACY_REFUSAL }
})
await checkAsync('strict privacy mode: translate() also refuses (defense in depth) — no platform call', async () => {
  let called = 0
  const spyPlatform = { run: async () => { called += 1; return { text: 'leak' } } }
  const mt = createTranslationPlatformMt({ platform: spyPlatform, privacyMode: 'strict' })
  try { await mt.translate({ text: 'secret', sourceLang: 'en', targetLang: 'ta' }, {}).done; return false } catch (e) {
    return e.message === STRICT_PRIVACY_REFUSAL && called === 0
  }
})
await checkAsync('sensitive mode passes through as the request privacyMode', async () => {
  let seen = null
  const spyPlatform = { run: async (req) => { seen = req; return { text: 'ok', provider: 'g', confidence: 0.9, confidenceBand: 'high' } } }
  const mt = createTranslationPlatformMt({ platform: spyPlatform, privacyMode: 'sensitive' })
  await mt.translate({ text: 'x', sourceLang: 'en', targetLang: 'ta' }, {}).done
  return seen.privacyMode === 'sensitive' && mt.privacyMode() === 'sensitive'
})

/* -------- streaming semantics on multi-part input -------- */
await checkAsync('segments[] translate in order with growing partials', async () => {
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform })
  const partials = []
  const r = await mt.translate({ segments: ['good morning', 'how are you'], sourceLang: 'en', targetLang: 'ta' }, {
    onPartial: (p) => partials.push(p.text)
  }).done
  return partials.length === 2 &&
    partials[0] === '⟨ta⟩ good morning' &&
    r.text === '⟨ta⟩ good morning ⟨ta⟩ how are you'
})
await checkAsync('worst (lowest) segment confidence is the utterance confidence — honesty over averaging', async () => {
  let n = 0
  const spyPlatform = { run: async (req) => ({ text: `t${n}`, provider: 'g', confidence: [0.9, 0.4, 0.8][n++], confidenceBand: 'high' }) }
  const mt = createTranslationPlatformMt({ platform: spyPlatform })
  const r = await mt.translate({ segments: ['a', 'b', 'c'], sourceLang: 'en', targetLang: 'ta' }, {}).done
  return r.confidence === 0.4
})

/* -------- cancel + bounded timeout -------- */
await checkAsync('cancel() between segments stops the stream with { cancelled }', async () => {
  let calls = 0
  let ctrl = null
  const spyPlatform = { run: async () => { calls += 1; if (calls === 1) queueMicrotask(() => ctrl.cancel('barge-in')); return { text: 'ok', provider: 'g', confidence: 0.9, confidenceBand: 'high' } } }
  const mt = createTranslationPlatformMt({ platform: spyPlatform })
  ctrl = mt.translate({ segments: ['one', 'two', 'three'], sourceLang: 'en', targetLang: 'ta' }, {})
  const r = await ctrl.done
  return r.cancelled === 'barge-in' && calls === 1
})
await checkAsync('a hung platform call hits the BOUNDED segment ceiling', async () => {
  const spyPlatform = { run: () => new Promise(() => {}) }
  const mt = createTranslationPlatformMt({ platform: spyPlatform, segmentTimeoutMs: 25 })
  try { await mt.translate({ text: 'x', sourceLang: 'en', targetLang: 'ta' }, {}).done; return false } catch (e) {
    return /exceeded 25ms ceiling/.test(e.message)
  }
})

/* -------- the decision log is bounded -------- */
await checkAsync('decision log never grows past its cap', async () => {
  const { platform } = fakeTranslationPlatform()
  const mt = createTranslationPlatformMt({ platform })
  for (let i = 0; i < 50; i++) await mt.translate({ text: `m${i}`, sourceLang: 'en', targetLang: 'ta' }, {}).done
  return mt.decisionLog().length === 32
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  MT stage — live captions through the #51 platform')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
