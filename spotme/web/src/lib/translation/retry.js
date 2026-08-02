/**
 * Spot Me — transient/permanent classification, bounded retry, regional failover
 * (design §5.4, §10.1). The companion to the circuit breaker: the breaker decides
 * whether to CHOOSE a provider at all; this decides how to TREAT one call to a
 * provider the router already chose.
 *
 * THREE THINGS THE ENGINE DOES IMPLICITLY, MADE EXPLICIT AND TESTABLE:
 *
 *  1. CLASSIFICATION. Not every failure is equal. A 429/timeout/network blip is
 *     TRANSIENT — the same call might succeed a moment later. A 400 bad-request,
 *     a 401/403 auth failure, or "no <vendor> key" is PERMANENT — retrying spends
 *     latency to fail again. The engine already encodes this knowledge ad hoc
 *     (its 429 branch, its "no key" throws); here it is one function.
 *
 *  2. BOUNDED RETRY. A transient failure may be retried a small, bounded number
 *     of times with exponential backoff; a permanent one never is. Bounded is the
 *     whole point — an unbounded retry is how one slow vendor becomes an outage.
 *
 *  3. REGIONAL FAILOVER. A provider that publishes multiple regions
 *     (capabilities.regions) can be re-tried in the next region on a transient
 *     regional failure, before the router sheds it for a different provider.
 *
 * DETERMINISTIC BY DESIGN. `sleep` and `now` are injected, and jitter is OFF by
 * default, so a test drives every branch without wall-clock time. No network, no
 * vendor, no key here — this operates on already-thrown errors and injected fns.
 */

/** Retry policy defaults. maxAttempts:1 means "no retry" — the safe default. */
export const RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 1, // total attempts incl. the first; 1 = the engine's behaviour
  baseDelayMs: 200,
  factor: 2, // exponential
  maxDelayMs: 4000,
  jitter: false // deterministic by default; a real deploy may enable it
})

/**
 * Signals that mean "try again might work" — HTTP 408/429/500/502/503/504, an
 * AbortSignal.timeout (`TimeoutError`/`AbortError`), and the network-level
 * failures fetch throws. Matched on both a structured `.status`/`.code` and the
 * message text, because the engine's errors are plain `Error(message)`.
 */
const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])
const TRANSIENT_MESSAGE = /\b(429|408|500|502|503|504)\b|rate.?limit|too many requests|timeout|timed out|aborted|abort|econnreset|etimedout|enotfound|econnrefused|socket hang up|network|fetch failed|temporarily|unavailable|overloaded/i
const PERMANENT_MESSAGE = /\b(400|401|403|404|422)\b|no .*key|unauthor|forbidden|invalid|not found|bad request|unsupported|does not speak|malformed/i

/**
 * Classify an error as 'transient' or 'permanent'. Structured status/code wins
 * over message text; an unknown error is treated as TRANSIENT once (conservative
 * — one bounded retry is cheap, and giving up on an unrecognised blip is worse
 * than one extra call), but a message that clearly names a permanent condition
 * ("no key", 401, "does not speak kn") is permanent even without a status.
 */
export function classifyError (err) {
  if (!err) return 'transient'
  const status = Number(err.status ?? err.statusCode ?? err.code)
  if (Number.isFinite(status)) {
    if (TRANSIENT_STATUS.has(status)) return 'transient'
    if (status >= 400 && status < 500) return 'permanent'
  }
  const msg = String(err.message || err)
  // A permanent signal in the text is decisive even if a number also matches.
  if (PERMANENT_MESSAGE.test(msg) && !/\b(429|408|500|502|503|504)\b/.test(msg)) return 'permanent'
  if (TRANSIENT_MESSAGE.test(msg)) return 'transient'
  return 'transient'
}

/** Is this error worth retrying? (the boolean form of classifyError). */
export const isTransient = (err) => classifyError(err) === 'transient'

/** The backoff delay before attempt N (1-based). Exponential, capped. */
export function backoffDelay (attempt, policy = RETRY_DEFAULTS) {
  const p = { ...RETRY_DEFAULTS, ...policy }
  const raw = p.baseDelayMs * Math.pow(p.factor, Math.max(0, attempt - 1))
  const capped = Math.min(raw, p.maxDelayMs)
  if (!p.jitter) return capped
  // Full jitter, only when explicitly enabled (never in tests).
  return Math.floor(Math.random() * capped)
}

/**
 * Run `fn` with a bounded retry over TRANSIENT failures only. Permanent failures
 * fail fast (no retry). Returns `{ ok, value?, error?, attempts, classification? }`
 * — it never throws, so a caller in a pipeline can branch on the outcome rather
 * than wrap every call in try/catch.
 *
 * @param {() => Promise<any>} fn         the call to attempt (e.g. a provider op)
 * @param {object} [policy]               RETRY_DEFAULTS overrides
 * @param {{sleep?: (ms:number)=>Promise<void>, onRetry?: Function}} [deps]  injected
 */
export async function withRetry (fn, policy = {}, deps = {}) {
  const p = { ...RETRY_DEFAULTS, ...policy }
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const maxAttempts = Math.max(1, p.maxAttempts | 0)
  let lastError = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const value = await fn(attempt)
      return { ok: true, value, attempts: attempt }
    } catch (err) {
      lastError = err
      const kind = classifyError(err)
      const more = attempt < maxAttempts
      if (kind === 'permanent' || !more) {
        return { ok: false, error: err, attempts: attempt, classification: kind }
      }
      if (typeof deps.onRetry === 'function') deps.onRetry({ attempt, error: err, kind })
      await sleep(backoffDelay(attempt + 1, p))
    }
  }
  return { ok: false, error: lastError, attempts: maxAttempts, classification: classifyError(lastError) }
}

/**
 * Regional failover: try `call(region)` across a provider's regions in order,
 * stopping at the first success or the first PERMANENT failure (a permanent
 * failure is not region-specific — the key is wrong everywhere — so re-trying
 * other regions only burns latency). Transient regional failures move on to the
 * next region. Returns the same `{ ok, value?, error?, region?, tried }` shape.
 *
 * @param {(region: string) => Promise<any>} call
 * @param {string[]} regions
 */
export async function regionalFailover (call, regions = ['global']) {
  const list = Array.isArray(regions) && regions.length ? regions : ['global']
  const tried = []
  let lastError = null
  for (const region of list) {
    tried.push(region)
    try {
      const value = await call(region)
      return { ok: true, value, region, tried }
    } catch (err) {
      lastError = err
      if (classifyError(err) === 'permanent') break
    }
  }
  return { ok: false, error: lastError, tried }
}

/**
 * Build a per-provider `attempt(fn, meta)` wrapper the router can be given
 * (deps.attempt) to add bounded retry to the primary route without changing the
 * router's default (no wrapper) behaviour. `onRetry` receives {attempt,error,kind}
 * so the pipeline can count retries in its metrics.
 */
export function makeAttempt (policy = {}, deps = {}) {
  return async function attempt (fn) {
    const outcome = await withRetry(fn, policy, deps)
    if (outcome.ok) return outcome.value
    throw outcome.error
  }
}
