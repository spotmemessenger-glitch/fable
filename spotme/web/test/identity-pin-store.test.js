/**
 * Proves trust decisions SURVIVE — a reload, a schema change, and another tab
 * writing at the same moment.
 *
 * WHY A RICHER FAKE THAN THE OTHER SUITES USE. The existing IndexedDB stand-ins
 * in this repo return a fixed value and fire `oncomplete` on a microtask. That
 * is enough to test "did it write", and useless for the claim this module
 * actually makes: that a read-modify-write in ONE transaction cannot lose a
 * concurrent tab's decision. Proving that needs a fake that SERIALISES
 * overlapping readwrite transactions the way IndexedDB does — otherwise the
 * concurrency test passes against a store with no concurrency control at all,
 * which is the same class of false pass as a green authorization test against a
 * server with no authorization.
 *
 * So the fake below models: keyPath stores, real per-key data, request
 * callbacks, `onupgradeneeded` on version change, and a per-store transaction
 * queue. Backing data outlives a connection, so "restart the app" is a real
 * operation here rather than a mocked one.
 *
 *   node test/identity-pin-store.test.js
 */
import {
  readRecord, allRecords, applyToRecord, forgetRecord, _resetForTests,
} from '../src/lib/crypto/identity-pin-store.js'
import {
  UNVERIFIED, PINNED, VERIFIED, CHANGED, REVOKED,
  OBSERVE, VERIFY, ACCEPT, REJECT, REVOKE,
  ERR, SCHEMA_VERSION,
} from '../src/lib/crypto/identity-pin.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* ------------------------------------------------------ IndexedDB fake ---- */

/**
 * @param backing Map<dbName, {version, stores: Map<name, {keyPath, data: Map}>}>
 *        Passed in so it can outlive a connection — that is what makes the
 *        restart test a restart rather than a fresh database.
 */
function makeIDB (backing = new Map()) {
  /** Per-store promise chain. A readwrite transaction does not begin until the
   *  previous one on that store has finished, which is the behaviour the
   *  concurrency claim rests on. */
  const queues = new Map()

  function connection (name) {
    const entry = backing.get(name)
    return {
      objectStoreNames: { contains: (s) => entry.stores.has(s) },
      createObjectStore (s, opts) {
        entry.stores.set(s, { keyPath: opts.keyPath, data: new Map() })
        return {}
      },
      transaction (storeName, mode) {
        const rec = entry.stores.get(storeName)
        if (!rec) throw new Error(`no such store: ${storeName}`)
        const t = { oncomplete: null, onerror: null, onabort: null, _aborted: false }
        let pending = 0
        let settled = false

        const prior = queues.get(storeName) || Promise.resolve()
        let release
        const mine = new Promise((r) => { release = r })
        queues.set(storeName, prior.then(() => mine))
        const started = prior

        const finish = () => {
          if (settled) return
          settled = true
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
            return v === undefined ? undefined : JSON.parse(JSON.stringify(v))
          }),
          getAll: () => request(() => [...rec.data.values()].map((v) => JSON.parse(JSON.stringify(v)))),
          put: (v) => request(() => {
            rec.data.set(v[rec.keyPath], JSON.parse(JSON.stringify(v)))
            return v[rec.keyPath]
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
    open (name, version) {
      const r = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null }
      queueMicrotask(() => {
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

const DB = 'spotme-identity-pins'
const STORE = 'pins'
const K1 = 'AAAA-key-one'
const K2 = 'BBBB-key-two'

let clock = 1000
const at = () => ++clock

/** Fresh, empty world. */
function fresh () {
  const idb = makeIDB()
  globalThis.indexedDB = idb
  _resetForTests()
  return idb
}
/** Same data, new connection — i.e. the user reopened the app. */
function restart (idb) {
  globalThis.indexedDB = makeIDB(idb._backing)
  _resetForTests()
  return globalThis.indexedDB
}
const rowsOf = (idb) => idb._backing.get(DB)?.stores.get(STORE)?.data

/* --------------------------------------------- 0. no import side effects -- */

check('importing the store module opened no database',
  typeof globalThis.indexedDB === 'undefined')

/* ------------------------------------------------------- 1. round trip ---- */

await checkAsync('an unknown peer reads back as a fresh Unverified record', async () => {
  fresh()
  const r = await readRecord('alice')
  return r.state === UNVERIFIED && r.pinnedKey === null && r.peerId === 'alice'
})

await checkAsync('reading an unknown peer writes nothing', async () => {
  const idb = fresh()
  await readRecord('alice')
  return rowsOf(idb).size === 0
})

await checkAsync('a first observation pins the key and persists it', async () => {
  const idb = fresh()
  const out = await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1, algo: 'X25519' })
  const stored = rowsOf(idb).get('alice')
  return out.ok && out.next.state === PINNED && stored.pinnedKey === K1 &&
    stored.schemaVersion === SCHEMA_VERSION
})

await checkAsync('a refused transition is returned, not thrown, and not written', async () => {
  const idb = fresh()
  const out = await applyToRecord('alice', { type: ACCEPT, at: at() })
  return out.ok === false && out.error.code === ERR.NOTHING_PROPOSED && rowsOf(idb).size === 0
})

await checkAsync('allRecords returns every peer, migrated', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('bob', { type: OBSERVE, at: at(), key: K2 })
  const all = await allRecords()
  return all.length === 2 && all.every((r) => r.schemaVersion === SCHEMA_VERSION)
})

await checkAsync('forgetRecord removes the peer entirely', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await forgetRecord('alice')
  return rowsOf(idb).size === 0 && (await readRecord('alice')).state === UNVERIFIED
})

/* -------------------------------------------- 2. restart / restoration ---- */

await checkAsync('a PINNED key survives a restart', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  restart(idb)
  const r = await readRecord('alice')
  return r.state === PINNED && r.pinnedKey === K1
})

await checkAsync('a VERIFIED state survives a restart — verification is not lost', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  restart(idb)
  const r = await readRecord('alice')
  return r.state === VERIFIED && r.pinnedKey === K1
})

await checkAsync('a CHANGED warning survives a restart rather than being cleared', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 })
  restart(idb)
  const r = await readRecord('alice')
  // Restarting the app is exactly when a user would hope the warning went away.
  return r.state === CHANGED && r.pinnedKey === K1 && r.proposedKey === K2
})

