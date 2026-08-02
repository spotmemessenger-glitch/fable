/**
 * Context-aware translation (design §8): a BOUNDED window (turns AND chars),
 * speaker labels, previous-turn language, glossary hits, per-conversation prefs,
 * newest-first truncation, privacy-aware mode selection, and the fingerprint that
 * keeps one conversation's context out of another's cache. All pure.
 *
 *   node test/translation-context.test.js
 */
import {
  createContextWindow, truncateTurns, glossaryHits, buildContext, contextFingerprint,
  CONTEXT_DEFAULTS
} from '../src/lib/translation/context.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/* ------------------------------------------------------- 1. bounded window - */

check('the window is bounded in TURNS — the oldest is dropped, never unbounded', () => {
  const w = createContextWindow({ maxTurns: 3 })
  for (let i = 0; i < 6; i++) w.add({ speaker: 'a', text: `turn ${i}` })
  return w.size === 3 && w.turns()[0].text === 'turn 3' && w.turns()[2].text === 'turn 5'
})

check('a malformed turn is ignored, not stored', () => {
  const w = createContextWindow()
  w.add(null); w.add({ speaker: 'a' }); w.add({ text: 'ok', speaker: 'a' })
  return w.size === 1
})

/* --------------------------------------------------------- 2. truncation --- */

check('truncation keeps newest turns within the char budget', () => {
  const turns = [{ speaker: 'a', text: 'x'.repeat(100) }, { speaker: 'b', text: 'y'.repeat(100) }, { speaker: 'a', text: 'z'.repeat(100) }]
  const kept = truncateTurns(turns, 250) // fits the two newest (200 chars)
  return kept.length === 2 && kept[0].text.startsWith('y') && kept[1].text.startsWith('z')
})

check('a single over-budget most-recent turn is clipped, never dropped entirely', () => {
  const kept = truncateTurns([{ speaker: 'a', text: 'q'.repeat(1000) }], 50)
  return kept.length === 1 && kept[0].truncated === true && kept[0].text.length === 50
})

/* ---------------------------------------------------------- 3. glossary ---- */

check('glossaryHits finds only the terms present, case-insensitively', () => {
  const hits = glossaryHits('deploy the Ruflo build to Spotme now', ['Ruflo', 'SpotMe', 'Bitcoin'])
  return hits.includes('Ruflo') && hits.includes('SpotMe') && !hits.includes('Bitcoin')
})

/* -------------------------------------------------------- 4. buildContext -- */

check('buildContext assembles speakers, previous language, glossary and prefs', () => {
  const w = createContextWindow()
  w.add({ speaker: 'alice', text: 'ne epadi iruka', lang: 'ta' })
  w.add({ speaker: 'bob', text: 'naan nalla iruken', lang: 'ta' })
  const ctx = buildContext('varen', w, { glossary: ['varen'], prefs: { targetLang: 'en', formality: 'casual' } })
  return ctx.speakers.sort().join(',') === 'alice,bob' && ctx.previousLang === 'ta' &&
    ctx.glossary.includes('varen') && ctx.prefs.formality === 'casual' && ctx.turnCount === 2
})

check('PII in the current message raises the privacy floor to sensitive', () => {
  const w = createContextWindow()
  const clean = buildContext('naan varen', w, {})
  const withPII = buildContext('my email is foo@bar.com', w, {})
  return clean.privacyMode === 'standard' && withPII.privacyMode === 'sensitive' && withPII.hasPII === true
})

check('PII in the retained CONTEXT (not just the message) also tightens the mode', () => {
  const w = createContextWindow()
  w.add({ speaker: 'a', text: 'here is my card 4111 1111 1111 1111', lang: 'en' })
  const ctx = buildContext('ok thanks', w, {})
  return ctx.hasPII === true && ctx.privacyMode === 'sensitive'
})

check('a conversation pref can force strict, and the mode never loosens', () => {
  const w = createContextWindow()
  const ctx = buildContext('ordinary message', w, { prefs: { privacyMode: 'strict' } })
  return ctx.privacyMode === 'strict'
})

/* ------------------------------------------------------- 5. fingerprint ---- */

check('two different conversations fingerprint differently (cache isolation)', () => {
  const wa = createContextWindow(); wa.add({ speaker: 'a', text: 'private A thread', lang: 'ta' })
  const wb = createContextWindow(); wb.add({ speaker: 'b', text: 'unrelated B thread', lang: 'ta' })
  const fa = buildContext('varen', wa, {}).fingerprint
  const fb = buildContext('varen', wb, {}).fingerprint
  return typeof fa === 'string' && fa !== fb
})

check('an empty context yields a stable shared sentinel (context-free still caches)', () => {
  const w = createContextWindow()
  const f1 = buildContext('x', w, {}).fingerprint
  const f2 = buildContext('y', w, {}).fingerprint
  return f1 === f2 && f1.startsWith('none|') && CONTEXT_DEFAULTS.maxTurns > 0
})

check('the fingerprint is deterministic for the same context', () => {
  const mk = () => { const w = createContextWindow(); w.add({ speaker: 'a', text: 'same', lang: 'ta' }); return buildContext('q', w, { glossary: ['g'] }) }
  const first = contextFingerprint(mk())
  const second = contextFingerprint(mk())
  return first === second
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — context: window, truncation, glossary, fingerprint')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
