/**
 * THE SWALLOWED EXCEPTION, AND THE DOOMED UPLOAD.
 *
 * `identity-store.js` did `try { await openDb() } catch { return null }`. The
 * exception carried the only explanation there was — SecurityError, an evicted
 * store, a blocked open — and it was dropped. The banner then said "private
 * browsing is the usual cause" for every failure mode at once: a guess, printed
 * as a diagnosis, and unfalsifiable because nothing recorded the truth.
 *
 * These fences are behavioural. A test asserting "the error is logged" would
 * pass against a swallowed error that happened to be logged elsewhere; these
 * ask what a CALLER can find out, and what a reader is told.
 *
 *   node test/storage-degrade.test.js
 */

let pass = 0
let fail = 0
const check = (name, ok) => {
  if (ok) { pass++; console.log(`  PASS  ${name}`) } else { fail++; console.log(`  FAIL  ${name}`) }
}

globalThis.localStorage = {
  _m: new Map(),
  getItem (k) { return this._m.has(k) ? this._m.get(k) : null },
  setItem (k, v) { this._m.set(k, String(v)) },
  removeItem (k) { this._m.delete(k) }
}
// `navigator` is getter-only on modern Node, so it is defined rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { userAgent: 'test', storage: { estimate: async () => ({ quota: 5_000_000, usage: 10 }), persisted: async () => false } }
})

const SRC = new URL('../src/lib/', import.meta.url).href

/* ---- 1. an open that REFUSES is reported with its real name -------------- */
{
  globalThis.indexedDB = {
    open () {
      const req = {}
      setTimeout(() => {
        req.error = Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' })
        req.onerror?.()
      }, 0)
      return req
    },
    deleteDatabase () {}
  }
  const H = await import(`${SRC}storage-health.js?case=refuse`)
  const ok = await H.probeIndexedDb()
  const f = H.lastFailure()
  check('a refused open is reported unusable', ok === false)
  check('THE SWALLOWED FACT: the exception NAME survives', f?.name === 'SecurityError')
  check('…and so does its message', /insecure/.test(f?.message || ''))
  check('the advice matches the name — not a blanket private-browsing guess',
    /Block All Cookies|private browsing/.test(H.explainFailure() || ''))

  const rep = await H.storageReport()
  check('the report names the storage context', rep.quotaBytes === 5_000_000 && rep.persisted === false)
  check('localStorage is probed for real, not assumed', rep.localStorage === 'ok')
  check('no message content or key material is in the report',
    !JSON.stringify(rep).includes('privateKey'))
}

/* ---- 2. an open that never settles is a FAILURE, not a wait -------------- */
{
  globalThis.indexedDB = { open () { return {} }, deleteDatabase () {} }   // fires nothing, ever
  const H = await import(`${SRC}storage-health.js?case=hang`)
  const t0 = Date.now()
  const ok = await H.probeIndexedDb()
  const took = Date.now() - t0
  check('a hung open settles instead of blocking forever', ok === false && took < 6000)
  check('…and is reported as a timeout, not invented as something else',
    H.lastFailure()?.phase === 'timeout')
  check('the advice for a timeout is actionable', /reload/i.test(H.explainFailure() || ''))
}

/* ---- 3. a blocked open names the other tab ------------------------------- */
{
  globalThis.indexedDB = {
    open () { const r = {}; setTimeout(() => r.onblocked?.(), 0); return r },
    deleteDatabase () {}
  }
  const H = await import(`${SRC}storage-health.js?case=blocked`)
  await H.probeIndexedDb()
  check('a blocked open is distinguished from a refused one', H.lastFailure()?.phase === 'blocked')
  check('and the advice says to close the other tab', /other tab/i.test(H.explainFailure() || ''))
}

/* ---- 4. a working store reports usable, with no failure ------------------ */
{
  globalThis.indexedDB = {
    open () { const r = { result: { close () {} } }; setTimeout(() => r.onsuccess?.(), 0); return r },
    deleteDatabase () {}
  }
  const H = await import(`${SRC}storage-health.js?case=ok`)
  check('a healthy store probes usable', (await H.probeIndexedDb()) === true)
  check('and carries no failure to explain', H.lastFailure() === null && H.explainFailure() === null)
}

/* ---- 5. the pre-check refuses the doomed upload, with the numbers -------- */
{
  globalThis.document = { createElement: () => ({ addEventListener () {}, set src (_v) {} }) }
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL () {} }
  const P = await import(`${SRC}media-precheck.js`)

  const big = await P.precheckAttachment({ size: 209 * 1024 * 1024, type: 'video/quicktime', name: 'IMG.mov' })
  check('an oversized attachment is refused BEFORE any byte moves', big.ok === false && big.reason === 'too-large')
  check('THE NUMBERS ARE IN THE MESSAGE: the actual size', /209\.0 MB/.test(big.message))
  check('…and the actual limit, so the reader can act on it', /25\.0 MB/.test(big.message))
  check('the message never says "try again" for something that cannot work',
    !/try again/i.test(big.message))

  const empty = await P.precheckAttachment({ size: 0, type: 'video/mp4', name: 'a.mp4' })
  check('a zero-byte pick is caught and explained (iCloud placeholder)',
    empty.ok === false && /iCloud/.test(empty.message))

  const fine = await P.precheckAttachment({ size: 2 * 1024 * 1024, type: 'image/jpeg', name: 'p.jpg' })
  check('an ordinary photo passes', fine.ok === true && fine.bytes === 2 * 1024 * 1024)

  // An unreadable duration must NOT refuse the file: that would reject exactly
  // the containers least likely to be at fault.
  const unmeasurable = await P.precheckAttachment({ size: 1024, type: 'video/quicktime', name: 'x.mov' }, {})
  check('a video whose duration cannot be read is still allowed through', unmeasurable.ok === true)
}

console.log(`\n========================================\n  ${pass}/${pass + fail} passed\n========================================\n`)
if (fail > 0) process.exit(1)
