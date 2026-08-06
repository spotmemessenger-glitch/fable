/**
 * Spot Me — server-backed transport.
 *
 * A drop-in for the Trystero API surface net.js and reach.js consume
 * (joinRoom / selfId / actions / peers / streams), carried over ONE Socket.IO
 * connection to the Spot Me backend instead of tracker-discovered WebRTC.
 *
 * WHAT THE SERVER CAN AND CANNOT SEE
 *
 * Every action payload is AES-GCM encrypted here, in the client, with a key
 * derived from the room secret — which travels in URL fragments and local
 * storage, never to the server. The server stores and relays ciphertext; it
 * observes WHO is in WHICH room and WHEN (the metadata BitTorrent trackers
 * already observed) but not content. Inbox rooms are the exception: their
 * password is a fixed constant, so a knock is decryptable by anyone who knows
 * the scheme — the same exposure the old api/knock relay accepted. Phase 2
 * seals knocks to the recipient's public key.
 *
 * WHAT THIS BUYS OVER P2P
 *
 * Persistent actions land in a per-room server log and REPLAY on join from
 * this device's last cursor — messages, reactions, edits, deletes, read
 * receipts and knocks now arrive even when the two devices were never online
 * together. That is the single failure P2P could not fix.
 *
 * Calls no longer live here at all. Media used to ride RTCPeerConnections
 * built in this file, and that path is deleted (ADR-004): call audio and video
 * now go to the LiveKit SFU, which CAN see them. Only the ring/accept/decline
 * signal still travels this transport, as an ordinary sealed action.
 *
 * Opt-out: localStorage['spotme.transport'] = 'p2p' restores Trystero.
 */
import { io } from 'socket.io-client'
import * as torrent from '@trystero-p2p/torrent'
import { db } from './db.js'

import { API_BASE as SERVER } from './api.js'
const TOKEN_KEY = 'spotme.server.tokens'

/* Reported at auth so the install table can answer "which build is out there".
 * Kept literal rather than imported from package.json: a JSON import would pull
 * the whole manifest into the bundle to read one string. */
const APP_VERSION = '1.0.0'
const CURSOR_PREFIX = 'spotme.cursor.'
const ACK_TIMEOUT_MS = 15_000
const KEY_ITERATIONS = 60_000
const PROFILE_POLL_MS = 500

export const serverMode = (() => {
  try { return localStorage.getItem('spotme.transport') !== 'p2p' } catch { return true }
})()

/** Stable identity: the profile id, not a per-session random — which also
 * makes "mine" detection survive reloads for the first time. */
export let selfId = serverMode ? (db.profile()?.id || null) : torrent.selfId

const enc = (s) => new TextEncoder().encode(s)
const dec = (b) => new TextDecoder().decode(b)

function randomHex (bytes = 8) {
  const u = new Uint8Array(bytes)
  crypto.getRandomValues(u)
  return Array.from(u, (b) => b.toString(16).padStart(2, '0')).join('')
}

const toBytes = (data) => data instanceof Uint8Array
  ? data
  : data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : null

function concatBytes (parts) {
  const total = parts.reduce((n, p) => n + p.byteLength, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.byteLength }
  return out
}

/* ------------------------------------------------------------- crypto --- */

const keyCache = new Map()

/**
 * Install a room key that was AGREED rather than derived from a password.
 *
 * e2e_v2 rooms (ADR-001) get their AES-GCM key from an X25519 ECDH exchange, so
 * there is no password to stretch — the key already exists before the room is
 * joined. Seeding the same cache `roomKey()` reads means the entire message
 * path below is unchanged: seal/open neither know nor care which scheme
 * produced the key, which is exactly why this is the seam to use. A v1 room
 * simply never calls this and falls through to PBKDF2 as before.
 *
 * Must be called BEFORE joinRoom for that roomId, or the password path wins the
 * cache and the peer will not be able to open anything you send.
 */
export function setRoomKey (roomId, key) {
  if (!roomId || !key) return
  keyCache.set(`${roomId}`, Promise.resolve(key))
}

/**
 * roomId -> async () => CryptoKey. A room with a provider NEVER falls back to
 * the password.
 */
const keyProviders = new Map()

/**
 * Declare that this room's key is AGREED, and how to re-agree it.
 *
 * This exists because `setRoomKey` alone was not enough. The agreed key lived
 * only in `keyCache`, which dies with the page — so after a reload
 * `rooms.connectAll()` rejoined every stored room with `convo.secret` and
 * `roomKey()` quietly derived PBKDF2 over the cyrb53 v1 secret. Both peers did
 * the identical thing, so the chat kept working and nothing surfaced: an
 * e2e_v2 room silently reverted to the exact key V-19 is about, while the UI
 * went on promising the server holds no key to it.
 *
 * A provider makes that impossible. Once registered, this room has no password
 * path at all — if agreement cannot be reached the room does not open, which is
 * the correct outcome. Failing loudly beats silently using a key the server can
 * recompute.
 */
export function setRoomKeyProvider (roomId, provider) {
  if (!roomId || typeof provider !== 'function') return
  const cacheKey = `${roomId}`
  keyProviders.set(cacheKey, provider)
  // Evict anything already derived: a PBKDF2 key cached from an earlier join
  // must not outlive the moment we learn this room is v2.
  keyCache.delete(cacheKey)
}

/**
 * Forget this room's replay position, so the next join asks for its history
 * from the beginning.
 *
 * Only for deleting a conversation. The server replays strictly `id > since`,
 * so a cursor left behind means a re-created chat starts mid-history with a
 * hole where the undelivered messages were — which is exactly the state the
 * "delete this chat and start it again" advice is meant to escape. Replaying
 * from 0 is safe by construction: `store.add()` dedupes by id and honours
 * tombstones.
 */
