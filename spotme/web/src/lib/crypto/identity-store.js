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
    // `?? out` would hand back the IDBRequest itself on a MISS, because a miss
    // resolves `result` to undefined. Harmless only by luck downstream — a
    // request object has no `privateKey` — so ask whether it is a request.
    t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  })
}

let cached = null

/* Why a module flag and not just `cached === null`. `loadIdentity` returns null
 * when IndexedDB will not OPEN at all — private browsing, a blocked origin — and
 * that is a DIFFERENT fault from "the write did not stick": the first means no
 * v2 chat can work here at all, the second means this session's key is
 * ephemeral. Neither is distinguishable from "nothing has asked for the
 * identity yet" unless it is recorded, and the UI has to tell all three apart. */
let openFailed = false

/**
 * This device's identity, generated once and reused. Generation is idempotent
 * per device; a SECOND device gets a DIFFERENT key, which is why a v2 chat does
 * not follow you across devices yet (ADR-001, Consequences).
 */
export async function loadIdentity () {
  if (cached) return cached
  let db
  try { db = await openDb() } catch { openFailed = true; return null }   // private mode, quota, etc.
  openFailed = false

  /* AN ABORTED READ IS NOT AN EMPTY STORE.
   *
   * This was `.catch(() => null)`, which collapsed "nothing stored yet" into the
   * same branch as "the read threw" — and the branch below GENERATES a new
   * identity and `put`s it over whatever is there. `tx` rejects on both
   * `onerror` and `onabort`, so a quota blip, an IO error, or (on iOS) a
   * transaction aborted because the tab was suspended was enough to destroy the
   * private key. It is non-extractable, so there is no copy: every existing v2
   * conversation dies at once.
   *
   * And the device then reported itself healthy. The write-back below succeeds,
   * so `persisted` is true and `identityStatus()` says 'ok' — meaning the
   * `id.persisted === false` guard in `publishIdentity`, whose whole job is
   * "never overwrite a good record", does not fire either. The new key goes to
   * the server and staleifies the `peerKey` every peer holds.
   *
   * Fail CLOSED. A read we could not complete says nothing about what is
   * stored, and the only safe move is to report the store unavailable and write
   * nothing at all. */
  let found
  try {
    found = await tx(db, 'readonly', (s) => s.get(SELF))
  } catch {
    openFailed = true
    return null
  }
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
  /* WRITE IT, THEN PROVE IT STUCK.
   *
   * This used to be `.catch(() => {})` with the note "chatting beats failing" —
   * true while a v1 room could still fall back to the password, and false the
   * moment ADR-001 made this identity the ONLY source of a v2 room key.
   *
   * When the write silently fails, every launch generates a fresh identity and
   * `publishIdentity` overwrites the server record, which instantly staleifies
   * the `convo.peerKey` every peer has stored. Measured on real handsets:
   * @vijay22's published key changed three times in one session while
   * @ajith11's never moved, and messages stopped arriving in BOTH directions —
   * the server accepted them, push notifications fired, and every frame was
   * dropped undecryptable at the far end.
   *
   * Safari is the usual reason: storing a non-extractable CryptoKey in
   * IndexedDB has historically failed there, and it fails by rejecting the
   * request rather than by throwing anywhere visible.
   *
   * So the write is verified by reading it back. `persisted` is the honest
   * answer to "will this identity survive a reload", and publishIdentity
   * refuses to clobber a good server record when it is false. */
  let persisted = false
  try {
    await tx(db, 'readwrite', (s) => s.put(record, SELF))
    const readBack = await tx(db, 'readonly', (s) => s.get(SELF))
    persisted = Boolean(readBack?.privateKey)
  } catch {
    persisted = false
  }
  if (!persisted) {
    console.warn(
      'spotme identity: this device cannot persist its encryption key. ' +
      'Encrypted chats will not survive a reload here, and republishing would ' +
      'break existing conversations — see identity-store.js.'
    )
  }
  cached = { ...record, persisted }
  return cached
}

/**
 * This device's key situation, synchronously, for the UI.
 *
 * WHY THIS EXISTS. `persisted` was reported honestly and then written only to
 * `console.warn`, which on a phone is nowhere: the device that CAUSED the
 * @vijay22 outage looked completely healthy on its own screen, and diagnosing
 * it needed a Mac and a cable. A fault this total has to be visible on the
 * device it affects.
 *
 * Synchronous on purpose. `loadIdentity` is async and the chat paints before it
 * resolves, so a caller that awaited would either block the first frame or show
 * nothing at all. This reports what the last load already settled.
 *
 *   'ok'          the private key survives a reload
 *   'ephemeral'   generated, but the write did not stick — THE bug. Every v2
 *                 room here derives a key no peer can match, and
 *                 `publishIdentity` is deliberately refusing to republish, so
 *                 this does not resolve itself and a reload will not fix it
 *   'unavailable' IndexedDB would not open, so there is no v2 identity at all
 *   'unknown'     nothing has asked for the identity yet
 *
 * `persisted` is `undefined` on an identity LOADED from the store — only a
 * freshly generated one carries the flag — so this tests `=== false`, exactly
 * as `publishIdentity` does. Anything looser reports a fault on every healthy
 * device that has simply been used before.
 */
