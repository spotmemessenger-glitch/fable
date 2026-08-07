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
import { applyToRecord } from './identity-pin-store.js'
import { OBSERVE, VERIFY } from './identity-pin.js'
import { recordOpenFailure, recordOpenSuccess, lastFailure, explainFailure } from '../storage-health.js'

/**
 * Record that a human compared this exact key out of band.
 *
 * `verifiedKey` MUST be the key taken from the scanned payload — the one the
 * comparison actually covered — and never a key re-read from the conversation
 * or the server between the comparison and this call. That window is precisely
 * where a substitution would land, and it is why `verifyScannedPayload` returns
 * the compared key rather than leaving the caller to look it up again.
 *
 * `applyEvent` then matches it against the stored pin or proposal, so verifying
 * a PROPOSED key succeeds only when that exact proposal was what was compared,
 * and a key matching neither is refused with KEY_MISMATCH.
 *
 * AWAITED, unlike `observePeerKey`. This one is a direct answer to something
 * the user just did, so the UI has to be able to say whether it was recorded —
 * "verified" that did not persist is the worst of both outcomes.
 */
export async function recordVerification (peerId, verifiedKey, meta = {}) {
  if (!peerId || !verifiedKey) return { ok: false, error: { code: 'MISSING_KEY' } }
  return applyToRecord(peerId, { type: VERIFY, at: Date.now(), key: verifiedKey, ...meta })
}

/**
 * Record that a peer published this key. Returns the resulting trust record,
 * or null if it could not be recorded.
 *
 * BEST EFFORT, DELIBERATELY, IN THIS STEP. If the pin store cannot be reached —
 * private browsing, a blocked origin, an older tab holding the database — the
 * key path must still work. Refusing to open any conversation because an audit
 * record could not be written would be a far larger outage than the attack this
 * defends against.
 *
 * That is safe only because the refusal to ADOPT a substituted key does not
 * depend on this succeeding: `roomKeyForConvo` decides trust from the key it
 * already holds and merely RECORDS it here. A5 is where an unavailable store
 * becomes a fail-closed condition rather than a degraded one.
 */
const OBSERVE_TIMEOUT_MS = 2000

async function observePeerKey (peerId, key, meta = {}) {
  if (!peerId || !key) return null
  let timer = null
  try {
    /* BOUNDED. A storage layer is entitled to wait for its own request; this
     * layer is the one that decided the write is optional, so this is where the
     * waiting stops. An IndexedDB that never answers — a version-change
     * deadlock against another tab, a wedged origin — would otherwise hang the
     * key path forever, and a chat that never opens is a worse failure than an
     * audit record that was not written. */
    const out = await Promise.race([
      applyToRecord(peerId, { type: OBSERVE, at: Date.now(), key, ...meta }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), OBSERVE_TIMEOUT_MS)
        // Node holds the process open for a pending timer; a browser has no
        // unref and does not need one.
        timer?.unref?.()
      }),
    ])
    return out?.ok ? out.next : null
  } catch {
    return null
  } finally {
    // Cleared either way: a pending timer keeps a Node process alive and holds
    // a needless handle in the browser.
    if (timer) clearTimeout(timer)
  }
}

const DB_NAME = 'spotme-e2e'
const STORE = 'identity'
const SELF = 'self'

