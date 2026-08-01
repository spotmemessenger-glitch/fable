/**
 * Proves a substituted peer key is never adopted, and that the one honest
 * cause of key churn is stopped at its source.
 *
 * THE ATTACK THIS CLOSES, stated as the code used to permit it. Three shipped
 * behaviours composed into one hole:
 *
 *   socket-transport.refreshRoomKey  re-fetches the peer key on DECRYPT FAILURE
 *   identity-store.roomKeyForConvo   used whatever that fetch returned
 *   rooms.js onPeerKeyChanged        wrote it straight over convo.peerKey
 *
 * The server chooses what that fetch returns AND can provoke the decrypt
 * failure that triggers it. So a server could rotate a peer's key and have
 * every client adopt and persist its choice, silently and permanently. The
 * safety number two humans had compared was never consulted, because nothing
 * stored what it proved. Recovery and compromise were the same code path.
 *
 * A2 splits them: a differing key is PROPOSED, never adopted. A3 removes the
 * routine reason a key would honestly change, which is what makes refusing to
 * adopt one a reasonable default rather than a constant annoyance.
 *
 * ADVISORY, STILL. Nothing here is blocked — that is A5. What is asserted is
 * narrower and is the whole point: no substituted key becomes trusted or
 * persisted.
 *
 * Everything runs offline on Node's own WebCrypto. `indexedDB` and `fetch` are
 * faked; the crypto is real.
 *
 *   node test/identity-substitution.test.js
 */

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* ------------------------------------------------------------- harness --- */

/** Deliberately the same shape as the other identity suites' fake: an
 *  `identity` store that works, and nothing else. The pin store's own database
 *  is NOT served, which is the point of the last section — the refusal must
 *  hold when the audit store is unavailable. */
function fakeIndexedDB (seed) {
  const stores = new Map([['identity', new Map(seed ? [['self', seed]] : [])]])
  const db = {
    createObjectStore (name) { if (!stores.has(name)) stores.set(name, new Map()); return {} },
    transaction (name) {
      const t = { oncomplete: null, onerror: null, onabort: null }
      t.objectStore = () => {
        const m = stores.get(name) || new Map()
        return { get: (k) => ({ result: m.get(k) }), put: (v, k) => { m.set(k, v); return {} } }
      }
      queueMicrotask(() => t.oncomplete?.())
      return t
    }
  }
  return {
    open () {
      const req = { result: db, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
}

const BOB = 'bob-user-id'
let peerKeyOnServer = null
let publishedForSelf = null
let posted = []

globalThis.fetch = (url, init) => {
  const u = String(url)
  if (init?.method === 'POST' && u.includes('/auth/keys')) {
    posted.push(JSON.parse(init.body))
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  }
  if (u.includes(`/auth/keys/${BOB}`)) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ publicKey: peerKeyOnServer, algo: 'X25519' }) })
  }
  if (u.includes('/auth/keys/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ publicKey: publishedForSelf, algo: 'X25519' }) })
  }
  return new Promise(() => {})          // never settles: nothing else is needed
}

const { generateIdentity, exportPublicKeyB64, E2E_V2 } =
  await import('../src/lib/crypto/e2e-v2.js')

const alice = await generateIdentity()
globalThis.indexedDB = fakeIndexedDB({
  algo: alice.algo,
  publicKey: alice.publicKey,
  privateKey: alice.privateKey,
  publicKeyB64: await exportPublicKeyB64(alice)
})

const { roomKeyForConvo, publishIdentity, PUBLISH } =
  await import('../src/lib/crypto/identity-store.js')

const bobReal = await exportPublicKeyB64(await generateIdentity())
const bobEvil = await exportPublicKeyB64(await generateIdentity())

const tok = async () => ({ accessToken: 'tok' })
const convoWith = (peerKey) => ({
  roomId: 'room-1', e2eVersion: E2E_V2, peerKey, peer: { id: BOB, name: 'Bob' }
})

/* ================================ A. the substitution is refused ========== */

await checkAsync('a forced re-fetch returning a DIFFERENT key does not overwrite the pin', async () => {
  const convo = convoWith(bobReal)
  peerKeyOnServer = bobEvil
  let persisted = null
  await roomKeyForConvo(convo, tok, {
    forceRefetch: true,
    onPeerKeyChanged: (k) => { persisted = k; convo.peerKey = k }
  })
  // onPeerKeyChanged is the PERSIST path. Firing it for a replacement is what
  // made the old behaviour permanent.
  return convo.peerKey === bobReal && persisted === null
})