export function clearRoomCursor (roomId) {
  try {
    localStorage.removeItem(`${CURSOR_PREFIX}${db.profile()?.id || 'anon'}.${roomId}`)
  } catch { /* private mode */ }
}

/**
 * Seal / open bytes with a room's key, WITHOUT handing the key out.
 *
 * Phase 5 uploads attachment slices straight to object storage, so the sealing
 * that used to happen inside `sendAction` has to happen before the bytes ever
 * reach a socket. This module owns `roomKey()` — the ADR-001 provider lives
 * here and a v2 room has no password path — so this is the only correct place
 * to expose that capability from.
 *
 * WHAT IS DELIBERATELY NOT EXPORTED: the key. These take bytes and return
 * bytes. A caller can encrypt for a room it is already in and decrypt what it
 * is already entitled to read; it cannot obtain, derive, store or forward the
 * key itself. That distinction is the whole reason FORBIDDEN_KEY_SURFACE bans
 * `roomKey`/`deriveKey` on adapters while this pair is fine here: adapters move
 * opaque bytes, this module owns the secret.
 *
 * A room with a key provider and no agreed key REJECTS rather than falling back
 * to a password, exactly as the message path does — an upload must not be the
 * one door where a v2 room quietly degrades to the cyrb53 secret.
 */
export async function sealForRoom (roomId, bytes, password) {
  const key = await roomKey(roomId, password)
  return seal(key, toBytes(bytes) || new Uint8Array(0))
}

export async function openForRoom (roomId, sealed, password) {
  const key = await roomKey(roomId, password)
  return openSealed(key, sealed)
}

/** Forget a room entirely — used when a room is downgraded or wiped. */
export function clearRoomKey (roomId) {
  const cacheKey = `${roomId}`
  keyProviders.delete(cacheKey)
  keyCache.delete(cacheKey)
  refreshInFlight.delete(cacheKey)
  refreshedAt.delete(cacheKey)
}

/* Self-heal bookkeeping. `refreshInFlight` coalesces — a join replay of thirty
 * undecryptable frames must produce ONE key fetch, not thirty. `refreshedAt`
 * is the floor under that: when a room is genuinely unrecoverable every frame
 * that arrives would otherwise hit the network forever. */
const refreshInFlight = new Map()
const refreshedAt = new Map()
const REFRESH_COOLDOWN_MS = 30_000

/**
 * Re-agree this room's key because the one in hand cannot open a frame.
 *
 * THE BUG THIS EXISTS FOR. A device that cannot persist its X25519 identity
 * republishes a fresh public key on every launch, and each republish
 * staleifies the `convo.peerKey` every peer stored at creation. Both sides then
 * derive different room keys and every frame is dropped undecryptable — in both
 * directions, permanently, because `roomKeyForConvo` prefers the stored
 * `peerKey` and only fetches when it is absent. Measured on two real handsets:
 * @vijay22's published key moved three times in one session, @ajith11's never
 * did, and the chat went silent while the server kept accepting messages and
 * push notifications kept firing.
 *
 * Evicting the cache alone does nothing: the provider would re-derive from the
 * same stale stored key. `forceRefetch` is what makes this a repair.
 *
 * v1 rooms have no provider and get null — a PBKDF2 key derived from the room
 * password cannot be wrong in this way, so there is nothing to re-agree.
 *
 * Returns the fresh key, or null if this room cannot or should not refresh now.
 */
export function refreshRoomKey (roomId) {
  const cacheKey = `${roomId}`
  if (!keyProviders.has(cacheKey)) return Promise.resolve(null)
  const inFlight = refreshInFlight.get(cacheKey)
  if (inFlight) return inFlight
  if (Date.now() - (refreshedAt.get(cacheKey) || 0) < REFRESH_COOLDOWN_MS) return Promise.resolve(null)

  // Stamped BEFORE the attempt, so a failing refresh is rate-limited too.
  refreshedAt.set(cacheKey, Date.now())
  keyCache.delete(cacheKey)
  const run = Promise.resolve()
    .then(() => roomKey(roomId, undefined, { forceRefetch: true }))
    .catch(() => null)          // a wedged room must not become an unhandled rejection
    .then((key) => { refreshInFlight.delete(cacheKey); return key || null })
  refreshInFlight.set(cacheKey, run)
  return run
}

function roomKey (roomId, password, opts) {
  const cacheKey = `${roomId}`
  if (!keyCache.has(cacheKey)) {
    const provider = keyProviders.get(cacheKey)
    if (provider) {
      // NO password fallback on this branch, by design. A rejected provider
      // also evicts itself so a later attempt (peer publishes a key, network
      // returns) can succeed instead of the room being wedged forever.
      keyCache.set(cacheKey, Promise.resolve()
        .then(() => provider(opts))
        .then((key) => {
          if (!key) throw new Error(`no agreed key for room ${roomId}`)
          return key
        })
        .catch((err) => { keyCache.delete(cacheKey); throw err }))
    } else {
      keyCache.set(cacheKey, (async () => {
        const material = await crypto.subtle.importKey(
          'raw', enc(String(password ?? '')), 'PBKDF2', false, ['deriveKey'])
        return crypto.subtle.deriveKey(
          { name: 'PBKDF2', salt: enc(`spotme-room-v1:${roomId}`), iterations: KEY_ITERATIONS, hash: 'SHA-256' },
          material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
      })())
    }
  }
  return keyCache.get(cacheKey)
}

async function seal (key, bytes) {
  const iv = new Uint8Array(12)
  crypto.getRandomValues(iv)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes))
  return concatBytes([iv, ct])
}

