/**
 * Spot Me — one honest answer to "can this device store anything?"
 *
 * THE BUG THIS EXISTS TO END. Three separate modules opened IndexedDB, and all
 * three answered the question wrongly in the same direction:
 *
 *   - `identity-store.js` did `try { await openDb() } catch { return null }`.
 *     The exception carried the ONLY explanation of what was wrong — a
 *     SecurityError, a QuotaExceededError, an UnknownError from an evicted
 *     store — and it was dropped on the floor. The banner then said "private
 *     browsing is the usual cause", which is a GUESS presented as a diagnosis,
 *     and it was unfalsifiable because nothing recorded the truth.
 *   - `blobstore.available()` returned true whenever the `indexedDB` GLOBAL
 *     existed. On iOS in private mode that global exists and `open()` fails, so
 *     the honest answer and the reported answer were opposites. Everything
 *     downstream believed media would become durable, and it never did.
 *   - the fallback then base64'd video into localStorage at ~1.33x against a
 *     5–10 MB quota, blew it, and shed the video.
 *
 * So: one probe, one recorded reason, one place to ask. Nothing here guesses.
 * If we do not know why, we say we do not know why and we say what we tried.
 *
 * NOTHING HERE THROWS. It is diagnostics; a diagnostic that can take the app
 * down is worse than no diagnostic.
 */

/** The real reason the last open failed, or null. Never a guess. */
let failure = null
/** Cached verdict: null = not probed, true/false = probed. */
let usable = null
let probing = null

/**
 * Record why a real open failed, from the module that saw it.
 *
 * `err` is whatever IndexedDB gave us — usually a DOMException, occasionally a
 * plain Error from a synchronous throw in `indexedDB.open` itself, and on some
 * WebViews `null`, because `req.error` is not populated. All three are recorded
 * as what they are.
 */
export function recordOpenFailure (dbName, err, phase = 'open') {
  failure = {
    db: dbName,
    phase,                                     // open | blocked | timeout | read
    name: err?.name || (err === null ? '(no error object)' : typeof err),
    message: err?.message || String(err ?? '').slice(0, 300) || '(empty message)',
    at: new Date().toISOString()
  }
  usable = false
}

export function recordOpenSuccess () {
  failure = null
  usable = true
}

/** The recorded reason, or null if nothing has failed. */
export const lastFailure = () => failure

/**
 * Actually try to open a database, once, and cache the verdict.
 *
 * This is the difference between "the API exists" and "the API works", and it
 * is the whole point of the module: `typeof indexedDB !== 'undefined'` is true
 * in iOS private mode, where every open fails.
 *
 * A throwaway database, deleted after: probing the real ones would race their
 * own open logic and, worse, an upgrade.
 */
export function probeIndexedDb () {
  if (usable !== null) return Promise.resolve(usable)
  if (probing) return probing
  probing = new Promise((resolve) => {
    let req
    try {
      if (typeof indexedDB === 'undefined' || indexedDB === null) {
        recordOpenFailure('(probe)', new Error('indexedDB is not defined on this device'))
        return resolve(false)
      }
      req = indexedDB.open('spotme-probe', 1)
    } catch (err) {
      // Safari throws synchronously here in some locked-down configurations
      // rather than firing onerror.
      recordOpenFailure('(probe)', err)
      return resolve(false)
    }
    /* A BLOCKED OR HUNG OPEN IS A FAILURE, NOT A WAIT.
     *
     * `indexedDB.open` can fire neither onsuccess nor onerror: `onblocked` when
     * another tab holds an old version, and nothing at all on iOS when the tab
     * is suspended mid-open. Without this timeout the promise never settles and
     * every caller awaiting it hangs forever — which is indistinguishable, from
     * the outside, from the app being slow. */
    const done = (ok, err, phase) => {
      clearTimeout(timer)
      if (ok) recordOpenSuccess(); else recordOpenFailure('(probe)', err, phase)
      try { req.result?.close() } catch { /* nothing to close */ }
      try { indexedDB.deleteDatabase('spotme-probe') } catch { /* best effort */ }
      resolve(ok)
    }
    const timer = setTimeout(() => done(false, new Error('open did not settle within 3000ms'), 'timeout'), 3000)
    req.onsuccess = () => done(true)
    req.onerror = () => done(false, req.error, 'open')
    req.onblocked = () => done(false, new Error('open blocked by another tab holding an older version'), 'blocked')
  }).finally(() => { probing = null })
  return probing
}

/** The cached verdict without probing. `null` means "not asked yet". */
export const isUsable = () => usable

/**
 * Everything we know about storage on this device, for the report and the
 * banner. Safe to log: no message content, no keys, no identifiers.
 */
export async function storageReport () {
  const idb = await probeIndexedDb()
  const out = {
    indexedDb: idb ? 'ok' : 'unavailable',
    reason: failure,
    localStorage: 'unknown',
    quotaBytes: null,
    usageBytes: null,
    persisted: null,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '(none)'
  }

  try {
    const k = '__spotme_probe__'
    localStorage.setItem(k, '1')
    localStorage.removeItem(k)
    out.localStorage = 'ok'
  } catch (e) {
    out.localStorage = `unavailable: ${e?.name || 'error'}`
  }

  // The numbers that decide whether a given file can possibly fit. Absent on
  // older WebKit, which is itself worth knowing, so it is reported as null
  // rather than filled in with an invented default.
  try {
    const est = await navigator.storage?.estimate?.()
    if (est) { out.quotaBytes = est.quota ?? null; out.usageBytes = est.usage ?? null }
  } catch { /* not exposed here */ }
  try { out.persisted = await navigator.storage?.persisted?.() ?? null } catch { /* not exposed */ }

  return out
}

/**
 * One line a person can act on, built from what we actually observed.
 *
 * Deliberately NOT "private browsing is the usual cause" unless the evidence
 * says so. That sentence was shipped as the explanation for every failure mode
 * at once, so someone whose storage had been EVICTED was told to turn off a
 * setting they were not using.
 */
export function explainFailure (f = failure) {
  if (!f) return null
  const n = String(f.name || '')
  if (n === 'SecurityError') return 'Storage is blocked for this site — check Settings → Safari → Block All Cookies, or private browsing.'
  if (n === 'QuotaExceededError') return 'This device is out of storage for this site.'
  if (n === 'VersionError') return 'A newer version of Spot Me has already run here. Reload the page.'
  if (f.phase === 'blocked') return 'Another Spot Me tab is holding storage open. Close the other tabs and reload.'
  if (f.phase === 'timeout') return 'Storage did not respond. This usually clears after a reload.'
  if (n === 'InvalidStateError') return 'Storage was shut down by the browser, usually private browsing.'
  if (n === 'UnknownError') return 'The browser refused storage without saying why — on iOS this is usually a full device or an evicted site.'
  return `Storage is unavailable (${f.name}).`
}
