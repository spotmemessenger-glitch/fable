/**
 * Spot Me — where identity trust decisions survive a reload.
 *
 * `identity-pin.js` decides what a trust record BECOMES. This decides where it
 * lives. The split is the same one `e2e-v2.js` and `identity-store.js` already
 * make: the pure part stays testable on bare Node with no IndexedDB, and the
 * storage part is the only thing that needs a browser.
 *
 * A SEPARATE DATABASE, ON PURPOSE. `identity-store.js` opens `spotme-e2e` at
 * VERSION 1. Adding an object store to it would mean opening at version 2, and
 * an existing connection at version 1 then fails with a VersionError — so a
 * change that looks additive would break the identity load path on any tab that
 * had already opened it. A separate database costs one more `open` and keeps
 * this change genuinely additive, which is the condition it lands under.
 *
 * READ AND WRITE IN ONE TRANSACTION. Every mutation is a read-modify-write, and
 * the read and the write are in the SAME `readwrite` transaction. Split across
 * two, a second tab could read the same record between them and its decision
 * would be silently discarded — and the record being lost would be a trust
 * decision. IndexedDB serialises overlapping `readwrite` transactions on the
 * same store, so one transaction is what makes concurrent tabs safe.
 *
 * NOTHING HAPPENS ON IMPORT. No connection is opened, no listener registered,
 * no timer set. The database is opened on first use and cached after that.
 */
import { applyEvent, emptyRecord, migrateRecord } from './identity-pin.js'
import { applyAvailability } from './identity-availability.js'

const DB_NAME = 'spotme-identity-pins'
const DB_VERSION = 1
const STORE = 'pins'

let dbPromise = null

/**
 * Opened lazily and cached. Not cached as a resolved value: two callers racing
 * the first use must share one `open`, or they would each create a connection
 * and the second could observe the first's upgrade half-finished.
 */
function openDb () {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (err) {
      reject(err)
      return
    }
    req.onupgradeneeded = () => {
      // Guarded, and the failure REJECTS rather than being swallowed. An
      // upgrade that throws here would otherwise escape as an unhandled
      // exception from inside the event callback, where no caller can catch it
      // — and the caller is what decides whether to degrade or fail.
      try {
        const db = req.result
        if (!db?.objectStoreNames?.contains?.(STORE)) {
          // Keyed by peer id. `keyPath` rather than out-of-line keys so a
          // record always carries the id it is filed under, and the two cannot
          // drift apart.
          db.createObjectStore(STORE, { keyPath: 'peerId' })
        }
      } catch (err) {
        reject(err)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('identity pin store is blocked by another connection'))
  })
  // A failed open must not be cached as a permanent failure: private browsing
  // can deny once and allow later, and a wedged promise would make this device
  // unable to record trust for the rest of the session.
  dbPromise.catch(() => { dbPromise = null })
  return dbPromise
}

/** Drops the cached connection. Tests use it; nothing in the app needs it. */
export function _resetForTests () {
  dbPromise = null
}

/**
 * `fn` receives the object store AND the transaction, because a caller may need
 * to ABORT rather than merely decline to write — see `applyToRecord`.
 *
 * A deliberate abort is signalled by throwing/rejecting with `ABORTED`, which
 * resolves rather than rejects: it is an outcome, not a fault.
 */
const ABORTED = Symbol('deliberate abort')

function run (db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t
    try {
      t = db.transaction(STORE, mode)
    } catch (err) {
      reject(err)
      return
    }
    let out
    let failed = null
    const bail = (err) => {
      failed = err
      try { t.abort() } catch { /* already aborting */ }
    }
    try {
      out = fn(t.objectStore(STORE), bail)
      // An async body's failure arrives here, after the synchronous try block.
      if (out && typeof out.then === 'function') out = out.catch((err) => { bail(err); return undefined })
    } catch (err) {
      bail(err)
    }
    const settle = () => {
      if (failed === ABORTED) resolve(ABORTED)
      else if (failed) reject(failed)
      else resolve(out)
    }
    t.oncomplete = settle
    t.onerror = () => (failed ? settle() : reject(t.error))
    t.onabort = () => (failed ? settle() : reject(t.error || new Error('transaction aborted')))
  })
}

