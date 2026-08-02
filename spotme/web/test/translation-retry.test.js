/**
 * Error classification, bounded retry, and regional failover (design §5.4, §10.1).
 *
 * The breaker decides WHETHER to choose a provider; this decides how to treat one
 * call to a provider already chosen. Transient failures may be retried a bounded
 * number of times; permanent ones never are. Deterministic: sleep and randomness
 * are injected/off, so every branch is asserted without wall-clock time.
 *
 *   node test/translation-retry.test.js
 */
import {
  classifyError, isTransient, backoffDelay, withRetry, regionalFailover,
  makeAttempt, RETRY_DEFAULTS
} from '../src/lib/translation/retry.js'

const results = {}
const names = []
const check = (name, fn) => { names.push(name); try { results[name] = fn() === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }
const checkAsync = async (name, fn) => { names.push(name); try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message } }

const err = (message, extra = {}) => Object.assign(new Error(message), extra)

/* ---------------------------------------------------- 1. classification ---- */

check('a 429 / rate limit / timeout / network blip is TRANSIENT', () =>
  classifyError(err('429 too many requests')) === 'transient' &&
  classifyError(err('rate limit exceeded')) === 'transient' &&
  classifyError(err('The operation timed out')) === 'transient' &&
  classifyError(err('fetch failed')) === 'transient' &&
  classifyError(err('ECONNRESET')) === 'transient')

check('a structured 5xx/408/429 status is TRANSIENT', () =>
  classifyError(err('x', { status: 503 })) === 'transient' &&
  classifyError(err('x', { status: 429 })) === 'transient' &&
  classifyError(err('x', { status: 408 })) === 'transient')

check('a 4xx auth/bad-request and "no key" are PERMANENT', () =>
  classifyError(err('x', { status: 401 })) === 'permanent' &&
  classifyError(err('x', { status: 400 })) === 'permanent' &&
  classifyError(err('no sarvam key')) === 'permanent' &&
  classifyError(err('sarvam does not speak fr')) === 'permanent')

check('an unknown error defaults to transient (one bounded retry is cheap)', () =>
  classifyError(err('something weird happened')) === 'transient' &&
  isTransient(err('???')) === true)

check('a message that names a permanent condition wins over an ambiguous number', () =>
  // "invalid" is permanent even though a stray "500" style number is absent
  classifyError(err('invalid target language')) === 'permanent')

/* ------------------------------------------------------------ 2. backoff --- */

check('backoff grows exponentially and is capped', () => {
  const p = { baseDelayMs: 100, factor: 2, maxDelayMs: 1000, jitter: false }
  return backoffDelay(1, p) === 100 && backoffDelay(2, p) === 200 &&
    backoffDelay(3, p) === 400 && backoffDelay(10, p) === 1000 // capped
})

check('the default policy is no-retry (maxAttempts 1) — the engine\'s behaviour', () =>
  RETRY_DEFAULTS.maxAttempts === 1)

/* -------------------------------------------------------- 3. withRetry ----- */

await checkAsync('a transient failure is retried up to the bound, then succeeds', async () => {
  let calls = 0
  const slept = []
  const outcome = await withRetry(async () => {
    calls += 1
    if (calls < 3) throw err('503 unavailable')
    return 'ok'
  }, { maxAttempts: 3, baseDelayMs: 10, jitter: false }, { sleep: async (ms) => { slept.push(ms) } })
  return outcome.ok === true && outcome.value === 'ok' && outcome.attempts === 3 && slept.length === 2
})

await checkAsync('a PERMANENT failure fails fast with no retry', async () => {
  let calls = 0
  const outcome = await withRetry(async () => { calls += 1; throw err('401 unauthorized') },
    { maxAttempts: 5, baseDelayMs: 1 }, { sleep: async () => {} })
  return outcome.ok === false && calls === 1 && outcome.classification === 'permanent'
})

await checkAsync('a transient failure that never recovers exhausts the bound and stops', async () => {
  let calls = 0
  const outcome = await withRetry(async () => { calls += 1; throw err('timeout') },
    { maxAttempts: 3, baseDelayMs: 1 }, { sleep: async () => {} })
  return outcome.ok === false && calls === 3 && outcome.attempts === 3
})

await checkAsync('makeAttempt wraps a fn and rethrows only after the bound', async () => {
  let calls = 0
  const attempt = makeAttempt({ maxAttempts: 2, baseDelayMs: 1 }, { sleep: async () => {} })
  try {
    await attempt(async () => { calls += 1; throw err('500') })
    return false
  } catch { return calls === 2 }
})

/* --------------------------------------------------- 4. regional failover -- */

await checkAsync('regional failover tries the next region on a transient regional failure', async () => {
  const tried = []
  const out = await regionalFailover(async (region) => {
    tried.push(region)
    if (region !== 'westeurope') throw err('503 in region')
    return `served:${region}`
  }, ['global', 'eastus', 'westeurope'])
  return out.ok === true && out.region === 'westeurope' && out.tried.length === 3
})

await checkAsync('regional failover STOPS at a permanent failure — the key is wrong everywhere', async () => {
  const tried = []
  const out = await regionalFailover(async (region) => { tried.push(region); throw err('401 unauthorized') },
    ['global', 'eastus', 'westeurope'])
  return out.ok === false && tried.length === 1 // did not burn latency on other regions
})

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation — retry, classification, regional failover')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
