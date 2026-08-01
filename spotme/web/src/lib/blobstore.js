/**
 * Spot Me — media bytes on disk, out of localStorage.
 *
 * WHY THIS EXISTS. Assembled attachments were written into the room's
 * localStorage record as data URLs. localStorage is a 5-10 MB synchronous
 * string store, and one 40 MB video base64s to ~53 MB, so `store.js` grew an
 * elaborate shedding ladder: catch the quota throw, drop the heaviest media,
 * try again, keep dropping until the conversation fits. That ladder is correct
 * and hard-won, and it exists only because the bytes were in the wrong place.
 * It also forced `FILE_CAP_BYTES = 2.5 MB` on ordinary files.
 *
 * IndexedDB is asynchronous, stores Blobs natively, and is typically bounded by
 * a share of free disk rather than a few megabytes. Media moves here; the
 * message envelope (text, ids, timestamps, flags) stays in localStorage, which
 * is what makes a room render instantly on load without waiting for a
 * transaction.
 *
 * ---------------------------------------------------------------------------
 * ABSENCE IS A SUPPORTED STATE, NOT AN ERROR
 *
 * Safari private mode has historically refused IndexedDB, embedded WebViews
 * disable it, and the Node test shim has no such global at all. Every function
 * here answers "not available" rather than throwing, and `store.js` then
 * behaves exactly as it did before — data URL in localStorage, shedding ladder
 * intact. An enhancement that takes the app down when it is unavailable is not
 * an enhancement.
 *
 * WHAT MUST NEVER BE WRITTEN HERE: a view-once photo's bytes. `store.js` sheds
 * them from the persisted copy on purpose — a photo that is supposed to exist
 * once must not survive a reload — and quietly durable-ising them here would
 * undo that. The guard lives at the call site AND is restated in `put()`.
 */

const DB_NAME = 'spotme-media'
const DB_VERSION = 1
const STORE = 'blobs'

/** Cached open handle; null while closed, a Promise while opening. */
let dbPromise = null

/** True when this browser will actually give us a store. */
export function available () {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

function open () {
  if (!available()) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      return resolve(null)
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    // A refused or blocked open is "unavailable", not a crash. Private mode
    // and storage-pressure eviction both land here.
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  // Never cache a failure: a later attempt may succeed once a competing tab
  // closes, and a cached null would keep the app on localStorage forever.
  dbPromise = dbPromise.then((db) => { if (!db) dbPromise = null; return db })
  return dbPromise
}

/** Run `fn` inside a transaction, resolving to `fallback` on any failure. */
async function tx (mode, fn, fallback = null) {
  const db = await open()
  if (!db) return fallback
  return new Promise((resolve) => {
    let t
    try {
      t = db.transaction(STORE, mode)
    } catch {
      return resolve(fallback)
    }
    let out = fallback
    t.oncomplete = () => resolve(out)
    t.onerror = () => resolve(fallback)
    t.onabort = () => resolve(fallback)
    try {
      fn(t.objectStore(STORE), (value) => { out = value })
    } catch {
      resolve(fallback)
    }
  })
}

/** Room-scoped key, so clearing one conversation cannot touch another. */
export const mediaKey = (roomId, messageId) => `${roomId}\u0000${messageId}`

/**
 * Store one attachment's bytes.
 *
 * `viewOnce` is refused outright rather than trusted to the caller: those bytes
 * are supposed to be gone after a single view, and a durable copy here would be
 * exactly the leak `store.js` sheds them to prevent.
 *
 * Returns true only if the bytes are actually stored — the caller keeps the
 * data URL in localStorage when this is false, so a refusal degrades to the old
 * behaviour rather than losing the media.
 */
export async function put (key, bytes, mime, { viewOnce = false } = {}) {
  if (viewOnce) return false
  if (!key || !bytes?.byteLength) return false
  const value = typeof Blob === 'function'
    ? new Blob([bytes], { type: mime || 'application/octet-stream' })
    : { bytes, mime }
  return tx('readwrite', (os, done) => {
    os.put(value, key)
    done(true)
  }, false)
}

/** The stored Blob, or null when absent or unavailable. */
export async function get (key) {
  if (!key) return null
  return tx('readonly', (os, done) => {
    const req = os.get(key)
    req.onsuccess = () => done(req.result ?? null)
  }, null)
}

export async function del (key) {
  if (!key) return false
  return tx('readwrite', (os, done) => {
    os.delete(key)
    done(true)
  }, false)
}

/**
 * Drop every blob belonging to one room.
 *
 * Keys are `roomId\0messageId`, so a bounded cursor over that prefix range
 * deletes exactly this room's media without reading any of it.
 */
export async function delRoom (roomId) {
  if (!roomId) return false
  return tx('readwrite', (os, done) => {
    const range = IDBKeyRange.bound(`${roomId}\u0000`, `${roomId}\u0000\uffff`)
    const req = os.openCursor(range)
    req.onsuccess = () => {
      const cursor = req.result
      if (!cursor) return done(true)
      cursor.delete()
      cursor.continue()
    }
  }, false)
}

/**
 * Destroy the whole media store.
 *
 * `db.wipeDevice()` sweeps localStorage by prefix; without this, "Clear all
 * data" would leave every photo and voice note this device ever received
 * sitting in IndexedDB — a worse leak than the one the button exists to fix.
 */
export async function clearAll () {
  return tx('readwrite', (os, done) => {
    os.clear()
    done(true)
  }, false)
}
