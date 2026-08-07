/**
 * Proves trust decisions SURVIVE — a reload, a schema change, and another tab
 * writing at the same moment.
 *
 * THE FAKE IS SHARED, in `helpers/fake-idb.js`, and it SERIALISES overlapping
 * readwrite transactions the way IndexedDB does. That is not decoration: the
 * claim this module makes is that a read-modify-write in ONE transaction cannot
 * lose a concurrent tab's decision, and against a stand-in with no concurrency
 * control at all that test passes for free — the same class of false pass as a
 * green authorization test against a server with no authorization.
 *
 * It lives in a helper rather than here because the A5 matrix suite needs the
 * same semantics over two databases at once, and a second copy of a
 * concurrency model is how a concurrency test quietly stops modelling
 * concurrency.
 *
 *   node test/identity-pin-store.test.js
 */
import { makeIDB } from './helpers/fake-idb.js'
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


const DB = 'spotme-identity-pins'
const STORE = 'pins'
/** Real 32-byte X25519-length keys. The machine canonicalises and
 *  length-checks, so placeholder strings are no longer valid input. */
const key = (b) => btoa(String.fromCharCode(...new Array(32).fill(b)))
const K1 = key(1)
const K2 = key(2)

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

/* ------------------------------- 7. refused transitions leave no trace ---- */

await checkAsync('a refused transition ABORTS the transaction, observably', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  idb._txLog.length = 0
  const out = await applyToRecord('alice', { type: ACCEPT, at: at() })   // nothing proposed
  // Not merely "nothing was written" — a function that forgot to call put also
  // writes nothing. The transaction itself must have aborted.
  return out.ok === false && idb._txLog.some((t) => t.outcome === 'abort')
})

await checkAsync('a refused transition does not mutate the persisted record', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  const before = JSON.stringify(rowsOf(idb).get('alice'))
  for (const ev of [
    { type: ACCEPT, at: at() },
    { type: REJECT, at: at() },
    { type: VERIFY, at: at(), key: K2 },
    { type: OBSERVE, at: at(), key: 'not-a-key' },
    { type: REVOKE, at: at(), source: 'server-assertion' },
    { type: 'nonsense', at: at() },
  ]) {
    const out = await applyToRecord('alice', ev)
    if (out.ok !== false) return false
  }
  return JSON.stringify(rowsOf(idb).get('alice')) === before
})

await checkAsync('a refused transition returns a defined error code, never a throw', async () => {
  fresh()
  const out = await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  return out.ok === false && out.error.code === ERR.NO_PIN
})

/* --------------------------------- 8. database creation and upgrade ------ */

await checkAsync('the object store is created on first use', async () => {
  const idb = fresh()
  await readRecord('alice')
  const db = idb._backing.get(DB)
  return db.version === 1 && db.stores.has(STORE)
})

await checkAsync('reopening an existing database does not re-run the upgrade', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  restart(idb)
  // A re-run of onupgradeneeded would have replaced the store with an empty
  // one, silently wiping every trust decision on the device.
  return (await readRecord('alice')).pinnedKey === K1 && rowsOf(idb).size === 1
})

await checkAsync('an upgrade that finds the store already present keeps the data', async () => {
  const idb = fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  // Force a version bump the way a future migration would.
  idb._backing.get(DB).version = 0
  restart(idb)
  return (await readRecord('alice')).pinnedKey === K1
})

/* ------------------------------------- 9. two tabs, no last-writer-wins -- */

await checkAsync('a second tab cannot silently replace a pin by writing last', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K1 })
  // Tab A verifies again; tab B sees a substituted key. Under last-writer-wins
  // the later write would clobber the earlier decision outright. Serialised,
  // the pin survives both orderings and the substitution stays a PROPOSAL.
  const [a, b] = await Promise.all([
    applyToRecord('alice', { type: VERIFY, at: at(), key: K1 }),
    applyToRecord('alice', { type: OBSERVE, at: at(), key: K2, source: 'other-tab' }),
  ])
  const final = await readRecord('alice')
  return a.ok && b.ok && final.pinnedKey === K1 && final.proposedKey !== K1
})

await checkAsync('a proposed-key event is never lost to a concurrent no-op', async () => {
  fresh()
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await Promise.all([
    applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 }),
    ...Array.from({ length: 5 }, () => applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })),
  ])
  const final = await readRecord('alice')
  return final.state === CHANGED && final.proposedKey === K2 && final.pinnedKey === K1
})

/* ------------------------------------------- 10. nothing leaks sideways -- */

await checkAsync('no identity key reaches localStorage', async () => {
  const idb = fresh()
  const writes = []
  globalThis.localStorage = {
    setItem: (k, v) => writes.push(`${k}=${v}`),
    getItem: () => null, removeItem: () => {}, clear: () => {},
  }
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 })
  await applyToRecord('alice', { type: REJECT, at: at() })
  delete globalThis.localStorage
  return writes.length === 0 && rowsOf(idb).size === 1
})

await checkAsync('no identity key or record is written to the console', async () => {
  fresh()
  const said = []
  const real = { log: console.log, warn: console.warn, error: console.error, info: console.info }
  for (const k of Object.keys(real)) console[k] = (...a) => said.push(a.join(' '))
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K1 })
  await applyToRecord('alice', { type: OBSERVE, at: at(), key: K2 })
  await applyToRecord('alice', { type: ACCEPT, at: at() })
  await applyToRecord('alice', { type: VERIFY, at: at(), key: K2 })
  await readRecord('alice')
  for (const k of Object.keys(real)) console[k] = real[k]
  const dump = said.join('\n')
  return said.length === 0 || (!dump.includes(K1) && !dump.includes(K2))
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