await checkAsync('…and the key it DERIVES with is the pinned one, not the served one', async () => {
  const convo = convoWith(bobReal)
  peerKeyOnServer = bobEvil
  const substituted = await roomKeyForConvo(convo, tok, { forceRefetch: true })
  const honest = await roomKeyForConvo(convoWith(bobReal), tok, {})

  /* Proven BY USE, not by comparing bytes: the derived key is deliberately
   * non-extractable (ADR-001), so `exportKey` throws — and a test that reached
   * for the raw bytes would be asserting against a property the design
   * specifically forbids. Sealing with one and opening with the other proves
   * they are the same key without ever extracting either. */
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, honest,
    new TextEncoder().encode('derived from the pin'))
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, substituted, ct)
  return new TextDecoder().decode(out) === 'derived from the pin'
})

await checkAsync('…and the differing key is reported as a PROPOSAL, with both sides named', async () => {
  const convo = convoWith(bobReal)
  peerKeyOnServer = bobEvil
  let proposal = null
  await roomKeyForConvo(convo, tok, { forceRefetch: true, onPeerKeyProposed: (p) => { proposal = p } })
  return proposal?.proposed === bobEvil && proposal?.pinned === bobReal && proposal?.peerId === BOB
})

await checkAsync('an UNCHANGED key is not reported as a proposal — no crying wolf', async () => {
  const convo = convoWith(bobReal)
  peerKeyOnServer = bobReal
  let proposal = null
  await roomKeyForConvo(convo, tok, { forceRefetch: true, onPeerKeyProposed: (p) => { proposal = p } })
  return proposal === null
})

/* ============================ B. first use is still trust-on-first-use ==== */

await checkAsync('a FIRST key is adopted and handed back to persist — nothing is being replaced', async () => {
  const convo = convoWith(null)
  peerKeyOnServer = bobReal
  let persisted = null
  await roomKeyForConvo(convo, tok, { onPeerKeyChanged: (k) => { persisted = k } })
  return persisted === bobReal
})

await checkAsync('THE MIGRATION: an existing conversation pins the key it ALREADY has', async () => {
  /* The ordering that makes upgrading safe. If the pin were seeded from a
   * fetch, one malicious response at upgrade time would own the trust anchor
   * for every existing chat. Seeding from the locally stored key means the
   * server has no say in it — so with a server offering a different key, the
   * stored one still wins and no network answer is adopted. */
  const convo = convoWith(bobReal)
  peerKeyOnServer = bobEvil
  let persisted = null
  await roomKeyForConvo(convo, tok, { onPeerKeyChanged: (k) => { persisted = k } })
  return convo.peerKey === bobReal && persisted === null
})

await checkAsync('an offline re-fetch falls back to the pin rather than going dark', async () => {
  const convo = convoWith(bobReal)
  peerKeyOnServer = null                 // server has nothing to offer
  const key = await roomKeyForConvo(convo, tok, { forceRefetch: true })
  return !!key && convo.peerKey === bobReal
})

/* ================= C. A3: the honest cause of key churn is stopped ======== */

await checkAsync('a device that CANNOT persist its key refuses to republish over a good record', async () => {
  /* Measured in production and recorded in identity-store.js: @vijay22's
   * published key moved three times in one session because the device could
   * not persist it, and every peer went dark. That is the routine key churn
   * A2's refusal would otherwise trip over constantly. */
  const { forgetIdentity } = await import('../src/lib/crypto/identity-store.js')
  forgetIdentity()
  globalThis.indexedDB = {
    open () {
      const req = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null }
      // The write never sticks, so loadIdentity marks the identity ephemeral.
      const stores = new Map([['identity', new Map()]])
      req.result = {
        createObjectStore (n) { stores.set(n, new Map()); return {} },
        transaction (n) {
          const t = {}
          t.objectStore = () => ({ get: () => ({ result: undefined }), put: () => ({}) })
          queueMicrotask(() => t.oncomplete?.())
          return t
        }
      }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
  publishedForSelf = bobReal            // a DIFFERENT key is already published
  posted = []
  const out = await publishIdentity(async () => ({
    // `sub` is read from the token to identify self without importing db.
    accessToken: `x.${Buffer.from(JSON.stringify({ sub: 'alice' })).toString('base64url')}.y`
  }))
  return out.ok === false && out.reason === PUBLISH.REFUSED_EPHEMERAL && posted.length === 0
})

await checkAsync('the refusal is a DEFINED reason, distinguishable from a network failure', async () => {
  // A bare `false` for both is what made this invisible: a caller could not
  // tell "this device is broken and only the user can fix it" from "retry".
  return PUBLISH.REFUSED_EPHEMERAL !== PUBLISH.FAILED &&
    typeof PUBLISH.REFUSED_EPHEMERAL === 'string'
})

await checkAsync('the result is an OBJECT, so no caller is inverted by a truthy failure string', async () => {
  const out = await publishIdentity(async () => ({ accessToken: null }))
  return out.ok === false && 'reason' in out
})

/* -------------------------------------------------------------- report --- */

console.log('\n========================================')
console.log('  identity substitution — propose, never adopt')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
