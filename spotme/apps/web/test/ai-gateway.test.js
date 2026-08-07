/**
 * AI Gateway baselines — deterministic, no model, no keys, no network.
 *
 * Proves the honest floor behaves: intent parse is stable and typed, similarity
 * is a real [0,1] Jaccard, summary is extractive and bounded, and voice is an
 * explicit no-op that never pretends to have transcribed.
 *
 *   node test/ai-gateway.test.js
 */
import { createAiGateway, intentBaseline, summaryBaseline, voiceBaseline } from '../src/lib/ai/index.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* -------------------------------------------------- intent ------------------ */
{
  const a = intentBaseline.parse('Leaking kitchen tap, need it fixed tonight')
  check('intent.parse classifies a request as a need', a.type === 'need')
  check('intent.parse extracts stable, stopword-free keywords',
    a.keywords.includes('leaking') && a.keywords.includes('tap') && !a.keywords.includes('need'))
  check('intent.parse confidence is in [0,1] and never 1.0', a.confidence > 0 && a.confidence < 1)
  check('intent.parse is deterministic',
    JSON.stringify(a) === JSON.stringify(intentBaseline.parse('Leaking kitchen tap, need it fixed tonight')))

  const offer = intentBaseline.parse('Offering plumbing services, available tonight')
  check('intent.parse detects an offer', offer.type === 'offer')

  const b = intentBaseline.parse('Kitchen tap leaking, plumber wanted')
  const sim = intentBaseline.similarity(a, b)
  check('intent.similarity is a [0,1] score', sim >= 0 && sim <= 1)
  check('intent.similarity sees overlap between related intents', sim > 0)
  check('intent.similarity of disjoint intents is 0',
    intentBaseline.similarity(
      intentBaseline.parse('sell mountain bike'),
      intentBaseline.parse('french tutor available')) === 0)
}

/* -------------------------------------------------- summary ----------------- */
{
  const short = 'A short note.'
  check('summary returns short text unchanged', summaryBaseline.summarize(short) === short)

  const long = 'First sentence is the gist. ' + 'padding '.repeat(60)
  const s = summaryBaseline.summarize(long, { maxChars: 40 })
  check('summary is bounded by maxChars (plus ellipsis)', s.length <= 41)
  check('summary is deterministic',
    summaryBaseline.summarize(long, { maxChars: 40 }) === s)
}

/* -------------------------------------------------- voice ------------------- */
{
  const t = voiceBaseline.transcribe(new Uint8Array([1, 2, 3]))
  check('voice.transcribe is an honest no-op (empty text, named engine, 0 conf)',
    t.text === '' && t.engine === 'baseline-noop' && t.confidence === 0)
  const syn = voiceBaseline.synthesize('hello')
  check('voice.synthesize produces no audio and names itself no-op',
    syn.audio === null && syn.engine === 'baseline-noop' && syn.text === 'hello')
}

/* -------------------------------------------------- gateway ----------------- */
{
  const gw = createAiGateway()
  check('createAiGateway defaults every port to its baseline',
    gw.intent === intentBaseline && gw.summary === summaryBaseline && gw.voice === voiceBaseline)
  const custom = { parse: () => ({ type: 'need', category: 'x', keywords: [], confidence: 0.5 }), similarity: () => 1 }
  check('createAiGateway lets a port be overridden (adapter injection point)',
    createAiGateway({ intent: custom }).intent === custom)
}

console.log('\n========================================')
console.log('  AI Gateway — deterministic baselines, no model, no keys')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
