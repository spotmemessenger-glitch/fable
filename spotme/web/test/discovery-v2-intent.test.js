/**
 * Discovery V2 query-intent — a deterministic, pure, structured parser. No LLM,
 * no network, no personalisation; explicit user intent always wins.
 *
 *   node test/discovery-v2-intent.test.js
 */
import {
  deriveIntent, baselineParse, baselineIntentProvider, isValidIntentProvider
} from '../src/lib/discovery-v2/intent.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

check('baselineParse maps "coffee" → cafe category (transparent keyword map)', (() => {
  return baselineParse('a good coffee').category === 'cafe'
})())

check('baselineParse detects "open now" → filters.openNow', (() => {
  return baselineParse('pizza open now').filters.openNow === true
})())

check('DETERMINISTIC: same text → identical intent', (() => {
  const a = JSON.stringify(deriveIntent('sushi restaurant open now'))
  const b = JSON.stringify(deriveIntent('sushi restaurant open now'))
  return a === b
})())

check('deriveIntent is synchronous (no promise, no I/O)', (() => {
  const out = deriveIntent('bar')
  return out && typeof out.then !== 'function' && out.category === 'drink'
})())

check('explicit user category WINS over inferred', (() => {
  const out = deriveIntent('coffee', { baseQuery: { category: 'food' } })
  return out.category === 'food' // not overridden to cafe
})())

check('the built-in provider is a valid intent provider', (() => {
  return isValidIntentProvider(baselineIntentProvider)
})())

check('a custom provider can be plugged in', (() => {
  const custom = { name: 'c', parse: () => ({ category: 'outdoors', filters: {}, cleanedText: 'x' }) }
  return deriveIntent('anything', { provider: custom }).category === 'outdoors'
})())

check('a THROWING provider degrades gracefully (no enrichment, no throw)', (() => {
  const bad = { name: 'bad', parse: () => { throw new Error('x') } }
  const out = deriveIntent('coffee', { provider: bad })
  return out.category === null && out.text === 'coffee'
})())

check('no personalisation input exists — signature takes only text + opts', (() => {
  // deriveIntent(text, opts) — there is no person/profile parameter to pass.
  return deriveIntent.length <= 2
})())

console.log('\n========== discovery-v2 intent ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