async function openSealed (key, frame) {
  // Wire frames are base64 text; local callers may still hand over bytes.
  const bytes = typeof frame === 'string' ? unb64(frame) : toBytes(frame)
  if (!bytes || bytes.byteLength < 13) throw new Error('bad frame')
  const iv = bytes.slice(0, 12)
  const ct = bytes.slice(12)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct))
}

/**
 * Payloads cross the wire as base64 TEXT, never as binary attachments.
 *
 * socket.io splits every Buffer/Uint8Array into its own WebSocket frame after
 * the JSON packet, and the decoder then demands exactly those frames next.
 * Anything that interleaves — a heartbeat ping, another emit — makes it read
 * text where it expects binary and it drops the connection with `parse error`.
 * A join replay carrying ~10 payloads killed the socket every time, and because
 * sends fail asynchronously the only symptom was screens quietly not updating.
 * One unsplittable text frame is worth the ~33% overhead; Phase 2 moves media
 * to signed R2 URLs and takes most of that back.
 *
 * Chunked so a multi-megabyte slice cannot blow the argument limit that
 * String.fromCharCode(...bytes) would hit on a spread of ~128k elements.
 */
const b64 = (bytes) => {
  let out = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
  }
  return btoa(out)
}
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

/**
 * Metadata rides encrypted except the routing fields the server must act on.
 *
 * `once` and `burn` are the two view-once flags, and they are cleartext for a
 * reason that is worth stating plainly: deleting bytes is something only
 * whoever HOLDS the bytes can do, and that is the server. Sealed inside `cm`
 * they were invisible to it, which is exactly why a "burned" private photo sat
 * in Postgres forever and could be re-downloaded after the burst animation.
 *
 * What they leak is that SOME attachment in this room is view-once, and which
 * id it is — the same routing-level metadata `{id, seq, total}` already
 * exposes. Nothing about the photo itself crosses; the envelope, the caption
 * and the burst duration all stay inside `cm`.
 */
async function wrapMeta (key, metadata) {
  if (!metadata) return undefined
  const cm = b64(await seal(key, enc(JSON.stringify(metadata))))
  const meta = { id: metadata.id, seq: metadata.seq, total: metadata.total, cm }
  if (metadata.viewOnce) meta.once = true
  if (metadata.burn) meta.burn = String(metadata.burn)
  return meta
}

async function unwrapMeta (key, meta) {
  if (!meta) return undefined
  if (meta.cm) {
    try { return JSON.parse(dec(await openSealed(key, unb64(meta.cm)))) } catch { /* fall through */ }
  }
  return { id: meta.id, seq: meta.seq, total: meta.total }
}

/* ---------------------------------------------------- auth + socket ----- */

let socketPromise = null

/* Terminal auth — an account the server will never accept again.
 *
 * Stopping the retry loop is only half of it. A device that silently stops
 * trying looks exactly like a device that is quietly working, which is the
 * failure mode this whole area keeps producing, so the fact has to be
 * reportable. Registered by the app; announced at most once per page. */
let onTerminalAuthHandler = null
let terminalAuthAnnounced = false

/** Called when this identity can never authenticate again. `{code, message}`. */
export function setTerminalAuthHandler (fn) {
  onTerminalAuthHandler = typeof fn === 'function' ? fn : null
}

/** What the app can ask, e.g. before showing a chat that will never connect. */
export function isTerminalAuth () { return terminalAuthAnnounced }

function onTerminalAuth (error) {
  if (terminalAuthAnnounced) return
  terminalAuthAnnounced = true
  console.warn(`spotme auth: ${error?.message || 'this identity is no longer accepted'}`)
  try {
    onTerminalAuthHandler?.({ code: error?.code || 'terminal', message: error?.message || '' })
  } catch { /* a reporting failure must not resurrect the loop */ }
}

async function guestAuth () {
  // Wait out onboarding: the profile appears in local storage the moment the
  // user taps Start; nothing joins a room before that anyway.
  let me = db.profile()
  while (!me?.id) {
    await new Promise((r) => setTimeout(r, PROFILE_POLL_MS))
    me = db.profile()
  }
  const username = me.username || `u_${String(me.id).slice(0, 14)}`
  const body = {
    id: me.id,
    username,
    name: me.name || undefined,
    secret: me.claimSecret || `anon_${me.id}`,
    // Install telemetry. Without this the server counts sessions but has no
    // idea what they run on, so "how many phones is this installed on?" has no
    // answer — which is exactly where we were. Capacitor reports 'android' or
    // 'ios' inside the packaged app and 'web' in a browser tab.
    platform: globalThis.Capacitor?.getPlatform?.() || 'web',
    appVersion: APP_VERSION,
    // 18+ gate: a NEW identity is an account creation, which the server
    // refuses without an adult declaration. Onboarding stored the year-month
    // on this device; older installs that predate the field simply omit it
    // (their account already exists, so re-auth needs no declaration).
    birthYearMonth: me.birthYearMonth || undefined
  }
  let res = await fetch(`${SERVER}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (res.status === 409) {
    // Claimed by someone else in the new registry — take a derived handle;
    // the visible display name is unaffected.
    res = await fetch(`${SERVER}/api/auth/guest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, username: `${username.slice(0, 11)}_${String(me.id).slice(0, 4)}` })
    })
  }
  /* A DELETED ACCOUNT IS TERMINAL. STOP, DO NOT RETRY.
   *
   * Everything here used to collapse into one untyped throw, and the callers
   * treat any failure as transient: `ensureSocket` nulls its promise so the
   * next call retries, and `join` re-runs itself every two seconds forever.
   * For a backend blip that is exactly right. For an account that no longer
   * exists it is a device spinning silently until the battery goes, with the
   * user told nothing at all.
   *
   * The server distinguishes the two now — 403 `deleted_account` rather than a
   * 401 — so this marks the error `terminal` and the retry paths honour it. */
  if (res.status === 403) {
    let code = null
    try { code = (await res.clone().json())?.error } catch { /* non-JSON body */ }
    if (code === 'deleted_account') {
      const dead = new Error('this account has been deleted')
      dead.terminal = true
      dead.code = 'deleted_account'
      throw dead
    }
  }
  /* An age refusal is TERMINAL, like a deleted account: the server will refuse
   * this identity's creation on every retry, so the 2s retry loops must stop
   * rather than spin silently forever (which is exactly what a plain 400 did
   * to every pre-gate install). */
  if (res.status === 400) {
    let msg = null
    try { msg = (await res.clone().json())?.message } catch { /* non-JSON body */ }
    const text = Array.isArray(msg) ? msg.join(' ') : String(msg || '')
    if (text.includes('18 and over')) {
      const refused = new Error('Spot Me is for people 18 and over.')
      refused.terminal = true
      refused.code = 'age_requirement'
      throw refused
    }
    /* A device from before the gate: its profile has no stored declaration, so
     * account creation is refused until one is made. Terminal here, and the
     * shell routes it back through onboarding to collect the birth month. */
    if (text.includes('birthYearMonth') && !me.birthYearMonth) {
      const need = new Error('Spot Me is 18+ now — confirm your birth month to continue.')
      need.terminal = true
      need.code = 'age_declaration_required'
      throw need
    }
  }
  if (!res.ok) throw new Error(`guest auth failed (${res.status})`)
  const tokens = await res.json()
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens)) } catch { /* private mode */ }
  selfId = tokens.userId
  return tokens
}

