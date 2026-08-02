/**
 * N-way fan-out — the who-hears-what matrix (WS3 design §6; mission item 3).
 * Distinct-language legs, shared STT accounting, speaker exclusion,
 * same-language caption-only lanes, and the §14.3 concurrency/cost bound.
 *
 *   node test/live-voice-fanout.test.js
 */
import { fanoutForUtterance, whoHearsWhatMatrix, planCall, normalizeParticipant } from '../src/lib/live-voice/fanout.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const A = { id: 'A', listenLang: 'en', speakLang: 'en', voiceId: 'VOICEaaaa1111', consented: true }
const B = { id: 'B', listenLang: 'ta' }
const C = { id: 'C', listenLang: 'hi' }
const D = { id: 'D', listenLang: 'ta' }
const E = { id: 'E', listenLang: 'en' }

/* -------- the §6.2 canonical example: A(en) speaking to B(ta), C(hi) -------- */
check('A speaks en → legs are exactly ta and hi (sorted), one listener each', () => {
  const f = fanoutForUtterance([A, B, C], 'A', 'en')
  return JSON.stringify(f.legs) === JSON.stringify([
    { targetLang: 'hi', listeners: ['C'] },
    { targetLang: 'ta', listeners: ['B'] }
  ])
})
check('the speaker is excluded — nothing added for A', () => {
  const f = fanoutForUtterance([A, B, C], 'A', 'en')
  return f.excluded.length === 1 && f.excluded[0] === 'A' &&
    f.legs.every((l) => !l.listeners.includes('A')) &&
    f.captionOnly.every((c) => !c.listeners.includes('A'))
})
check('exactly ONE STT pass regardless of listener count', () => {
  return fanoutForUtterance([A, B, C, D, E], 'A', 'en').sttPasses === 1
})

/* -------- distinct-language collapsing (the §6.3 cost rule) -------- */
check('five listeners, two in ta → ta is ONE leg with both listeners', () => {
  const f = fanoutForUtterance([A, B, C, D, E], 'A', 'en')
  const ta = f.legs.find((l) => l.targetLang === 'ta')
  return ta && JSON.stringify(ta.listeners) === JSON.stringify(['B', 'D'])
})
check('same-language listeners cost ZERO translation legs (captions only)', () => {
  const f = fanoutForUtterance([A, B, C, D, E], 'A', 'en')
  return f.legs.length === 2 && // ta + hi, NOT en
    f.captionOnly.length === 1 && JSON.stringify(f.captionOnly[0].listeners) === JSON.stringify(['E'])
})
check('everyone-wants-english costs ONE leg, not four (the 5-person rule)', () => {
  const five = [
    { id: 'S', listenLang: 'ta', speakLang: 'ta' },
    { id: 'p1', listenLang: 'en' }, { id: 'p2', listenLang: 'en' },
    { id: 'p3', listenLang: 'en' }, { id: 'p4', listenLang: 'en' }
  ]
  const f = fanoutForUtterance(five, 'S', 'ta')
  return f.legs.length === 1 && f.legs[0].listeners.length === 4
})

/* -------- who-hears-what matrix -------- */
check('matrix rows: self for own speech, captions for same lang, voice otherwise', () => {
  const rows = whoHearsWhatMatrix([A, B, C])
  const get = (s, l) => rows.find((r) => r.speaker === s && r.listener === l)
  return get('A', 'A').mode === 'self' &&
    get('A', 'B').mode === 'voice' && get('A', 'B').lang === 'ta' &&
    get('A', 'C').mode === 'voice' && get('A', 'C').lang === 'hi' &&
    get('B', 'A').mode === 'voice' && get('B', 'A').lang === 'en'
})
check('matrix labels clone vs generic voice by enrolment', () => {
  const rows = whoHearsWhatMatrix([A, B])
  const aToB = rows.find((r) => r.speaker === 'A' && r.listener === 'B')
  const bToA = rows.find((r) => r.speaker === 'B' && r.listener === 'A')
  return aToB.voice === 'clone' && bToA.voice === 'generic'
})
check('matrix covers every (speaker, listener) pair exactly once', () => {
  const rows = whoHearsWhatMatrix([A, B, C, D])
  return rows.length === 16 && new Set(rows.map((r) => `${r.speaker}>${r.listener}`)).size === 16
})

/* -------- planCall: the §14.3 cost driver -------- */
check('planCall exposes sttPasses, legs and the concurrency bound', () => {
  const plan = planCall([A, B, C])
  return plan.sttPasses === 3 && plan.mtTtsLegs === 6 && plan.concurrencyBound === 6 &&
    /3 active speakers/.test(plan.costDriver)
})
check('planCall with one active speaker bounds to that speaker only', () => {
  const plan = planCall([A, B, C], { activeSpeakers: ['A'] })
  return plan.sttPasses === 1 && plan.mtTtsLegs === 2
})

/* -------- validation -------- */
check('unresolved auto sourceLang refuses fan-out (STT resolves it first)', () => {
  try { fanoutForUtterance([A, B], 'B', 'auto'); return false } catch (e) { return /resolved/.test(e.message) }
})
check('unknown speaker refuses', () => {
  try { fanoutForUtterance([A, B], 'Z', 'en'); return false } catch (e) { return /unknown speaker/.test(e.message) }
})
check('participant without listenLang refuses', () => {
  try { normalizeParticipant({ id: 'X' }); return false } catch (e) { return /listenLang/.test(e.message) }
})

/* -------- 3-party multilingual: each speaker's turn fans correctly -------- */
check('B(ta) speaking: legs en (A) + hi (C); C hears in hi even mid-conversation', () => {
  const f = fanoutForUtterance([A, B, C], 'B', 'ta')
  return JSON.stringify(f.legs) === JSON.stringify([
    { targetLang: 'en', listeners: ['A'] },
    { targetLang: 'hi', listeners: ['C'] }
  ])
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  fan-out — who hears what, at what cost (§6)')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
process.exit(passed === names.length ? 0 : 1)
