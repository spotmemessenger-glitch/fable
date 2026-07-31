/**
 * Spot Me — where this device's e2e_v2 identity lives, and how peers find it.
 *
 * WHY INDEXEDDB AND NOT localStorage. localStorage stores strings. Putting a
 * key there would have meant generating it `extractable: true` and serialising
 * it — at which point any XSS walks off with the identity permanently, and the
 * "non-exportable" property in ADR-001 becomes decoration. IndexedDB stores
 * live `CryptoKey` objects via the structured clone algorithm, so the private
 * key round-trips as an opaque handle and `extractable === false` survives.
 * Verified on this stack before it was relied on.
 *
 * This module is kept OUT of e2e-v2.js on purpose: that file has to stay pure
 * WebCrypto so test/crypto.test.js can exercise the shipped derivation on Node
 * with no IndexedDB and no mocks.
 */
import { API_BASE } from '../api.js'
import { generateIdentity, exportPublicKeyB64, deriveRoomKey, E2E_V2 } from './e2e-v2.js'

const DB_NAME = 'spotme-e2e'
const STORE = 'identity'
const SELF = 'self'

function openDb () {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx (db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const out = fn(t.objectStore(STORE))
    t.oncomplete = () => resolve(out?.result ?? out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

let cached = null

/**
 * This device's identity, generated once and reused. Generation is idempotent
 * per device; a SECOND device gets a DIFFERENT key, which is why a v2 chat does
 * not follow you across devices yet (ADR-001, Consequences).
 */
export async function loadIdentity () {
  if (cached) return cached
  let db
  try { db = await openDb() } catch { return null }   // private mode, quota, etc.

  const found = await tx(db, 'readonly', (s) => s.get(SELF)).catch(() => null)
  if (found?.privateKey) {
    cached = found
    return cached
  }

  const fresh = await generateIdentity()
  const record = {
    algo: fresh.algo,
    publicKey: fresh.publicKey,
    privateKey: fresh.privateKey,
    publicKeyB64: await exportPublicKeyB64(fresh)
  }
  // If the put fails (quota, private browsing) the identity still works for
  // this session — it simply will not survive a reload. Chatting beats failing.
  await tx(db, 'readwrite', (s) => s.put(record, SELF)).catch(() => {})
  cached = record
  return cached
}

/**
 * Publish the PUBLIC half so peers can reach us. Safe by construction — the
 * private key cannot be serialised, so there is nothing here to leak.
 *
 * Best-effort and non-blocking: a failed upload means peers fall back to an
 * e2e_v1 room with us until the next boot, which is the previous behaviour, not
 * a regression. Never let this block sign-in.
 */
export async function publishIdentity (fetchToken) {
  const id = await loadIdentity()
  if (!id?.publicKeyB64) return false
  // Accept either a token or a function that gets one. Boot has no token in
  // hand yet — minting it is itself async — so the caller passes freshTokens.
  let accessToken = fetchToken
  if (typeof fetchToken === 'function') {
    try { accessToken = (await fetchToken())?.accessToken } catch { return false }
  }
  if (!accessToken) return false
  try {
    const res = await fetch(`${API_BASE}/api/v2/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ publicKey: id.publicKeyB64, algo: id.algo })
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * A peer's public key, or null.
 *
 * null is an ORDINARY answer, not an error: every account that predates this
 * feature has `publicKey` NULL until its owner next opens the app. The caller's
 * job is to fall back to e2e_v1 and say so — never to fail the chat, and never
 * to pretend the room is v2.
 */
export async function fetchPeerKey (userId, accessToken) {
  if (!userId || !accessToken) return null
  try {
    const res = await fetch(`${API_BASE}/api/v2/auth/keys/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })
    if (!res.ok) return null
    const data = await res.json()
    return data?.publicKey ? { publicKey: data.publicKey, algo: data.algo } : null
  } catch {
    return null
  }
}

/**
 * Re-agree the key for a stored e2e_v2 conversation.
 *
 * THIS IS WHAT MAKES v2 SURVIVE A RELOAD. The agreed key lives in memory only,
 * so on every boot `rooms.connectAll()` rejoins each stored room — and without
 * this, `roomKey()` would derive PBKDF2 over `convo.secret`, the cyrb53 value
 * V-19 is about, while the room stayed labelled e2e_v2. Registered as a key
 * PROVIDER (see socket-transport.setRoomKeyProvider), so a v2 room has no
 * password path at all: this either produces the agreed key or the room does
 * not open.
 *
 * `convo.peerKey` is the peer's published key, stored at creation on BOTH
 * sides. It is preferred over a network call so a reload works offline; the
 * fetch is only a repair path for records written before peerKey existed.
 *
 * THROWS rather than returning null on failure — a caller that cannot agree
 * must not quietly fall back to the recomputable key.
 *
 * @param fetchToken async () => accessToken, injected so this module needs no
 *        dependency on the transport (and so tests need no socket).
 */
export async function roomKeyForConvo (convo, fetchToken) {
  if (convo?.e2eVersion !== E2E_V2) throw new Error('not an e2e_v2 conversation')
  const identity = await loadIdentity()
  if (!identity?.privateKey) throw new Error('this device has no identity key')

  let peerKey = convo.peerKey || null
  if (!peerKey && convo.peer?.id && typeof fetchToken === 'function') {
    const { accessToken } = (await fetchToken()) || {}
    const found = await fetchPeerKey(convo.peer.id, accessToken)
    peerKey = found?.publicKey || null
  }
  if (!peerKey) throw new Error('no peer public key for this conversation')

  return deriveRoomKey({ identity, peerPublicKeyB64: peerKey, roomId: convo.roomId })
}
