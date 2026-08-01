/**
 * Proves the signing key SURVIVES, is never regenerated over, and never leaves.
 *
 * ADR-008 storage, first half of Roadmap V2 Phase 2. The suite is built around
 * the four ways this exact design has already failed once in the AGREEMENT
 * store, so none of them gets a second life here:
 *
 *   - two concurrent first loads generating two identities (the A5 matrix
 *     caught this live; the promise cache is the fix and is asserted)
 *   - an aborted read treated as an empty store, generating a replacement over
 *     a key that has no copy
 *   - a write that silently did not stick, reported as healthy
 *   - a wipe that deleted the database but left the cached key live in memory
 *
 * Plus the state the agreement store never needed: UNREADABLE (ADR-008 §8) —
 * a record that exists but must not be touched, distinct from absent.
 *
 *   node test/signing-key-store.test.js
 */
/* A LOCAL fake, deliberately. The richer shared fake (`helpers/fake-idb.js`)
 * lives on unmerged PR #30, and the owner's directive forbids new work
 * depending on #30. This suite also does not need what that fake is FOR —
 * transaction serialisation — only durable backing, restartability, failure
 * injection, and a clone that preserves CryptoKey. Once #30 merges, a
 * follow-up can converge on the shared helper; until then a small honest fake
 * beats a dependency on an unreviewed branch. */
function clone (v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(clone)
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) return v      // CryptoKey passes through
  const out = {}
  for (const [k, val] of Object.entries(v)) if (val !== undefined) out[k] = clone(val)
  return out
}

function makeIDB (backing = new Map(), opts = {}) {
  const failing = (name) => {
    const f = opts.failOpen
    if (f === true) return true
    if (typeof f === 'function') return f(name) === true
    return f === name
  }
  return {
    open (name, version) {
      const req = {}
      queueMicrotask(() => {
        if (failing(name)) { req.error = new Error('refused'); req.onerror?.(); return }
        if (!backing.has(name)) backing.set(name, { version: 0, stores: new Map() })
        const entry = backing.get(name)
        req.result = {
          objectStoreNames: { contains: (s) => entry.stores.has(s) },
          createObjectStore (s) { entry.stores.set(s, { keyPath: null, data: new Map() }); return {} },
          transaction (storeName) {
            const rec = entry.stores.get(storeName)
            const t = {}
            let pending = 0
            const request = (work) => {
              const r = {}
              pending++
              queueMicrotask(() => {
                r.result = work(); r.onsuccess?.(); pending--
                queueMicrotask(() => { if (pending === 0) t.oncomplete?.() })
              })
              return r
            }
            t.objectStore = () => ({
              get: (k) => request(() => { const v = rec.data.get(k); return v === undefined ? undefined : clone(v) }),
              put: (v, k) => request(() => { rec.data.set(k, clone(v)); return k }),
              delete: (k) => request(() => { rec.data.delete(k) }),
            })
            queueMicrotask(() => { if (pending === 0) t.oncomplete?.() })
            return t
          },
        }
        if (version > entry.version) { entry.version = version; req.onupgradeneeded?.() }
        req.onsuccess?.()
      })
      return req
    },
  }
}
import {
  loadSigningIdentity, signingKeyStatus, forgetSigningIdentity,
  rotateSigningIdentity, SIGNING_SCHEMA_VERSION,
} from '../src/lib/crypto/signing-key-store.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

const DB = 'spotme-signing'
let backing = new Map()
const rows = () => backing.get(DB)?.stores.get('identity')?.data

function fresh (opts) {
  backing = new Map()
  globalThis.indexedDB = makeIDB(backing, opts)
  forgetSigningIdentity()
}
function restart (opts) {
  globalThis.indexedDB = makeIDB(backing, opts)
  forgetSigningIdentity()
}

/* --------------------------------------------- 0. import is side-effect free */

check('importing the store opened no database',
  typeof globalThis.indexedDB === 'undefined')
check('…and the status before anyone asks is unknown, not a fault',
  signingKeyStatus() === 'unknown')

/* ------------------------------------------------- 1. first use generates -- */

