/**
 * Cross-provider consensus, adjudication, and honest uncertainty (design §6.3–6.5).
 *
 * The ladder: agree → adjudicated → single → uncertain. Confidence is DERIVED
 * from the verification outcome (a measured fact), never fabricated; and when
 * nothing meets the threshold the result is explicitly `uncertain`, not a
 * confident-looking guess. The judge is injected, so this runs offline.
 *
 *   node test/translation-verify.test.js
 */
import {
  normalizeForAgreement, agree, consensus, adjudicate, outcomeConfidence,
  uncertainResult, resolve, ACCEPT_THRESHOLD
} from '../src/lib/translation/verify.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }
const checkAsync = async (name, fn) => { names.push(name); try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

/* ---------------------------------------------------------- 1. agreement --- */

check('agreement ignores trivial punctuation and whitespace, not meaning', () =>
  agree('I will come.', 'i will come') === true &&
  agree('vandhutta', 'vandhutta?') === true &&
  agree('yes', 'no') === false &&
  normalizeForAgreement('  Hello!!  ') === 'hello')

check('empty strings never "agree"', () => agree('', '') === false && agree('x', '') === false)

/* ------------------------------------------------------- 2. consensus ------ */

check('two engines that agree → outcome agree', () => {
  const c = consensus([{ text: 'hello', engine: 'a' }, { text: 'hello', engine: 'b' }], 'en')
  return c.outcome === 'agree' && c.text === 'hello'
})

check('one survivor → single', () => {
  const c = consensus([{ text: 'hello', engine: 'a' }], 'en')
  return c.outcome === 'single' && c.provider === 'a'
})

check('two that disagree → disagree (a candidate for adjudication)', () => {
  const c = consensus([{ text: 'hello', engine: 'a' }, { text: 'hi there', engine: 'b' }], 'en')
  return c.outcome === 'disagree' && c.disagreement === true
})

check('a WRONG-SCRIPT candidate is dropped before consensus, not translated', () => {
  // Devanagari answer for a Kannada target is shed by the engine\'s scriptOk.
  const c = consensus([{ text: 'नल पॉइंटर', engine: 'a' }, { text: 'ಸರಿ', engine: 'b' }], 'kn')
  return c.outcome === 'single' && c.provider === 'b' && c.wrongScript === 1
})

check('all wrong-script → outcome none', () => {
  const c = consensus([{ text: 'नमस्ते', engine: 'a' }], 'kn') // Devanagari for Kannada
  return c.outcome === 'none' && c.text === null
})

/* ---------------------------------------------------- 3. derived confidence */

check('confidence is DERIVED from the outcome, and only there', () =>
  outcomeConfidence('agree').confidence === 0.95 && outcomeConfidence('agree').band === 'confirmed' &&
  outcomeConfidence('adjudicated').confidence === 0.78 &&
  outcomeConfidence('single').confidence === 0.60 &&
  outcomeConfidence('none').confidence === 0.20)

check('the accept threshold is the single-band floor', () => ACCEPT_THRESHOLD === 0.50)

/* ------------------------------------------------------- 4. adjudication --- */

await checkAsync('a judge resolves a disagreement, and its wrong-script verdict is rejected', async () => {
  const goodJudge = { id: 'openai', adjudicate: async () => ({ text: 'the right answer', pick: 'A' }) }
  const badJudge = { id: 'openai', adjudicate: async () => ({ text: 'नमस्ते', pick: 'A' }) } // wrong script for kn
  const good = await adjudicate({ text: 'orig', target: 'en', a: { text: 'a' }, b: { text: 'b' } }, { adjudicator: goodJudge })
  const bad = await adjudicate({ text: 'orig', target: 'kn', a: { text: 'ಎ' }, b: { text: 'ಬಿ' } }, { adjudicator: badJudge })
  return good?.text === 'the right answer' && good.outcome === 'adjudicated' && bad === null
})

await checkAsync('a throwing judge is not a failed request — it returns null', async () => {
  const judge = { id: 'x', adjudicate: async () => { throw new Error('judge down') } }
  const out = await adjudicate({ text: 'o', target: 'en', a: { text: 'a' }, b: { text: 'b' } }, { adjudicator: judge })
  return out === null
})

/* --------------------------------------------------------- 5. resolve() ---- */

await checkAsync('resolve: agreement is confirmed and not uncertain', async () => {
  const out = await resolve([{ text: 'ok', engine: 'a' }, { text: 'ok', engine: 'b' }], 'en')
  return out.verified === 'agree' && out.confidence === 0.95 && out.uncertain === false
})

await checkAsync('resolve: an unjudged disagreement is UNCERTAIN with an alternative', async () => {
  const out = await resolve([{ text: 'apple', engine: 'a' }, { text: 'orange', engine: 'b' }], 'en', { allowAdjudication: false })
  return out.uncertain === true && out.reason === 'engines differ, unjudged' &&
    out.text === 'apple' && out.alternative === 'orange'
})

await checkAsync('resolve: a disagreement WITH a permitted judge is adjudicated, not uncertain', async () => {
  const judge = { id: 'openai', adjudicate: async () => ({ text: 'apple', pick: 'A' }) }
  let reasonRecorded = null
  const out = await resolve([{ text: 'apple', engine: 'a' }, { text: 'orange', engine: 'b' }], 'en', {
    allowAdjudication: true, adjudicator: judge, onFanout: (r) => { reasonRecorded = r; return true }
  })
  return out.verified === 'adjudicated' && out.uncertain === false && typeof reasonRecorded === 'string'
})

await checkAsync('resolve: adjudication is SKIPPED when the fan-out budget refuses it', async () => {
  const judge = { id: 'openai', adjudicate: async () => ({ text: 'apple', pick: 'A' }) }
  let judged = false
  const out = await resolve([{ text: 'apple', engine: 'a' }, { text: 'orange', engine: 'b' }], 'en', {
    allowAdjudication: true, adjudicator: { id: 'openai', adjudicate: async () => { judged = true; return judge.adjudicate() } }, onFanout: () => false
  })
  return judged === false && out.uncertain === true // fell back to unjudged
})

await checkAsync('resolve: nothing survives the script gate → uncertain, no text fabricated', async () => {
  const out = await resolve([{ text: 'नमस्ते', engine: 'a' }], 'kn')
  return out.uncertain === true && out.text === null && out.confidence === 0.20
})

check('uncertainResult never fabricates a confident number', () => {
  const withBest = uncertainResult('unjudged', { text: 'best', provider: 'a' })
  const nothing = uncertainResult('none')
  return withBest.uncertain === true && withBest.confidence < ACCEPT_THRESHOLD &&
    nothing.text === null && nothing.confidenceBand === 'degraded'
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — consensus, adjudication, uncertainty')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