/** Promisify a single IDBRequest inside an already-open transaction. */
function req (r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

/**
 * The trust record for a peer, or a fresh one if none is stored.
 *
 * Always returns a usable record — never null — because "we have no opinion
 * about this peer" is a real answer and the caller should not have to
 * distinguish it from a storage miss.
 */
export async function readRecord (peerId) {
  if (!peerId) throw new Error('peerId is required')
  const db = await openDb()
  const raw = await run(db, 'readonly', (store) => req(store.get(peerId)))
  return migrateRecord(await raw, peerId)
}

/** Every stored record, migrated. For a "who have I verified" screen. */
export async function allRecords () {
  const db = await openDb()
  const raw = await run(db, 'readonly', (store) => req(store.getAll()))
  return (await raw).map((r) => migrateRecord(r, r && r.peerId))
}

/**
 * Apply an event to a peer's record, atomically.
 *
 * The get and the put share one `readwrite` transaction, so a concurrent tab
 * cannot read the same starting record and overwrite this decision. Returns
 * exactly what `applyEvent` returned — including a rejection, which is NOT
 * written and NOT thrown, because a refused transition is an answer the caller
 * has to be able to show a user.
 *
 * @param {string} peerId
 * @param {{type: string, at: number, key?: string, algo?: string,
 *          source?: string, reason?: string, evidence?: object}} event
 */
export async function applyToRecord (peerId, event) {
  if (!peerId) throw new Error('peerId is required')
  const db = await openDb()
  /** Held outside the transaction: a refused transition ABORTS, so its result
   *  cannot travel out as the transaction's resolved value. */
  let refused = null

  const out = await run(db, 'readwrite', (store, tx) => {
    // Returned as a promise chain INSIDE the transaction. IndexedDB keeps a
    // transaction alive while its own requests are outstanding, so chaining
    // get -> put through request callbacks stays within the same transaction;
    // awaiting anything foreign here would let it auto-commit first.
    return req(store.get(peerId)).then((raw) => {
      const current = migrateRecord(raw, peerId)
      const result = applyEvent(current, event)
      if (!result.ok) {
        // ABORT rather than simply not calling `put`. Stronger in two ways: it
        // is enforced by IndexedDB rather than by this function remembering to
        // return early, so a future edit that adds a write above this line
        // still cannot persist anything on a refused transition; and it makes
        // "nothing was written" observable instead of merely intended.
        refused = result
        tx(ABORTED)
        return undefined
      }
      if (!result.changed && raw) return result
      return req(store.put({ ...result.next, peerId })).then(() => result)
    })
  })

  if (refused) return refused
  return out
}

/**
 * Forget a peer entirely.
 *
 * Deliberately NOT a way to clear a warning: it drops the pin and the
 * verification along with the record, so the next observation starts from
 * nothing. `applyToRecord(peerId, { type: 'reject' })` is what resolves a
 * change while keeping the trust that was already established.
 */
export async function forgetRecord (peerId) {
  if (!peerId) throw new Error('peerId is required')
  const db = await openDb()
  await run(db, 'readwrite', (store) => req(store.delete(peerId)))
  return true
}

/**
 * Record the server's view of whether this peer is reachable.
 *
 * A SEPARATE ENTRY POINT FROM `applyToRecord`, deliberately. Routing an
 * availability report through the identity event loop would mean one function
 * that can write both axes, and the whole point of A6a is that the server can
 * reach exactly one of them. Two doors, and the server has a key to one.
 *
 * Same single-transaction read-modify-write as `applyToRecord`, so a concurrent
 * identity decision cannot be lost to an availability write or the reverse.
 */
export async function setAvailability (peerId, event) {
  if (!peerId) throw new Error('peerId is required')
  const db = await openDb()
  let refused = null

  const out = await run(db, 'readwrite', (store, tx) => {
    return req(store.get(peerId)).then((raw) => {
      const current = migrateRecord(raw, peerId)
      const result = applyAvailability(current, event)
      if (!result.ok) { refused = result; tx(ABORTED); return undefined }
      if (!result.changed && raw) return result
      return req(store.put({ ...result.next, peerId })).then(() => result)
    })
  })

  if (refused) return refused
  return out
}

/** A fresh, unstored record. Re-exported so callers need one import, not two. */
export { emptyRecord }