await checkAsync('a REVOKED state survives a restart', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: REVOKE, at: at(), source: 'local-action', reason: 'test' })
  restart(idb)
  const r = await readRecord('alice')
  return r.state === REVOKED && r.revocation.source === 'local-action'
})

await checkAsync('history accumulates across a restart', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  restart(idb)
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  return (await readRecord('alice')).history.length >= 2
})

/* -------------------------------------------------- 3. schema migration --- */

await checkAsync('an unversioned stored record is upgraded on read', async () => {
  const idb = fresh()
  await readRecord('alice')            // force the store into existence
  rowsOf(idb).set('bob', { peerId: 'bob', state: PINNED, key: K1, algo: 'X25519' })
  const r = await readRecord('bob')
  return r.state === PINNED && r.pinnedKey === K1 && r.schemaVersion === SCHEMA_VERSION
})

await checkAsync('a record from a NEWER schema is not downgraded into false trust', async () => {
  const idb = fresh()
  await readRecord('alice')
  rowsOf(idb).set('bob', { peerId: 'bob', schemaVersion: SCHEMA_VERSION + 1, state: VERIFIED, pinnedKey: K1 })
  const r = await readRecord('bob')
  return r.state === UNVERIFIED && r.unreadable === true
})

await checkAsync('an incoherent stored record is discarded rather than trusted', async () => {
  const idb = fresh()
  await readRecord('alice')
  rowsOf(idb).set('bob', { peerId: 'bob', schemaVersion: SCHEMA_VERSION, state: VERIFIED, pinnedKey: null })
  return (await readRecord('bob')).state === UNVERIFIED
})

await checkAsync('an upgraded record is written back in the new shape when next changed', async () => {
  const idb = fresh()
  await readRecord('alice')
  rowsOf(idb).set('bob', { peerId: 'bob', state: PINNED, key: K1 })
  await applyToRecord('bob', { type: VERIFY, at: at(), key: K1 })
  const stored = rowsOf(idb).get('bob')
  return stored.schemaVersion === SCHEMA_VERSION && stored.state === VERIFIED
})