function openDb () {
  return new Promise((resolve, reject) => {
    let req
    // `indexedDB.open` can throw SYNCHRONOUSLY in locked-down Safari, where a
    // promise executor turns it into an unhandled rejection with no name.
    try { req = indexedDB.open(DB_NAME, 1) } catch (err) { return reject(err) }
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    /* NEITHER onsuccess NOR onerror IS GUARANTEED TO FIRE.
     *
     * `onblocked` fires instead when another tab holds an older version, and on
     * iOS a tab suspended mid-open fires nothing at all. This promise then
     * never settles — and `loadIdentity()` awaits it, so every caller waiting
     * on an identity waits forever. From the outside that is not "storage
     * failed", it is "the app hung", which is exactly what was reported and
     * could not be explained. Settle, always, with a reason. */
    const settle = (err) => { clearTimeout(timer); if (err) reject(err); else resolve(req.result) }
    const timer = setTimeout(
      () => settle(Object.assign(new Error('indexedDB.open did not settle within 3000ms'), { name: 'TimeoutError' })),
      3000
    )
    req.onsuccess = () => settle(null)
    req.onerror = () => settle(req.error || Object.assign(new Error('open failed with no error object'), { name: 'UnknownError' }))
    req.onblocked = () => settle(Object.assign(new Error('open blocked by another tab holding an older version'), { name: 'BlockedError' }))
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

/* THE IN-FLIGHT LOAD, not just the finished one.
 *
 * Found by the A5 matrix. `if (cached) return cached` deduplicates SEQUENTIAL
 * callers and does nothing for CONCURRENT ones: on a device with no stored
 * identity, two callers both see null, both generate a pair, and both write it.
 * Last write wins the database — and the loser keeps using its own key in
 * memory for whatever it derived.
 *
 * That is reachable on any first launch. `main.js` fires `publishIdentity`
 * fire-and-forget at boot; `rooms.js` registers `roomKeyForConvo` as a key
 * provider that runs on room join; `reach.js` calls `loadIdentity` on an
 * inbound knock. Any two overlapping produce two identities, so the key that
 * gets PUBLISHED is not the key some rooms were DERIVED with, and those rooms
 * go dark on the next launch with the server reporting everything fine.
 *
 * Symptomatically identical to the write-failure bug documented below, and a
 * different cause — which is why fixing that one did not fix this one.
 *
 * `identity-pin-store.js` already solved the same problem the same way, for the
 * same reason: cache the PROMISE so racing callers share one load. */
let loading = null

/**
 * This device's identity, generated once and reused. Generation is idempotent
 * per device; a SECOND device gets a DIFFERENT key, which is why a v2 chat does
 * not follow you across devices yet (ADR-001, Consequences).
 */
export async function loadIdentity () {
  if (cached) return cached
  // Cleared on settle, not kept: a load that failed must be retryable, because
  // private browsing can deny once and allow later.
  if (!loading) loading = loadIdentityOnce().finally(() => { loading = null })
  return loading
}

async function loadIdentityOnce () {
  if (cached) return cached
  let db
  /* THE EXCEPTION IS THE DIAGNOSIS. It used to be discarded here, and the
   * banner guessed "private browsing is the usual cause" for every failure mode
   * at once — so someone whose store had been evicted was told to change a
   * setting they were not using, and nobody could tell the two apart because
   * nothing anywhere recorded which had happened. Record it, then behave
   * exactly as before. */
  try {
    db = await openDb()
  } catch (err) {
    openFailed = true
    recordOpenFailure(DB_NAME, err)
    return null
  }
  openFailed = false
  recordOpenSuccess()

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
  } catch (err) {
    openFailed = true
    recordOpenFailure(DB_NAME, err, 'read')
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
  loading = null
  openFailed = false
}

/** WHY the store is unavailable — the recorded exception, never a guess.
 *  Null when nothing has failed. */
export function identityFailure () {
  return openFailed ? { ...(lastFailure() || {}), advice: explainFailure() } : null
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
export const PUBLISH = Object.freeze({
  OK: 'ok',
  NO_IDENTITY: 'no-identity',
  NO_TOKEN: 'no-token',
  /** THE A3 CASE. This device cannot persist its key, and a good record is
   *  already published, so republishing would break every existing chat. Not a
   *  failure to be retried — a deliberate, recoverable refusal the user has to
   *  be told about, because only they can fix it (leave private browsing, free
   *  up storage, use a different device). */
  // 'refused-ephemeral' retired in F2: the record now always states the key
  // actually in use; peers adopt changes through the proof-driven self-heal.
  FAILED: 'failed',
})

/* An OBJECT, not a bare string. A string result would make 'failed' truthy and
 * silently invert every `if (await publishIdentity(...))` ever written. */
const pub = (reason) => ({ ok: reason === PUBLISH.OK, reason })

export async function publishIdentity (fetchToken) {
  const id = await loadIdentity()
  if (!id?.publicKeyB64) return pub(PUBLISH.NO_IDENTITY)
  // Accept either a token or a function that gets one. Boot has no token in
  // hand yet — minting it is itself async — so the caller passes freshTokens.
  let accessToken = fetchToken
  if (typeof fetchToken === 'function') {
    try { accessToken = (await fetchToken())?.accessToken } catch { return pub(PUBLISH.NO_TOKEN) }
  }
  if (!accessToken) return pub(PUBLISH.NO_TOKEN)

  /* ALWAYS PUBLISH THE KEY THIS SESSION ACTUALLY ENCRYPTS WITH.
   *
   * This used to refuse when the identity could not be persisted (the old A3
   * rule: protect the published record from ephemeral churn). Measured on real
   * handsets, that refusal was the WORSE failure: the transport encrypts with
   * the in-hand key regardless, so peers self-healing against the server
   * record fetched a key this session does not hold — wrong-key in both
   * directions, permanently, with no user-visible cause (Fix-the-Foundation
   * F2). Owner decision: a re-key heals automatically — peers re-fetch on
   * decrypt failure and adopt (roomKeyForConvo), with the change recorded in
   * the trust store and surfaced in Verify. An unpublishable truth is the one
   * thing this record must never hold. */
  if (id.persisted === false) {
    console.warn(
      'spotme identity: publishing an EPHEMERAL key — this window cannot persist ' +
      'storage, so peers will see a key change on every launch (they self-heal).'
    )
  }

  try {
    const res = await fetch(`${API_BASE}/api/v2/auth/keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ publicKey: id.publicKeyB64, algo: id.algo })
    })
    return pub(res.ok ? PUBLISH.OK : PUBLISH.FAILED)
  } catch {
    return pub(PUBLISH.FAILED)
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

  const peerId = convo.peer?.id || null
  const stored = convo.peerKey || null

  /* SEED THE PIN FROM WHAT IS ALREADY LOCAL, never from the network.
   *
   * A conversation that predates pinning already has a key it has been using
   * successfully, and that key becomes the pin. Seeding from a fetch instead
   * would hand the server the choice of every pin at upgrade time — one
   * request, and it owns the trust anchor for every existing chat. This
   * ordering is the whole reason the migration is safe.
   *
   * FIRE AND FORGET, and this is deliberate. `convo.peerKey` IS the effective
   * pin on this path: it is already local, already loaded, and is exactly the
   * key the conversation has been trusting. So the refusal below is pure logic
   * over a value in hand, and the store is the durable RECORD — the thing that
   * survives, accumulates provenance, and drives the UI. Awaiting it would put
   * IndexedDB on the critical path of every key derivation, where a slow or
   * wedged origin becomes a stall on opening a chat. A5 makes the store
   * authoritative, at a point where blocking on it is a UI decision rather than
   * the hot path. */
  if (stored) void observePeerKey(peerId, stored, { source: 'stored' })

  let trusted = stored
  let fetched = null
  if ((opts.forceRefetch || !trusted) && peerId && typeof fetchToken === 'function') {
    const { accessToken } = (await fetchToken()) || {}
    const found = await fetchPeerKey(peerId, accessToken)
    fetched = found?.publicKey || null
    if (fetched) {
      void observePeerKey(peerId, fetched, {
        source: opts.forceRefetch ? 'server-refetch' : 'server-first-use',
        reason: opts.reason || null,
      })
    }
  }

  /* A DIFFERENT KEY: ADOPT WHEN FRAMES PROVED THE PIN DEAD, PROPOSE OTHERWISE.
   *
   * Fix-the-Foundation F2 (owner decision) rebalanced this. The pure
   * proposal-only rule protected the pin from a server able to provoke a
   * decrypt failure — but its price, measured on real handsets, was that every
   * HONEST re-key (a device that lost its storage and recovered its account)
   * turned the conversation permanently unreadable in both directions, with
   * the UI telling both people to delete the chat.
   *
   * The rule now: on `forceRefetch` — which only the transport's self-heal
   * sets, and only after a frame actually failed to open against the pinned
   * key — the fetched key is ADOPTED so the conversation continues. The
   * adoption is loud, not silent: `observePeerKey` above has already recorded
   * the changed key with 'server-refetch' provenance (the trust store marks
   * the peer Changed, which Verify surfaces), and `onPeerKeyAdopted` lets the
   * room layer persist the new pin and log it. On every OTHER path — boot,
   * first derive — a differing key remains a proposal and the pin is
   * untouched: nothing may rotate a pin except proof the old one stopped
   * working. */
  if (fetched && trusted && fetched !== trusted) {
    if (opts.forceRefetch) {
      opts.onPeerKeyAdopted?.({ adopted: fetched, previous: trusted, peerId })
      trusted = fetched
    } else {
      opts.onPeerKeyProposed?.({ proposed: fetched, pinned: trusted, peerId })
    }
  } else if (fetched && !stored) {
    /* First key this conversation has ever had. Nothing is being replaced, so
     * there is nothing to protect and it is safe to cache locally. */
    opts.onPeerKeyChanged?.(fetched)
  }

  if (!trusted && fetched) trusted = fetched
  if (!trusted) throw new Error('no peer public key for this conversation')

  return deriveRoomKey({ identity, peerPublicKeyB64: trusted, roomId: convo.roomId })
}