/** Reuse a token while it is comfortably inside its TTL: the auth callback
 *  runs on every handshake, and each mint also writes a refresh-token row. */
let cachedTokens = null
let cachedAt = 0
const TOKEN_REUSE_MS = 8 * 60_000

export async function freshTokens () {
  if (cachedTokens && Date.now() - cachedAt < TOKEN_REUSE_MS) return cachedTokens
  cachedTokens = await guestAuth()
  cachedAt = Date.now()
  return cachedTokens
}

const activeRooms = new Map()   // roomId -> room internals (for rejoin/dispatch)

function ensureSocket () {
  if (socketPromise) return socketPromise
  socketPromise = (async () => {
    const tokens = await guestAuth()
    const socket = io(`${SERVER}/rooms`, {
      // Callback form, not a fixed value: access tokens are short-lived, so a
      // tab that sleeps past expiry would otherwise retry forever with a dead
      // token — the server accepts the handshake, rejects the JWT, and drops
      // the socket, which looks exactly like "the app stopped working".
      // socket.io calls this before every attempt, including reconnects.
      auth: (cb) => {
        freshTokens()
          .then((fresh) => cb({ token: fresh.accessToken }))
          .catch(() => cb({ token: tokens.accessToken }))
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelayMax: 5000
    })
    socket.on('action', (frame) => activeRooms.get(frame?.roomId)?.onFrame(frame))
    socket.on('peer', (frame) => activeRooms.get(frame?.roomId)?.onPeer(frame))
    /* Only RE-connects rejoin. This handler is registered above the
     * `once('connect', resolve)` below, so on the first connect it ran FIRST —
     * and every room is already in `activeRooms` by then, because `serverRoom`
     * registers itself and calls `join()` synchronously while this promise is
     * still awaiting `guestAuth`. So each room emitted `join` twice with the
     * same `since`, and the server replayed the whole window twice.
     *
     * Duplicate messages were absorbed by `store.add`'s id check, which is why
     * this stayed invisible. The damage was to the cursor hold: two replay loops
     * interleave on their awaits, and the second one's `unopenedFloor = null`
     * cleared a floor the first had just set for a frame it could not open. The
     * first loop then advanced the cursor straight past it — exactly the loss
     * `unopenedFloor` exists to prevent, re-opened by the double join. */
    let everConnected = false
    socket.on('connect', () => {
      if (!everConnected) { everConnected = true; return }
      for (const room of activeRooms.values()) room.rejoin()
    })
    // Debug handle in the spirit of window.__rooms / window.__lobby: a dead
    // socket is otherwise invisible, because sends fail asynchronously and the
    // UI just stops updating. Carries no secrets the page does not already have.
    if (typeof window !== 'undefined') {
      window.__transport = { socket, activeRooms, drops: [] }
      socket.on('disconnect', (reason, details) => {
        window.__transport.drops.push({ reason, at: Date.now(), detail: details?.description })
      })
    }
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve)
      socket.once('connect_error', (e) => reject(new Error(`socket connect failed: ${e?.message || e}`)))
    })
    return socket
  })()
  socketPromise.catch((error) => {
    // Allow a retry after a transient failure — but a terminal one must STAY
    // failed, or nulling this is just the retry loop by another name.
    if (!error?.terminal) socketPromise = null
  })
  return socketPromise
}

async function emitAck (socket, event, body) {
  const res = await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, body)
  if (res?.error) throw new Error(res.error)
  return res
}

/* ----------------------------------------------------------- the room --- */