/**
 * Drop the in-memory identity so the next `loadIdentity()` starts clean.
 *
 * `wipeDevice` deletes the IndexedDB database, but the record is also cached in
 * a module variable that outlives it — without this the "wiped" device keeps
 * serving the old private key for the rest of the page and republishes it under
 * the new account id, which is precisely what a wipe is supposed to prevent.
 */
export function forgetIdentity () {
  cached = null
  openFailed = false
}

export function identityStatus () {
  if (cached) return cached.persisted === false ? 'ephemeral' : 'ok'
  return openFailed ? 'unavailable' : 'unknown'
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

  /* NEVER OVERWRITE A GOOD RECORD WITH AN EPHEMERAL KEY.
   *
   * If this device could not persist its identity, the key in hand lives only
   * until the tab closes. Publishing it replaces whatever peers are already
   * deriving against, so every existing conversation goes silent — and does so
   * again on the next launch, and the next. One device that cannot write to
   * IndexedDB takes down every chat it is part of, in both directions.
   *
   * Better to leave the previous public key standing and let this session fail
   * to decrypt than to break the other side too. If nothing is published yet
   * there is nothing to protect, so a first publish still goes ahead. */
  if (id.persisted === false) {
    /* Our own id, taken from the token's `sub` rather than from db.profile() —
     * this module is imported BY the room layer, so reaching back for db would
     * close an import cycle, and `sub` is the authenticated principal anyway. */
    const selfId = (() => {
      try { return JSON.parse(atob(String(accessToken).split('.')[1] || ''))?.sub || null } catch { return null }
    })()
    const existing = selfId ? await fetchPeerKey(selfId, accessToken).catch(() => null) : null
    if (existing?.publicKey && existing.publicKey !== id.publicKeyB64) {
      console.warn(
        'spotme identity: NOT republishing — this device cannot persist its key, ' +
        'and overwriting the published one would silently break every existing chat.'
      )
      return false
    }
  }

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
 * WHEN THE STORED KEY IS THE PROBLEM, pass `forceRefetch`. Preferring
 * `convo.peerKey` is what makes a stale key permanent: a peer that republishes
 * its identity — which is exactly what a device that cannot persist one does on
 * every launch — leaves every other device deriving against a key that no
 * longer exists, and no amount of retrying with the stored value can recover.
 * Forcing skips the stored key and asks the server what the peer is publishing
 * NOW. `onPeerKeyChanged` hands the new value back so the caller can persist it;
 * this module deliberately does not reach for `db` itself, because the room
 * layer imports it and that would close an import cycle.
 *
 * A forced re-fetch that comes back empty (offline, server down) falls back to
 * the stored key rather than throwing. The room then opens exactly as badly as
 * it did a moment ago, which beats going dark on a transient network error.
 *
 * @param fetchToken async () => accessToken, injected so this module needs no
 *        dependency on the transport (and so tests need no socket).
 * @param opts {{forceRefetch?: boolean, onPeerKeyChanged?: (key: string) => void}}
 */
export async function roomKeyForConvo (convo, fetchToken, opts = {}) {
  if (convo?.e2eVersion !== E2E_V2) throw new Error('not an e2e_v2 conversation')
  const identity = await loadIdentity()
  if (!identity?.privateKey) throw new Error('this device has no identity key')

  const stored = convo.peerKey || null
  let peerKey = opts.forceRefetch ? null : stored
  if (!peerKey && convo.peer?.id && typeof fetchToken === 'function') {
    const { accessToken } = (await fetchToken()) || {}
    const found = await fetchPeerKey(convo.peer.id, accessToken)
    peerKey = found?.publicKey || null
    if (peerKey && peerKey !== stored) opts.onPeerKeyChanged?.(peerKey)
  }
  if (!peerKey && opts.forceRefetch) peerKey = stored
  if (!peerKey) throw new Error('no peer public key for this conversation')

  return deriveRoomKey({ identity, peerPublicKeyB64: peerKey, roomId: convo.roomId })
}
