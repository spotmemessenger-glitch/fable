/**
 * The identity key must survive a bad read, and must NOT survive a wipe.
 *
 * Two faults, opposite directions, same field.
 *
 * ONE — a failed READ destroyed the key. `loadIdentity` did
 * `.catch(() => null)` on its readonly `get`, which collapsed "nothing stored
 * yet" into the same branch as "the read threw" — and that branch GENERATES a
 * new identity and `put`s it over whatever is there. The key is non-extractable,
 * so there is no copy. Every v2 conversation on the device dies at once.
 *
 * `tx()` rejects on `onerror` AND `onabort`, so this needed no exotic
 * conditions: a quota blip, an IO error, or (on iOS) a transaction aborted
 * because the tab was suspended. Worse, the device then reported itself
 * healthy — the write-back succeeds, so `identityStatus()` returns 'ok' and the
 * `persisted === false` guard in `publishIdentity`, whose entire job is "never
 * overwrite a good record", does not fire.
 *
 * The existing identity-status test models write-fails, open-fails and healthy.
 * It never modelled a SUCCESSFUL open with a FAILING read while a key is
 * present, which is why this shipped.
 *
 * TWO — `wipeDevice` walked localStorage only, and the identity key is the one
 * thing that is not in it. "Clear all data" left the X25519 private key in
 * IndexedDB; the next launch minted a new random account id and published that
 * same old key against it, linking the erased identity to the fresh one for
 * anyone who had recorded the public half.
 *
 *   node --experimental-test-module-mocks --no-warnings test/identity-durability.test.js
 */

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* ------------------------------------------------------- fake IndexedDB --- */

/**
 * Enough of IndexedDB to reproduce the fault: the database OPENS fine, holds a
 * record, and the first readonly transaction aborts. Every write is recorded so
 * the test can see an overwrite happen rather than infer it.
 */
function makeIDB ({ stored, failFirstRead }) {
  const writes = []
  let reads = 0
  const store = {
    get () { return { result: stored } },
    put (value, key) { writes.push({ key, hadBefore: stored !== undefined }); stored = value; return {} }
  }
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore () { return store },
    transaction (_name, mode) {
      const t = { objectStore: () => store, oncomplete: null, onerror: null, onabort: null }
      queueMicrotask(() => {
        if (mode === 'readonly') {
          reads++
          if (failFirstRead && reads === 1) { t.onabort?.(); return }
        }
        t.oncomplete?.()
      })
      return t
    }
  }
  return {
    writes,
    get stored () { return stored },
    open () {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => req.onsuccess?.())
      return req
    }
  }
}

const EXISTING = {
  algo: 'X25519',
  publicKey: { tag: 'ORIGINAL-PUB' },
  privateKey: { tag: 'ORIGINAL-PRIV' },
  publicKeyB64: 'ORIGINAL'
}


let instance = 0
async function loadWith (idb) {
  globalThis.indexedDB = idb
  // A fresh module instance per scenario — the identity is cached at module
  // scope, which is the whole point of `forgetIdentity` below.
  const mod = await import(`../src/lib/crypto/identity-store.js?case=${++instance}`)
  return mod
}

/* ------------------------------------------------------------- checks 1 --- */

{
  const idb = makeIDB({ stored: EXISTING, failFirstRead: false })
  const mod = await loadWith(idb)
  const id = await mod.loadIdentity()
  check('a healthy read returns the stored key and writes nothing',
    id?.publicKeyB64 === 'ORIGINAL' && idb.writes.length === 0)
}

{
  const idb = makeIDB({ stored: EXISTING, failFirstRead: true })
  const mod = await loadWith(idb)
  const id = await mod.loadIdentity()

  check('THE BUG: an aborted read must NOT generate a replacement identity',
    id === null)
  check('…and must NOT overwrite the key that is still sitting there',
    idb.writes.length === 0 && idb.stored?.publicKeyB64 === 'ORIGINAL')
  check('…and must report the store as unavailable, not as healthy',
    mod.identityStatus() === 'unavailable')
}

{
  /* The branch the fix must NOT break: a genuinely empty store still has to
   * mint an identity, or a new device can never chat at all. */
  const idb = makeIDB({ stored: undefined, failFirstRead: false })
  const mod = await loadWith(idb)
  const id = await mod.loadIdentity()
  check('an EMPTY store still generates and persists a new identity',
    Boolean(id) && idb.writes.length === 1 && idb.writes[0].hadBefore === false)
}

/* ------------------------------------------------------------- checks 2 --- */

{
  const idb = makeIDB({ stored: EXISTING, failFirstRead: false })
  const mod = await loadWith(idb)
  await mod.loadIdentity()
  check('forgetIdentity clears the module cache a wipe would otherwise leave live',
    typeof mod.forgetIdentity === 'function')
  mod.forgetIdentity()
  check('…and the status resets with it', mod.identityStatus() === 'unknown')
}

{
  /* wipeDevice must ask for the database to be deleted. db.js reaches the
   * crypto module by dynamic import, so this asserts the observable part: the
   * deleteDatabase call. */
  const deleted = []
  globalThis.indexedDB = { deleteDatabase: (n) => { deleted.push(n) }, open: () => ({}) }
  globalThis.location = { hostname: 'localhost', href: 'http://localhost/' }
  globalThis.window = { location: globalThis.location }
  const mem = new Map()
  globalThis.localStorage = {
    get length () { return mem.size },
    key: (i) => [...mem.keys()][i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  }
  const { db, wipeDevice } = await import(`../src/lib/db.js?case=${++instance}`)
  db.setProfile({ name: 'Wipe Me', lang: 'en' })
  wipeDevice()
  check('THE OTHER BUG: a wipe deletes the identity database, not just localStorage',
    deleted.includes('spotme-e2e'))
  /* The identity-pin database is SEPARATE (ADR-005 §4) and holds, per peer,
   * their id, their public key, and a timestamped history of every change to
   * it — a record of who this device talked to and when. A wipe that left it
   * behind would be the same invisible leak the media sweep was added for. */
  check('…and the identity-PIN database too, which is a separate one',
    deleted.includes('spotme-identity-pins'))
  // wipeDevice clears STORAGE; the in-memory state is discarded by the reload
  // that follows it in the app, so assert on what it actually promises.
  check('…and still clears the stored profile it always cleared',
    !(localStorage.getItem('spotme:app:v1') || '').includes('Wipe Me'))
}

/* -------------------------------------------------------------- report --- */

console.log('\n========================================')
console.log('  identity durability — a bad read must not destroy it, a wipe must')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
