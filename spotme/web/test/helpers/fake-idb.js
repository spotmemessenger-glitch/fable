/**
 * One IndexedDB stand-in, shared, because a second copy would drift.
 *
 * WHY THIS IS RICHER THAN A STUB. Most fakes in this repo return a fixed value
 * and fire `oncomplete` on a microtask. That is enough for "did it write", and
 * useless for the claim `identity-pin-store.js` actually makes: that a
 * read-modify-write in ONE transaction cannot lose a concurrent tab's decision.
 * Proving that needs a fake that SERIALISES overlapping readwrite transactions
 * the way IndexedDB does — otherwise the concurrency test passes against a store
 * with no concurrency control at all, which is the same class of false pass as a
 * green authorization test against a server with no authorization.
 *
 * So this models: named databases, keyPath AND out-of-line key stores, real
 * per-key data, request callbacks, `onupgradeneeded` on version change, a
 * per-store transaction queue, and rollback on abort. Backing data outlives a
 * connection, so "restart the app" is a real operation rather than a mocked one.
 *
 * IT IS STILL A FAKE. It does not model version-change blocking between live
 * connections, quota, or the event loop's exact commit timing. Where a property
 * depends on those, the honest answer is a real browser — which is why the A5
 * matrix keeps a manual list rather than claiming to have automated it all.
 */

/**
 * Structured clone, near enough.
 *
 * IndexedDB deep-copies on the way in and out, which is what stops a caller
 * mutating stored data by holding a reference. The obvious `JSON.parse(
 * JSON.stringify(v))` does that for records — and DESTROYS a `CryptoKey`, which
 * is exactly what `identity-store.js` stores and what its whole non-extractable
 * argument rests on. Real IndexedDB preserves it.
 *
 * So: plain objects and arrays are copied, everything else passes through by
 * reference. Undefined-valued keys are dropped, matching JSON semantics, so the
 * suites written against the previous behaviour keep it.
 */
export function clone (v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(clone)
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return v      // CryptoKey, Uint8Array, Date…
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    if (val !== undefined) out[k] = clone(val)
  }
  return out
}

/**
 * @param backing Map<dbName, {version, stores: Map<name, {keyPath, data: Map}>}>
 *        Passed in so it can outlive a connection — that is what makes a restart
 *        test a restart rather than a fresh database.
 * @param opts.failOpen  a database name, an array of names, `true` for all, or
 *        a predicate `(name) => boolean`. Opening a named database fires
 *        `onerror` instead of succeeding, which is how private browsing and a
 *        blocked origin present. The predicate form matters: storage that
 *        refuses ONCE and then allows is the case a caller must retry, and a
 *        fixed list cannot express it without reopening the connection — which
 *        would reset the very cache under test.
 */
export function makeIDB (backing = new Map(), opts = {}) {
  /** Per-store promise chain. A readwrite transaction does not begin until the
   *  previous one on that store has finished, which is the behaviour the
   *  concurrency claim rests on. */
  const queues = new Map()
  /** Every transaction's outcome, so "it aborted" is OBSERVED rather than
   *  inferred from "nothing was written". Those are different claims: a
   *  function that simply forgot to call put also writes nothing. */
  const txLog = []

  const failing = (name) => {
    const f = opts.failOpen
    if (f === true) return true
    if (typeof f === 'function') return f(name) === true
    if (Array.isArray(f)) return f.includes(name)
    return f === name
  }

  function connection (name) {
    const entry = backing.get(name)
    return {
      objectStoreNames: { contains: (s) => entry.stores.has(s) },
      createObjectStore (s, o) {
        // `o` is absent for an out-of-line-key store, which is how
        // identity-store.js creates its `identity` store.
        entry.stores.set(s, { keyPath: o?.keyPath ?? null, data: new Map() })
        return {}
      },
      transaction (storeName, mode) {
        const rec = entry.stores.get(storeName)
        if (!rec) throw new Error(`no such store: ${storeName}`)
        const t = { oncomplete: null, onerror: null, onabort: null, _aborted: false }
        let pending = 0
        let settled = false
        const snapshot = new Map(rec.data)

        const prior = queues.get(`${name}/${storeName}`) || Promise.resolve()
        let release
        const mine = new Promise((r) => { release = r })
        queues.set(`${name}/${storeName}`, prior.then(() => mine))
        const started = prior

        const finish = () => {
          if (settled) return
          settled = true
          if (t._aborted) {
            // Real IndexedDB rolls a transaction's writes back on abort.
            // Restoring the snapshot is what makes the abort test meaningful.
            rec.data = snapshot
          }
          txLog.push({ db: name, store: storeName, mode, outcome: t._aborted ? 'abort' : 'complete' })
          release()
          queueMicrotask(() => (t._aborted ? t.onabort?.() : t.oncomplete?.()))
        }

        const request = (work) => {
          const r = { onsuccess: null, onerror: null, result: undefined }
          pending++
          started.then(() => {
            if (t._aborted) { pending--; return }
            r.result = work()
            r.onsuccess?.()
            pending--
            // Commit once nothing is outstanding. A chained request registers
            // synchronously inside onsuccess, so it is counted before this runs.
            queueMicrotask(() => { if (pending === 0) finish() })
          })
          return r
        }

        t.abort = () => { t._aborted = true; finish() }
        t.objectStore = () => ({
          get: (k) => request(() => {
            const v = rec.data.get(k)
            return v === undefined ? undefined : clone(v)
          }),
          getAll: () => request(() => [...rec.data.values()].map(clone)),
          put: (v, k) => request(() => {
            const key = rec.keyPath ? v[rec.keyPath] : k
            rec.data.set(key, clone(v))
            return key
          }),
          delete: (k) => request(() => { rec.data.delete(k); return undefined }),
        })
        // A transaction with no requests still has to complete.
        queueMicrotask(() => { if (pending === 0) finish() })
        return t
      },
    }
  }

  return {
    _backing: backing,
    _txLog: txLog,
    open (name, version) {
      const r = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
      queueMicrotask(() => {
        if (failing(name)) { r.error = new Error(`refused to open ${name}`); r.onerror?.(); return }
        if (!backing.has(name)) backing.set(name, { version: 0, stores: new Map() })
        const entry = backing.get(name)
        r.result = connection(name)
        if (version > entry.version) {
          entry.version = version
          r.onupgradeneeded?.()
        }
        r.onsuccess?.()
      })
      return r
    },
  }
}