function serverRoom (config, roomId) {
  const password = config?.password
  /* Who the other participant is, for a DM. The server recomputes the room id
   * from this plus the AUTHENTICATED caller and refuses a mismatch — a DM room
   * id is a pure function of two public ids, so without it anyone who learned
   * two ids could join and replay the whole history (see backend dm-room.ts).
   * Undefined for groups, the lobby and inbox rooms, which the gate skips. */
  const peerId = config?.peerId
  const actions = new Map()      // name -> action record
  const peers = new Map()        // peerId -> fake pc for getPeers()
  const pendingRequests = new Map() // reqId -> {resolve, reject, timer}
  let onPeerJoinHandler = null
  let onPeerLeaveHandler = null
  /* Fired when a frame cannot be opened and re-agreement did not rescue it.
   * The room reports the fact; deciding what a user should be told about it is
   * the view's business, not the transport's. */
  let onUndecryptableHandler = null
  let left = false

  /**
   * Replay cursors are per PROFILE, not just per room.
   *
   * db.wipeDevice() only sweeps `spotme:`-prefixed keys, so a cursor written
   * under one identity outlives a "Clear all data" or ?fresh. Keyed by room
   * alone, the next identity would inherit it and its first join would start
   * mid-history — re-opening an invite link after a reset would show a chat
   * with everything before the reset missing. Replaying from 0 costs a heavier
   * rejoin and nothing else (store.add() dedupes by id and honours
   * tombstones), so an unknown cursor is always the safe answer.
   */
  const cursorKey = () => `${CURSOR_PREFIX}${db.profile()?.id || 'anon'}.${roomId}`
  const readCursor = () => { try { return Number(localStorage.getItem(cursorKey())) || 0 } catch { return 0 } }
  const writeCursor = (n) => { try { localStorage.setItem(cursorKey(), String(n)) } catch { /* private mode */ } }

  /**
   * The lowest seq this room has seen and could NOT open. Nothing at or above
   * it may be marked as consumed.
   *
   * THE BUG THIS EXISTS FOR — it is the reason a broken chat never recovered.
   * The cursor used to advance in `dispatch`'s `finally`, which runs whether or
   * not the frame opened. The server replays strictly `id > since`, so one
   * undecryptable frame burned its own place in the replay window and the
   * message was gone from every future join — permanently, on both devices,
   * even after the key was repaired. Fixing the key brought nothing back
   * because there was nothing left to bring.
   *
   * A wrong key is REPAIRABLE, so a frame it could not open has not been
   * consumed and must keep its place. Anything else — JSON that is not JSON, a
   * type nobody registered — is not repairable by waiting, and holding the
   * cursor for those would stall the room forever, so those still advance.
   *
   * Reset at the start of every join: a rejoin replays from the held cursor, so
   * the failures either recur (and hold again) or do not (and the room moves
   * on). That is what makes this self-correcting rather than a permanent stall.
   */
  let unopenedFloor = null
  /**
   * Hold, but ONLY where a repair is actually possible.
   *
   * `refreshRoomKey` returns null outright for a room with no key provider, and
   * providers exist only for e2e_v2 conversations. A v1 room, a group room, the
   * inbox/knock rooms — all derive from a fixed password, so a frame they cannot
   * open will never open, and holding for it would pin the cursor forever:
   * every reconnect replays a growing prefix until the backlog passes the
   * server's REPLAY_LIMIT and newer events fall out of the window entirely. For
   * the inbox that would eventually stop chat requests arriving.
   *
   * Which is the same rule the catch already applies to a SyntaxError — not
   * repairable by waiting means not worth holding for.
   */
  const holdCursorAt = (seq) => {
    if (!seq || !keyProviders.has(`${roomId}`)) return
    if (unopenedFloor === null || seq < unopenedFloor) unopenedFloor = seq
  }
  /** Advance to `seq`, but never at or past a frame still waiting on a repair. */
  const advanceCursor = (seq) => {
    if (!seq) return
    const ceiling = unopenedFloor === null ? seq : Math.min(seq, unopenedFloor - 1)
    if (ceiling > readCursor()) writeCursor(ceiling)
  }

  /* Re-read the cache on every use instead of capturing the promise once.
   * `refreshRoomKey` repairs a room by EVICTING that cache entry, and a
   * captured promise would go on resolving to the stale key for the life of the
   * page — the room would self-heal in the cache and stay broken in the room. */
  const currentKey = () => roomKey(roomId, password)

  function actionRecord (name) {
    if (!actions.has(name)) {
      actions.set(name, {
        onMessage: null, onReceiveProgress: null, onRequest: null
      })
    }
    return actions.get(name)
  }

  /* -- incoming ---------------------------------------------------------- */

  async function dispatch (frame, isReplay, isRetry) {
    if (left || !frame || frame.from === selfId) return
    const { type, from } = frame
    /* False until the room key is in hand, so the catch can tell "we never got
     * a key" apart from "the key we had did not work". Both are repairable and
     * both must hold the cursor; only the second is worth a re-agreement. */
    let keyReady = false
    /* Set when this call hands the frame to a retry. `try { return f() } finally
     * {}` runs the finally AT the return statement, not when the returned
     * promise settles — so without this the outer call advanced the cursor
     * before the retry had even failed, and the hold arrived too late to matter.
     * The retry owns the cursor for that frame. */
    let delegated = false
    try {
      /* INSIDE the try, deliberately. This used to sit above it, so a room
       * whose key cannot be agreed — an e2e_v2 room has no password fallback,
       * so `roomKeyForConvo` throwing is its designed behaviour — rejected
       * here and became an unhandled rejection: no catch, no warning, no
       * `onUndecryptable`, and the `finally` never ran either. The room went
       * silent with nothing anywhere saying why, while the Discovery lobby
       * (a password room with no provider) kept working and made the app look
       * healthy. */
      const key = await currentKey()
      keyReady = true
      if (type === 'fetchreq') return void handleFetchReq(frame, key)
      if (type === 'fetchres') return void handleFetchRes(frame, key)
      const a = actions.get(type)
      if (!a) return
      if (type === 'bin') {
        const metadata = await unwrapMeta(key, frame.meta)
        const bytes = await openSealed(key, frame.payload)
        a.onReceiveProgress?.(1, { peerId: from, metadata })
        a.onMessage?.(bytes, { peerId: from, metadata })
      } else {
        const payload = JSON.parse(dec(await openSealed(key, frame.payload)))
        a.onMessage?.(payload, { peerId: from })
      }
    } catch (error) {
      /* A WRONG KEY IS REPAIRABLE. TRY, EXACTLY ONCE.
       *
       * `OperationError` is AES-GCM refusing to authenticate — the tag did not
       * match, which for this transport means the key is wrong rather than the
       * bytes are damaged. It is the one failure here worth acting on: a
       * SyntaxError from JSON.parse means we DID decrypt and the sender sent
       * nonsense, and re-agreeing a key would not change that.
       *
       * Only ever one retry (`isRetry`), and `refreshRoomKey` refuses to run
       * more than once per room per cooldown, so a room whose peer key is
       * genuinely gone degrades to the old behaviour — one warning per frame —
       * instead of one key fetch per frame. */
      if (!isRetry && error?.name === 'OperationError') {
        const fresh = await refreshRoomKey(roomId)
        if (fresh) { delegated = true; return dispatch(frame, isReplay, true) }
      }
      /* RE-AGREEMENT DID NOT SAVE IT, SO SAY SO OUT LOUD.
       *
       * Reaching here with an OperationError means the room is genuinely
       * broken: either the retry above ran and still could not authenticate, or
       * there was no repair to offer (v1 room, no provider, or the cooldown is
       * holding). Both are the same fact to a user — messages are arriving and
       * none of them can be opened — and until now both were a `console.warn`
       * on a device with no console, which is how a chat could look merely
       * quiet while it was actually dead.
       *
       * ONLY OperationError. A SyntaxError from JSON.parse means we DID
       * decrypt and the sender sent nonsense; announcing a key mismatch there
       * would blame the key for a bug somewhere else entirely. */
      /* `!keyReady` means `currentKey()` itself rejected — the room has no
       * agreed key at all, which for the user is the same sentence as a wrong
       * one ("messages are arriving and I cannot read them") and is repairable
       * by the same actions. It reports `reason` so the view can distinguish
       * them later without this having to guess now. */
      if (error?.name === 'OperationError' || !keyReady) {
        /* Hold the cursor BEFORE announcing. The announcement is what puts a
         * warning on screen; the hold is what keeps the message retrievable
         * once the user acts on it. */
        holdCursorAt(frame.seq)
        onUndecryptableHandler?.({
          roomId, type, from, isReplay: Boolean(isReplay),
          reason: keyReady ? 'wrong-key' : 'no-key'
        })
      }
      // A frame we cannot decrypt or parse must never kill the dispatch loop —
      // it is one lost event, not a dead room.
      // Logged on replay too: a reload delivers EVERYTHING through replay, so
      // suppressing it there kept the console clean on the one run where the
      // damage was worst.
      console.warn(`spotme transport: dropped ${type} frame${isReplay ? ' (replay)' : ''}:`, error?.message)
    } finally {
      if (!delegated) advanceCursor(frame.seq)
    }
  }

  /**
   * Live frames, ONE AT A TIME, in arrival order.
   *
   * The replay loops are `for … await dispatch(…)` and therefore ordered. Live
   * delivery was not: `onFrame` fired `dispatch` without awaiting it, so two
   * frames arriving together both sat on `await openSealed(…)` and finished in
   * whatever order WebCrypto happened to finish them.
   *
   * That breaks `advanceCursor`, which is only sound in order. A frame that
   * fails sets `unopenedFloor` in its `catch` — but only AFTER a
   * `refreshRoomKey` network round trip. A later frame that decrypts fine
   * reaches its `finally` during that window, sees the floor still `null`, and
   * writes a cursor above the frame that is about to be held. The hold then
   * lands too late and the earlier message is never replayed again.
   *
   * It reorders order-sensitive handlers too: an `edit` that opens before the
   * `msg` it edits finds no target and returns silently, so a corrected message
   * stays wrong forever on the receiving device.
   *
   * Serialising costs nothing real — dispatch is already async and frames
   * arrive far slower than they decrypt — and it fixes both at once.
   */
  let frameChain = Promise.resolve()
  const enqueueFrame = (frame) => {
    frameChain = frameChain.then(() => dispatch(frame, false)).catch(() => {})
  }

  function addPeer (peerId, announce) {
    if (peerId === selfId || peers.has(peerId)) return
    peers.set(peerId, { connectionState: 'connected' })
    if (announce) onPeerJoinHandler?.(peerId)
  }

  function removePeer (peerId) {
    if (!peers.delete(peerId)) return
    closePc(peerId)
    onPeerLeaveHandler?.(peerId)
  }

  /* -- join / rejoin ----------------------------------------------------- */

  /**
   * Attachments that arrived while this device was away, as detached history
   * entries — bubble appears, bytes fetch on demand.
   *
   * SHARED BY BOTH JOIN PATHS, and that is the whole point of it existing.
   * `rejoin` used to skip this block and still run `advanceCursor`, which is
   * unconditional, permanent loss: the server strips `bin` from `ack.events`
   * (rooms.service.ts `type: { not: 'bin' }`), so an envelope is the ONLY way a
   * missed attachment ever comes back, and `lastEventId` counts the bin rows it
   * declined to send. Every photo, voice note and file received across a
   * reconnect was dropped and then marked as consumed.
   *
   * And `rejoin` is the common path, not the rare one — `joinPromise` is cached,
   * so the full `join` runs once per room per page load and every socket drop
   * after that (a lift, wifi handing over to cellular) went through `rejoin`.
   */
  async function absorbEnvelopes (envelopes, key) {
    if (!envelopes?.length) return
    const messages = []
    for (const env of envelopes) {
      const metadata = await unwrapMeta(key, env.meta)
      if (!metadata?.id) continue
      /* `total` is KEPT for a storage-backed attachment.
       *
       * Stripping it was right while every byte lived in the RoomEvent log —
       * the lazy fetch asks the server for slices and counts them itself. A
       * storage-backed attachment has no slices, so a receiver that loses
       * `total` has an envelope it can render and bytes it can never retrieve:
       * "tap to load" that fails forever, on every future join. Measured in the
       * two-origin harness, on the offline-delivery path specifically.
       *
       * `viaStorage` needs no special handling — it rides along in the rest
       * spread, since only `seq` and `total` are destructured out. It is read
       * here rather than restored.
       *
       * The fix lives in this helper rather than at one call site, because all
       * three join paths absorb envelopes and any of them can be the one that
       * carries a missed attachment. envelope-viastorage.test.js pins it. */
      const { seq, total, ...envelope } = metadata
      messages.push(metadata.viaStorage
        ? { ...envelope, total, data: null, detached: true }
        : { ...envelope, data: null, detached: true })
    }
    if (messages.length) actions.get('history')?.onMessage?.({ messages }, { peerId: 'server' })
  }

  /**
   * One replay page: dispatch the events, absorb the envelopes, move the cursor.
   * Returns whether the server says more is waiting above what it just sent.
   *
   * A device offline long enough to miss more than REPLAY_LIMIT events gets a
   * CAPPED page, and there is no second join until the next reconnect — which on
   * a phone that is now awake and working may be hours away, or never. So keep
   * asking while the server says it truncated. `PAGE_CAP` is a stop, not a
   * limit: a server that answered `truncated` forever would otherwise spin here.
   */
  const PAGE_CAP = 20
  async function replayPage (socket) {
    const ack = await emitAck(socket, 'join', { roomId, since: readCursor(), peerId })
    const key = await currentKey()
    unopenedFloor = null
    for (const ev of ack.events || []) await dispatch(ev, true)
    await absorbEnvelopes(ack.envelopes, key)
    advanceCursor(ack.lastEventId)
    return { ack, more: Boolean(ack.truncated) }
  }

  async function drainReplay (socket, firstAck) {
    let more = Boolean(firstAck?.truncated)
    for (let page = 0; more && page < PAGE_CAP; page++) {
      // The floor only holds while a page is being replayed; if a frame in this
      // page could not be opened the cursor has not moved past it, so the next
      // page starts from the same place and we would loop. Stop and let the
      // ordinary rejoin path retry once the key is repaired.
      const before = readCursor()
      const next = await replayPage(socket)
      more = next.more && readCursor() > before
    }
  }

  let joinPromise = null

  function join () {
    if (joinPromise) return joinPromise
    joinPromise = (async () => {
      const socket = await ensureSocket()
      const ack = await emitAck(socket, 'join', { roomId, since: readCursor(), peerId })
      const key = await currentKey()
      /* Cleared only once a key is actually in hand, and AFTER `currentKey()`
       * on purpose. `join` retries every 2s on failure, and `currentKey()` is
       * the throw that fails it — so resetting above this line handed the retry
       * loop a fresh floor every 2 seconds, and each live frame that arrived in
       * between set a HIGHER floor than the last, letting the cursor creep past
       * frames already held. That is the original data loss again, just slower.
       * Past this point the replay is genuinely about to run, so a reset means
       * "re-evaluate what is unopenable now", which is what it is for. */
      unopenedFloor = null
      for (const peerId of ack.peers || []) addPeer(peerId, true)
      for (const ev of ack.events || []) await dispatch(ev, true)
await absorbEnvelopes(ack.envelopes, key)
      advanceCursor(ack.lastEventId)
      await drainReplay(socket, ack)
      return socket
    })()
    joinPromise.catch((error) => {
      // A failed boot (backend briefly down, auth race during onboarding)
      // must not leave the room permanently dead — retry until it lands.
      // A TERMINAL failure is the exception: retrying a deleted account cannot
      // succeed, so this is the loop that has to stop rather than the one that
      // has to persist.
      if (error?.terminal) {
        onTerminalAuth(error)
        return
      }
      joinPromise = null
      if (!left) setTimeout(() => join(), 2000)
    })
    return joinPromise
  }

  async function rejoin () {
    if (left) return
    try {
      const socket = await socketPromise
      const ack = await emitAck(socket, 'join', { roomId, since: readCursor(), peerId })
      const key = await currentKey()
      unopenedFloor = null   // same reasoning as join(): only once a replay is really about to run
      const alive = new Set(ack.peers || [])
      for (const peerId of [...peers.keys()]) if (!alive.has(peerId)) removePeer(peerId)
      for (const peerId of alive) addPeer(peerId, true)
      for (const ev of ack.events || []) await dispatch(ev, true)
      await absorbEnvelopes(ack.envelopes, key)
      advanceCursor(ack.lastEventId)
      await drainReplay(socket, ack)
    } catch { /* reconnect loop will fire again */ }
  }

  /* -- outgoing ---------------------------------------------------------- */

  async function sendAction (type, data, sendOpts = {}, attachId) {
    if (left) return
    const socket = await join()
    const key = await currentKey()
    const bytes = toBytes(data)
    const payload = b64(await seal(key, bytes || enc(JSON.stringify(data ?? null))))
    const meta = await wrapMeta(key, sendOpts.metadata)
    const body = { roomId, type, payload, meta, target: sendOpts.target, attachId }
    let ack
    try {
      ack = await emitAck(socket, 'action', body)
    } catch (error) {
      // A send can beat this room's post-reconnect rejoin to the server, and
      // dropping it there would lose a message the sender already saw as sent.
      if (!/not joined/.test(String(error?.message))) throw error
      await rejoin()
      ack = await emitAck(socket, 'action', body)
    }
    sendOpts.onProgress?.(1, sendOpts.target, sendOpts.metadata)
    return ack
  }

  /* -- lazy fetch (request/response) ------------------------------------- */

  async function requestBytes (data, reqOpts = {}) {
    const socket = await join()
    const key = await currentKey()
    // The server log answers first — it holds every slice ever sent through
    // it, which is exactly the case P2P could not serve (sender offline).
    if (data?.id) {
      const first = await emitAck(socket, 'fetch', { roomId, attachId: data.id, seq: 0 })
      if (!first.missing && first.payload) {
        /* `total` is what the sender declared; `held` is what the log actually
         * has. An upload that died mid-flight leaves a short TAIL, and a short
         * tail is the one truncation that is invisible downstream: the bytes
         * decode, the waveform draws, the clip just stops early. Refuse it
         * here, loudly, rather than hand back a convincing fragment. */
        const total = first.total || 1
        if (Number.isFinite(first.held) && first.held < total) {
          throw new Error(`transfer incomplete on server (${first.held}/${total} slices)`)
        }
        const slices = [await openSealed(key, first.payload)]
        for (let seq = 1; seq < total; seq++) {
          const r = await emitAck(socket, 'fetch', { roomId, attachId: data.id, seq })
          if (r.missing || !r.payload) throw new Error('transfer incomplete on server')
          slices.push(await openSealed(key, r.payload))
        }
        if (slices.length !== total) throw new Error('transfer incomplete on server')
        return concatBytes(slices)
      }
    }
    // Fall back to asking a live peer, Trystero-request style.
    if (!reqOpts.target || reqOpts.target === 'server') throw new Error('not available')
    const reqId = randomHex(8)
    const timeoutMs = reqOpts.timeoutMs || 45_000
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(reqId)
        reject(new Error('fetch timed out'))
      }, timeoutMs)
      pendingRequests.set(reqId, { resolve, reject, timer })
    })
    await sendAction('fetchreq', { reqId, ...data }, { target: reqOpts.target })
    return result
  }

  async function handleFetchReq (frame, key) {
    const req = JSON.parse(dec(await openSealed(key, frame.payload)))
    const a = actions.get('fetch')
    let bytes = null
    try { bytes = await a?.onRequest?.({ id: req.id }, { peerId: frame.from }) } catch { /* no bytes */ }
    const body = toBytes(bytes)
    if (body) {
      const socket = await join()
      await emitAck(socket, 'action', {
        roomId,
        type: 'fetchres',
        payload: b64(await seal(key, body)),
        meta: { id: req.reqId },
        target: frame.from
      })
    } else {
      await sendAction('fetchres', { reqId: req.reqId, missing: true }, { target: frame.from })
    }
  }

  async function handleFetchRes (frame, key) {
    const reqId = frame.meta?.id
    let waiter = reqId && pendingRequests.get(reqId)
    if (waiter) {
      pendingRequests.delete(reqId)
      clearTimeout(waiter.timer)
      waiter.resolve(await openSealed(key, frame.payload))
      return
    }
    // JSON "missing" answer
    try {
      const res = JSON.parse(dec(await openSealed(key, frame.payload)))
      waiter = res?.reqId && pendingRequests.get(res.reqId)
      if (waiter) {
        pendingRequests.delete(res.reqId)
        clearTimeout(waiter.timer)
        waiter.resolve(null)
      }
    } catch { /* not for us */ }
  }

  /* -- the Trystero-shaped surface --------------------------------------- *
   *
   * CALL MEDIA IS NOT HERE ANY MORE. This module used to build an
   * RTCPeerConnection per peer, relay offers/answers/candidates as an `rtc`
   * action, and expose addStream / removeStream / replaceTrack / onPeerStream
   * so a call could push tracks peer-to-peer. All of it is deleted: calls run
   * on the LiveKit SFU (ADR-004) and no longer touch this transport.
   *
   * What remains is messaging — actions, history replay, attachment slices and
   * lazy fetch. The `call` action still passes through as an ordinary sealed
   * action, because RINGING is a message ("I want to talk to you"), not media.
   */

  const room = {
    DURABLE: true,

    makeAction (name, opts) {
      const a = actionRecord(name)
      if (opts?.kind === 'request') {
        a.onRequest = opts.onRequest
        return {
          set onMessage (fn) { a.onMessage = fn },
          request: (data, reqOpts) => requestBytes(data, reqOpts)
        }
      }
      return {
        send: (data, sendOpts = {}) => sendAction(name, data, sendOpts, sendOpts?.metadata?.id),
        set onMessage (fn) { a.onMessage = fn },
        set onReceiveProgress (fn) { a.onReceiveProgress = fn }
      }
    },

    set onPeerJoin (fn) { onPeerJoinHandler = fn },
    set onPeerLeave (fn) { onPeerLeaveHandler = fn },
    set onUndecryptable (fn) { onUndecryptableHandler = fn },

    getPeers () { return Object.fromEntries(peers) },

    leave () {
      left = true
      activeRooms.delete(roomId)
      for (const { timer, reject } of pendingRequests.values()) {
        clearTimeout(timer)
        reject(new Error('room left'))
      }
      pendingRequests.clear()
      socketPromise?.then((s) => s.emit('leave', { roomId })).catch(() => {})
    },

    // internals used by the shared socket dispatcher
    onFrame: (frame) => { enqueueFrame(frame) },
    onPeer: (frame) => {
      if (frame.peerId === selfId) return
      if (frame.action === 'join') addPeer(frame.peerId, true)
      else removePeer(frame.peerId)
    },
    rejoin
  }

  activeRooms.set(roomId, room)
  join()
  return room
}

/* ------------------------------------------------------------- exports -- */

export function joinRoom (config, roomId) {
  if (!serverMode) return torrent.joinRoom(config, roomId)
  const existing = activeRooms.get(roomId)
  if (existing) return existing
  return serverRoom(config, roomId)
}
