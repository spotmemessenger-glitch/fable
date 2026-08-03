/**
 * Proves publication is OFF, gated, and honest — and that the supersession
 * statement this client signs is the exact statement the server verifies.
 *
 * ADR-008 Phase 2B, client half. The suite exercises the full path with an
 * injected transport, because the day the flag turns must not be the day
 * anyone finds out whether the path works:
 *
 *   - the flag defaults OFF, and OFF means the transport is never touched
 *   - the gate refuses EPHEMERAL / UNAVAILABLE stores — an ephemeral key must
 *     never become a peer's trust anchor (ADR-008 §4), and a store we cannot
 *     read must never trigger publish-over-it (§8)
 *   - the payload is exactly {publicKeyB64, algo} — nothing else rides along
 *   - the supersession transcript matches the server's byte for byte (pinned
 *     vector, asserted in BOTH suites), verifies under the old key, and a
 *     swapped-field transcript does NOT
 *
 *   node test/signing-key-publication.test.js
 */
/* The same LOCAL IndexedDB fake `signing-key-store.test.js` uses, for the same
 * reason it documents: CryptoKey must survive the clone, and failure injection
 * must be per-database. Converging both suites on a shared CryptoKey-aware
 * fake is follow-up work now that #30's helper is merged. */
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
          createObjectStore (s) { entry.stores.set(s, { keyPath: null, data: new Map() }) ; return {} },
          transaction (storeName, mode) {
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
              put: (v, k) => request(() => {
                if (opts.dropWrites && mode === 'readwrite') return k   // Safari's silent failure
                rec.data.set(k, clone(v)); return k
              }),
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
  SIGNING_PUBLICATION_ENABLED, DEFAULT_ENDPOINT, SUPERSEDE_DOMAIN,
  supersessionTranscript, signSupersession, publishSigningIdentity,
} from '../src/lib/crypto/signing-key-publication.js'
import { generateSigningIdentity, exportSigningPublicKeyB64, verifyBytes } from '../src/lib/crypto/signing-identity.js'
import { loadSigningIdentity, forgetSigningIdentity } from '../src/lib/crypto/signing-key-store.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

const calls = []
const post = async (endpoint, payload) => { calls.push({ endpoint, payload }) }

function fresh (opts) {
  globalThis.indexedDB = makeIDB(new Map(), opts)
  forgetSigningIdentity()
  calls.length = 0
}

/* ------------------------------------------------------------ the flag ---- */

check('THE FLAG IS OFF BY DEFAULT — publication does not exist for users today',
  SIGNING_PUBLICATION_ENABLED === false)

await checkAsync('…and off means OFF: the transport is never touched', async () => {
  fresh()
  const out = await publishSigningIdentity({ post })
  return out.ok === false && out.error.code === 'DISABLED' && calls.length === 0
})

await checkAsync('enabled without a wired transport refuses loudly, not silently', async () => {
  fresh()
  const out = await publishSigningIdentity({ enabled: true })
  return out.ok === false && out.error.code === 'NO_TRANSPORT'
})

/* ------------------------------------------------------------- the gate --- */

await checkAsync('a healthy store publishes EXACTLY {publicKeyB64, algo} to the lifecycle endpoint', async () => {
  fresh()
  const id = await loadSigningIdentity()
  const out = await publishSigningIdentity({ post, enabled: true })
  if (!(out.ok === true && calls.length === 1)) return false
  const { endpoint, payload } = calls[0]
  return endpoint === DEFAULT_ENDPOINT &&
    payload.publicKeyB64 === id.publicKeyB64 &&
    payload.algo === id.algo &&
    Object.keys(payload).sort().join(',') === 'algo,publicKeyB64'   // nothing rides along
})

await checkAsync('AN EPHEMERAL KEY IS REFUSED — it must never become a peer\'s trust anchor', async () => {
  globalThis.indexedDB = makeIDB(new Map(), { dropWrites: true })
  forgetSigningIdentity()
  calls.length = 0
  const out = await publishSigningIdentity({ post, enabled: true })
  return out.ok === false && out.error.code === 'EPHEMERAL' && calls.length === 0
})

await checkAsync('an UNAVAILABLE store is refused — nothing trustworthy to publish', async () => {
  fresh({ failOpen: 'spotme-signing' })
  const out = await publishSigningIdentity({ post, enabled: true })
  return out.ok === false && out.error.code === 'UNAVAILABLE' && calls.length === 0
})

await checkAsync('a transport failure is surfaced, not swallowed', async () => {
  fresh()
  const boom = async () => { throw new Error('server said no') }
  const out = await publishSigningIdentity({ post: boom, enabled: true })
  return out.ok === false && out.error.code === 'PUBLISH_FAILED' &&
    out.error.message.includes('server said no')
})

/* ------------------------------------------------------- supersession ----- */

check('CROSS-IMPLEMENTATION PIN: the transcript encodes exactly as the server does', (() => {
  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
  const expected =
    '000000050000001b73706f746d652d7369676e696e672d7375706572736564652d7631' +
    '00000006757365722d31000000034f4c44000000034e45570000000745643235353139'
  return hex(supersessionTranscript('user-1', 'OLD', 'NEW', 'Ed25519')) === expected
})())

await checkAsync('a supersession signed by the old key verifies over the exact transcript', async () => {
  const oldId = await generateSigningIdentity()
  oldId.publicKeyB64 = await exportSigningPublicKeyB64(oldId)
  const newId = await generateSigningIdentity()
  const newPub = await exportSigningPublicKeyB64(newId)

  const sig = await signSupersession(oldId, { userId: 'u-42', newPublicKeyB64: newPub, newAlgo: newId.algo })
  const bytes = supersessionTranscript('u-42', oldId.publicKeyB64, newPub, newId.algo)
  return verifyBytes(oldId, bytes, sig)
})

await checkAsync('…and the SWAPPED-FIELD transcript does not — same strings, different claim', async () => {
  const oldId = await generateSigningIdentity()
  oldId.publicKeyB64 = await exportSigningPublicKeyB64(oldId)
  const newId = await generateSigningIdentity()
  const newPub = await exportSigningPublicKeyB64(newId)

  const sig = await signSupersession(oldId, { userId: 'u-42', newPublicKeyB64: newPub, newAlgo: newId.algo })
  const swapped = supersessionTranscript('u-42', newPub, oldId.publicKeyB64, newId.algo)
  return (await verifyBytes(oldId, swapped, sig)) === false
})

check('the domain is the agreed one — the server pins the same string',
  SUPERSEDE_DOMAIN === 'spotme-signing-supersede-v1')

console.log('\n========================================')
console.log('  signing-key publication — off, gated, and honest')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