/* ------------------------------------------------------ 4. concurrency ---- */

await checkAsync('THE FAKE ITSELF serialises overlapping readwrite transactions', async () => {
  // Guards the two tests below. Without this the concurrency claim would be
  // tested against a fake with no concurrency control, and pass for free.
  const idb = fresh()
  await readRecord('alice')
  const db = await new Promise((res) => { const r = idb.open(DB, 1); r.onsuccess = () => res(r.result) })
  const order = []
  const t1 = db.transaction(STORE, 'readwrite')
  t1.objectStore().put({ peerId: 'x' })
  const p1 = new Promise((res) => { t1.oncomplete = () => { order.push(1); res() } })
  const t2 = db.transaction(STORE, 'readwrite')
  t2.objectStore().put({ peerId: 'y' })
  const p2 = new Promise((res) => { t2.oncomplete = () => { order.push(2); res() } })
  await Promise.all([p1, p2])
  return order[0] === 1 && order[1] === 2
})

await checkAsync('two concurrent observations do not lose one another', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  // Both start from PINNED(K1). One proposes K2; the other re-observes K1.
  // Whatever the order, the CHANGED record must not be silently overwritten by
  // the no-op — that is the lost update this design exists to prevent.
  const [a, b] = await Promise.all([
    applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 }),
    applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 }),
  ])
  const final = await readRecord('alice')
  return a.ok && b.ok && final.state === CHANGED && final.pinnedKey === K1 && final.proposedKey === K2
})

await checkAsync('a concurrent verify and change cannot both win', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  const [v, o] = await Promise.all([
    applyToRecord('alice', { type: VERIFY, at: at(), key: K1 }),
    applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 }),
  ])
  const final = await readRecord('alice')
  // Serialised either way, the outcome is coherent: Verified-then-Changed
  // (remembering it was verified), or Changed-then-verify-the-pin.
  const coherent =
    (final.state === CHANGED && final.priorState === VERIFIED && final.pinnedKey === K1) ||
    (final.state === VERIFIED && final.pinnedKey === K1)
  return v.ok && o.ok && coherent
})

await checkAsync('ten concurrent writes all land, none is lost', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await Promise.all(Array.from({ length: 10 }, () =>
    applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })))
  const final = await readRecord('alice')
  return final.state === PINNED && final.pinnedKey === K1
})

/* ------------------------------------------------------- 5. resolution ---- */

await checkAsync('accepting a change persists the new pin without verification', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 })
  await applyToRecord('alice', { type: ACCEPT, at: at() })
  const stored = rowsOf(idb).get('alice')
  return stored.state === PINNED && stored.pinnedKey === K2 && stored.verifiedAt === null
})

await checkAsync('rejecting a change restores the persisted Verified state', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 })
  await applyToRecord('alice', { type: REJECT, at: at() })
  const r = await readRecord('alice')
  return r.state === VERIFIED && r.pinnedKey === K1 && r.proposedKey === null
})

await checkAsync('no stored record ever contains private key material', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 })
  await applyToRecord('alice', { type: REVOKE, at: at(), source: 'local-action' })
  const dump = JSON.stringify([...rowsOf(idb).values()])
  return !/privateKey|secretKey|deriveBits|CryptoKey/i.test(dump)
})

/* ----------------------------------------------------- 6. storage faults -- */

await checkAsync('a database that will not open surfaces as a rejection, not a hang', async () => {
  globalThis.indexedDB = { open () { const r = {}; queueMicrotask(() => r.onerror?.()); return r } }
  _resetForTests()
  try { await readRecord('alice'); return false } catch { return true }
})

await checkAsync('a failed open is not cached — a later attempt can still succeed', async () => {
  globalThis.indexedDB = { open () { const r = {}; queueMicrotask(() => r.onerror?.()); return r } }
  _resetForTests()
  try { await readRecord('alice') } catch { /* expected */ }
  globalThis.indexedDB = makeIDB()          // storage becomes available
  return (await readRecord('alice')).state === UNVERIFIED
})

console.log('\n========================================')
console.log('  identity pinning — persistence')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