await checkAsync('first load generates, persists, and reports ok', async () => {
  fresh()
  const id = await loadSigningIdentity()
  return Boolean(id?.privateKey) && id.persisted === true &&
    signingKeyStatus() === 'ok' && rows().size === 1 &&
    id.schemaVersion === SIGNING_SCHEMA_VERSION && typeof id.createdAt === 'number'
})

await checkAsync('the stored private key is NON-EXTRACTABLE, and stays so through storage', async () => {
  const id = await loadSigningIdentity()
  if (id.privateKey.extractable !== false) return false
  try { await crypto.subtle.exportKey('pkcs8', id.privateKey); return false } catch { /* refused */ }
  try { await crypto.subtle.exportKey('jwk', id.privateKey); return false } catch { /* refused */ }
  return true
})

await checkAsync('THE RACE: concurrent first loads share ONE identity', async () => {
  /* The A5 matrix caught exactly this in the agreement store — `if (cached)`
   * deduplicates sequential callers and does nothing for concurrent ones, and
   * the loser keeps signing as an identity that no longer exists. */
  fresh()
  const [a, b, c] = await Promise.all([loadSigningIdentity(), loadSigningIdentity(), loadSigningIdentity()])
  return a === b && b === c && rows().size === 1
})

/* ------------------------------------------------------ 2. restart survival */

await checkAsync('RESTART: the same key comes back, and no new one is generated', async () => {
  fresh()
  const first = await loadSigningIdentity()
  restart()
  const second = await loadSigningIdentity()
  return second.publicKeyB64 === first.publicKeyB64 &&
    second.privateKey.extractable === false && rows().size === 1
})

await checkAsync('…and the reloaded key can still be proven the same key BY USE', async () => {
  const { signBytes, verifyBytes } = await import('../src/lib/crypto/signing-identity.js')
  fresh()
  const first = await loadSigningIdentity()
  const msg = new TextEncoder().encode('survives the reload')
  const sig = await signBytes(first, msg)
  restart()
  const second = await loadSigningIdentity()
  return verifyBytes({ publicKeyB64: second.publicKeyB64, algo: second.algo }, msg, sig)
})

/* --------------------------------------- 3. the store failing, honestly ---- */

await checkAsync('a store that will not OPEN is unavailable, and retryable without a reopen', async () => {
  backing = new Map()
  let denied = true
  globalThis.indexedDB = makeIDB(backing, { failOpen: (n) => denied && n === DB })
  forgetSigningIdentity()
  const down = await loadSigningIdentity()
  const statusDown = signingKeyStatus()
  denied = false                                // storage relents; nothing reset
  const up = await loadSigningIdentity()
  return down === null && statusDown === 'unavailable' && Boolean(up?.privateKey)
})

await checkAsync('AN ABORTED READ IS NOT AN EMPTY STORE — nothing is generated over the record', async () => {
  /* The read fails; the store already holds a marker row. The one forbidden
   * outcome is a fresh identity written over it — a non-extractable key has no
   * copy, so that write is the unrecoverable move. */
  const marker = { sentinel: true }
  const idb = {
    open () {
      const req = {}
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore () { return {} },
          transaction () {
            const t = {}
            t.objectStore = () => ({
              get: () => { const r = {}; queueMicrotask(() => { t.onerror?.() }); return r },
              put: () => { marker.overwritten = true; return {} },
            })
            return t
          },
        }
        req.onsuccess?.()
      })
      return req
    },
  }
  globalThis.indexedDB = idb
  forgetSigningIdentity()
  const out = await loadSigningIdentity()
  return out === null && signingKeyStatus() === 'unavailable' && marker.overwritten !== true
})

