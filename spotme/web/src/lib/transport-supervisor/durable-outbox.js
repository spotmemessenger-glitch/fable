/**
 * Spot Me — the DURABLE (IndexedDB) OUTBOX. ADR-012b.
 *
 * The scaffold's IOutbox contract (outbox.js) with a backing store that
 * survives a reload: a message queued while offline must still be owed after
 * the tab is killed, or "offline messaging" only works for users who never
 * close the app. Same five methods, same semantics — enqueue idempotent by
 * id, ORIGINAL first-seen time kept, TTL sweep — plus `whenReady` because
 * IndexedDB opens asynchronously.
 *
 * WRITE-THROUGH CACHE, NOT A QUERY LAYER. All reads (`pending`, `has`,
 * `size`) are served from an in-memory Map loaded once at open; writes go to
 * the Map first and to IndexedDB fire-and-forget-with-error-count. The drain
 * runs on every tick and must not await a database round trip per item; the
 * durability guarantee is "an enqueue that returned has been handed to the
 * store", and `flush()` exists for the callers (tests, shutdown) that need
 * the stronger "…and the store finished writing".
 *
 * WHAT IS STORED IS OPAQUE. Entries hold already-sealed envelopes and routing
 * metadata — never plaintext, never keys (INV-1/INV-2 are asserted over the
 * envelope at send time, and the store never looks inside `item`).
 *
 * THE WIPE PATH. This store is REGISTERED in db.js's wipeDevice() database
 * list (`spotme-adaptive-outbox`), so "Clear all data" already covers it from
 * the day the first envelope is ever written. While every flag is off nothing
 * creates this database, so the registration is a no-op delete of a
 * nonexistent DB. `wipeDurableOutbox()` is the module-local hook for tests
 * and for any future caller that wants to wipe ONLY the outbox.
 *
 * `idb` is injected (defaulting to the platform global) so Node tests use
 * the shared fake and the module never touches the platform at import time.
 */
export const OUTBOX_DB_NAME = 'spotme-adaptive-outbox'
export const OUTBOX_STORE = 'outbox'
const DB_VERSION = 1
const OPEN_TIMEOUT_MS = 5_000

const platformIdb = () => (typeof indexedDB !== 'undefined' ? indexedDB : null)

function openDb (idb) {
  return new Promise((resolve, reject) => {
    let req
    try { req = idb.open(OUTBOX_DB_NAME, DB_VERSION) } catch (err) { reject(err); return }
    const timer = setTimeout(() => reject(new Error('outbox: open timed out')), OPEN_TIMEOUT_MS)
    if (typeof timer?.unref === 'function') timer.unref()
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => { clearTimeout(timer); resolve(req.result) }
    req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('outbox: open failed')) }
    req.onblocked = () => { /* an old tab holds it; the timeout above reports */ }
  })
}

/**
 * Create the durable outbox. Resolves its ready promise to itself once the
 * persisted backlog is loaded; if IndexedDB is unavailable (private mode, no
 * platform), it DEGRADES to memory-only and says so via `durable === false`
 * rather than failing — a send queue that refuses to queue is strictly worse
 * than one that forgets on reload, and the caller can surface the difference.
 */
export function createDurableOutbox ({ ttlMs = 24 * 60 * 60_000, idb = undefined } = {}) {
  const backend = idb === undefined ? platformIdb() : idb
  const items = new Map()   // id -> { id, item, first, delivered:false }
  let db = null
  let durable = false
  let writeErrors = 0
  let lastWrite = Promise.resolve()

  const ready = (async () => {
    if (!backend) return
    try {
      db = await openDb(backend)
      durable = true
      await new Promise((resolve, reject) => {
        const tx = db.transaction(OUTBOX_STORE, 'readonly')
        const req = tx.objectStore(OUTBOX_STORE).getAll()
        req.onsuccess = () => {
          for (const row of req.result || []) {
            if (row && row.id) items.set(row.id, { id: row.id, item: row.item, first: row.first, delivered: false })
          }
          resolve()
        }
        req.onerror = () => reject(req.error || new Error('outbox: load failed'))
      })
    } catch {
      db = null
      durable = false   // memory-only degradation, reported honestly
    }
  })()

  /** One serialized write-behind op. Errors are counted, never thrown into the
   *  caller — the memory state is authoritative for this session either way. */
  function persist (op) {
    if (!db) return
    lastWrite = lastWrite.then(() => new Promise((resolve) => {
      try {
        const tx = db.transaction(OUTBOX_STORE, 'readwrite')
        op(tx.objectStore(OUTBOX_STORE))
        tx.oncomplete = () => resolve()
        tx.onabort = () => { writeErrors++; resolve() }
        tx.onerror = () => { writeErrors++; resolve() }
      } catch { writeErrors++; resolve() }
    }))
  }

  const api = {
    enqueue (id, item, now = 0) {
      if (!id) throw new Error('outbox: id required')
      const existing = items.get(id)
      if (existing) {
        existing.item = item   // keep ORIGINAL first — a re-enqueue must not reset TTL
        persist((store) => store.put({ id, item, first: existing.first }))
        return existing
      }
      const entry = { id, item, first: now, delivered: false }
      items.set(id, entry)
      persist((store) => store.put({ id, item, first: now }))
      return entry
    },

    markDelivered (id) {
      const entry = items.get(id)
      if (!entry) return false
      items.delete(id)
      persist((store) => store.delete(id))
      return true
    },

    pending (now = 0) {
      const out = []
      for (const e of items.values()) {
        if (!e.delivered && now - e.first <= ttlMs) out.push(e)
      }
      return out
    },

    sweep (now = 0) {
      const dropped = []
      for (const [id, e] of items) {
        if (now - e.first > ttlMs) {
          items.delete(id)
          persist((store) => store.delete(id))
          dropped.push(id)
        }
      }
      return dropped
    },

    has (id) { return items.has(id) },
    /** O(1) lookup of one owed entry (beyond the IOutbox contract; the drain
     *  prefers it over scanning pending()). */
    get (id) { return items.get(id) || null },
    get size () { return items.size },

    /* ---- durability surface beyond the IOutbox contract ---- */
    whenReady: () => ready.then(() => api),
    /** Await every write issued so far (shutdown, tests). */
    flush: () => ready.then(() => lastWrite),
    get durable () { return durable },
    get writeErrors () { return writeErrors },
    close () { try { db?.close() } catch { /* already closed */ } db = null }
  }
  return api
}

/**
 * Delete the outbox database entirely. The same shape as db.js's
 * `dropDatabase`: resolves null on success and the database name on failure,
 * never rejects, bounded — so the wipe path can aggregate it without special
 * cases. db.js also names this database directly in wipeDevice(); this hook
 * exists for the module's own tests and targeted cleanup.
 */
export function wipeDurableOutbox ({ idb = undefined, timeoutMs = 5_000 } = {}) {
  const backend = idb === undefined ? platformIdb() : idb
  if (!backend) return Promise.resolve(null)   // nothing exists to leak
  return new Promise((resolve) => {
    let req
    try { req = backend.deleteDatabase(OUTBOX_DB_NAME) } catch { resolve(OUTBOX_DB_NAME); return }
    if (!req || typeof req !== 'object') { resolve(null); return }
    const timer = setTimeout(() => resolve(OUTBOX_DB_NAME), timeoutMs)
    if (typeof timer?.unref === 'function') timer.unref()
    const done = (v) => { clearTimeout(timer); resolve(v) }
    req.onsuccess = () => done(null)
    req.onerror = () => done(OUTBOX_DB_NAME)
    req.onblocked = () => done(OUTBOX_DB_NAME)
  })
}