await checkAsync('a write that does not stick reports EPHEMERAL, and the key still works in memory', async () => {
  /* Safari's classic failure: the put "succeeds" and the row is not there.
   * The publication PR will refuse to publish on this status; here the status
   * itself is what must be honest. */
  backing = new Map()
  const real = makeIDB(backing)
  globalThis.indexedDB = {
    open (...a) {
      const req = real.open(...a)
      const origSuccess = () => {
        const db = req.result
        const origTx = db.transaction.bind(db)
        db.transaction = (name, mode) => {
          const t = origTx(name, mode)
          if (mode === 'readwrite') {
            const os = t.objectStore.bind(t)
            t.objectStore = () => ({ ...os(), put: () => ({}) })   // drops the write
          }
          return t
        }
      }
      const prior = Object.getOwnPropertyDescriptor(req, 'onsuccess')
      void prior
      let user
      Object.defineProperty(req, 'onsuccess', {
        set (fn) { user = fn },
        get () { return () => { origSuccess(); user?.() } },
      })
      return req
    },
  }
  forgetSigningIdentity()
  const id = await loadSigningIdentity()
  return id !== null && id.persisted === false && signingKeyStatus() === 'ephemeral' &&
    Boolean(id.privateKey)
})

/* ------------------------------------- 4. UNREADABLE is not absent (§8) ---- */

await checkAsync('a record MISSING its private key is unreadable — reported, never overwritten', async () => {
  fresh()
  backing.set(DB, {
    version: 1,
    stores: new Map([['identity', { keyPath: null, data: new Map([['self', { publicKeyB64: 'orphaned', schemaVersion: 1 }]]) }]]),
  })
  restart()
  const out = await loadSigningIdentity()
  return out === null && signingKeyStatus() === 'unreadable' &&
    rows().get('self').publicKeyB64 === 'orphaned'          // untouched
})

await checkAsync('a record from a NEWER schema is unreadable — never downgraded, never replaced', async () => {
  fresh()
  const futureRecord = { privateKey: {}, publicKey: {}, publicKeyB64: 'future', schemaVersion: SIGNING_SCHEMA_VERSION + 1 }
  backing.set(DB, {
    version: 1,
    stores: new Map([['identity', { keyPath: null, data: new Map([['self', futureRecord]]) }]]),
  })
  restart()
  const out = await loadSigningIdentity()
  return out === null && signingKeyStatus() === 'unreadable' &&
    rows().get('self').schemaVersion === SIGNING_SCHEMA_VERSION + 1
})

/* ----------------------------------------------------------- 5. rotation --- */

await checkAsync('rotation is explicit: a fresh key replaces the old, and the OLD public key is returned', async () => {
  fresh()
  const before = await loadSigningIdentity()
  const out = await rotateSigningIdentity()
  const after = await loadSigningIdentity()
  return out.ok === true &&
    out.previousPublicKeyB64 === before.publicKeyB64 &&
    after.publicKeyB64 === out.next.publicKeyB64 &&
    after.publicKeyB64 !== before.publicKeyB64 &&
    after.privateKey.extractable === false
})

await checkAsync('the rotated key persists across a restart', async () => {
  const rotated = await loadSigningIdentity()
  restart()
  return (await loadSigningIdentity()).publicKeyB64 === rotated.publicKeyB64
})

await checkAsync('rotation REFUSES over an unreadable record — see §8', async () => {
  fresh()
  backing.set(DB, {
    version: 1,
    stores: new Map([['identity', { keyPath: null, data: new Map([['self', { broken: true }]]) }]]),
  })
  restart()
  const out = await rotateSigningIdentity()
  return out.ok === false && out.error.code === 'UNREADABLE' && rows().get('self').broken === true
})

await checkAsync('rotation refuses when the store is unavailable', async () => {
  backing = new Map()
  globalThis.indexedDB = makeIDB(backing, { failOpen: DB })
  forgetSigningIdentity()
  const out = await rotateSigningIdentity()
  return out.ok === false && out.error.code === 'UNAVAILABLE'
})

/* ------------------------------------------------------ 6. forget = wipe --- */

await checkAsync('forgetSigningIdentity drops the live handle a wipe would otherwise leave', async () => {
  fresh()
  const before = await loadSigningIdentity()
  // The wipe deletes the database; the cache is the other half.
  backing.delete(DB)
  forgetSigningIdentity()
  const after = await loadSigningIdentity()
  return signingKeyStatus() === 'ok' && after.publicKeyB64 !== before.publicKeyB64
})

check('…and the status resets with it', (() => {
  forgetSigningIdentity()
  return signingKeyStatus() === 'unknown'
})())

console.log('\n========================================')
console.log('  signing key store — survives, refuses, never regenerates over')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
