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
 * Calls stay genuinely peer-to-peer: media rides RTCPeerConnections built
 * here (perfect negotiation, signalling relayed as an ephemeral action);
 * call audio/video never touches the server.
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

/** Forget a room entirely — used when a room is downgraded or wiped. */
export function clearRoomKey (roomId) {
  const cacheKey = `${roomId}`
  keyProviders.delete(cacheKey)
  keyCache.delete(cacheKey)
}

function roomKey (roomId, password) {
  const cacheKey = `${roomId}`
  if (!keyCache.has(cacheKey)) {
    const provider = keyProviders.get(cacheKey)
    if (provider) {
      // NO password fallback on this branch, by design. A rejected provider
      // also evicts itself so a later attempt (peer publishes a key, network
      // returns) can succeed instead of the room being wedged forever.
      keyCache.set(cacheKey, Promise.resolve()
        .then(() => provider())
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
    appVersion: APP_VERSION
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
    socket.on('connect', () => {
      // First connect resolves the promise; later connects are reconnects —
      // every active room rejoins from its cursor and diffs its peer set.
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
  socketPromise.catch(() => { socketPromise = null })  // allow retry after failure
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
  const rtcConfig = config?.rtcConfig || {}
  const actions = new Map()      // name -> action record
  const peerPcs = new Map()      // peerId -> { pc, makingOffer, polite } (calls only)
  const peers = new Map()        // peerId -> fake pc for getPeers()
  const pendingRequests = new Map() // reqId -> {resolve, reject, timer}
  let onPeerJoinHandler = null
  let onPeerLeaveHandler = null
  let onPeerStreamHandler = null
  const localStreams = new Set()
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

  const keyPromise = roomKey(roomId, password)

  function actionRecord (name) {
    if (!actions.has(name)) {
      actions.set(name, {
        onMessage: null, onReceiveProgress: null, onRequest: null
      })
    }
    return actions.get(name)
  }

  /* -- incoming ---------------------------------------------------------- */

  async function dispatch (frame, isReplay) {
    if (left || !frame || frame.from === selfId) return
    const key = await keyPromise
    const { type, from } = frame
    try {
      if (type === 'fetchreq') return void handleFetchReq(frame, key)
      if (type === 'fetchres') return void handleFetchRes(frame, key)
      if (type === 'rtc') {
        const signal = JSON.parse(dec(await openSealed(key, frame.payload)))
        if (signal.to === selfId) await handleRtcSignal(from, signal)
        return
      }
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
      // A frame we cannot decrypt or parse must never kill the dispatch loop —
      // it is one lost event, not a dead room.
      if (!isReplay) console.warn(`spotme transport: dropped ${type} frame:`, error?.message)
    } finally {
      if (frame.seq && frame.seq > readCursor()) writeCursor(frame.seq)
    }
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

  let joinPromise = null

  function join () {
    if (joinPromise) return joinPromise
    joinPromise = (async () => {
      const socket = await ensureSocket()
      const ack = await emitAck(socket, 'join', { roomId, since: readCursor() })
      const key = await keyPromise
      for (const peerId of ack.peers || []) addPeer(peerId, true)
      for (const ev of ack.events || []) await dispatch(ev, true)
      // Attachments that arrived while this device was away come back as
      // detached history entries — bubble appears, bytes fetch on demand.
      if (ack.envelopes?.length) {
        const messages = []
        for (const env of ack.envelopes) {
          const metadata = await unwrapMeta(key, env.meta)
          if (!metadata?.id) continue
          const { seq, total, ...envelope } = metadata
          messages.push({ ...envelope, data: null, detached: true })
        }
        if (messages.length) {
          const h = actions.get('history')
          h?.onMessage?.({ messages }, { peerId: 'server' })
        }
      }
      if (ack.lastEventId > readCursor()) writeCursor(ack.lastEventId)
      return socket
    })()
    joinPromise.catch(() => {
      // A failed boot (backend briefly down, auth race during onboarding)
      // must not leave the room permanently dead — retry until it lands.
      joinPromise = null
      if (!left) setTimeout(() => join(), 2000)
    })
    return joinPromise
  }

  async function rejoin () {
    if (left) return
    try {
      const socket = await socketPromise
      const ack = await emitAck(socket, 'join', { roomId, since: readCursor() })
      const alive = new Set(ack.peers || [])
      for (const peerId of [...peers.keys()]) if (!alive.has(peerId)) removePeer(peerId)
      for (const peerId of alive) addPeer(peerId, true)
      for (const ev of ack.events || []) await dispatch(ev, true)
      if (ack.lastEventId > readCursor()) writeCursor(ack.lastEventId)
    } catch { /* reconnect loop will fire again */ }
  }

  /* -- outgoing ---------------------------------------------------------- */

  async function sendAction (type, data, sendOpts = {}, attachId) {
    if (left) return
    const socket = await join()
    const key = await keyPromise
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
    const key = await keyPromise
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

  /* -- calls: real WebRTC between peers, signalling via the socket -------- */

  async function sendRtc (to, signal) {
    try { await sendAction('rtc', { to, from: selfId, ...signal }) } catch { /* peer gone */ }
  }

  function ensurePc (peerId) {
    let entry = peerPcs.get(peerId)
    if (entry) return entry
    const pc = new RTCPeerConnection(rtcConfig)
    entry = { pc, makingOffer: false, polite: String(selfId) < String(peerId) }
    peerPcs.set(peerId, entry)
    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true
        await pc.setLocalDescription()
        await sendRtc(peerId, { description: pc.localDescription })
      } finally { entry.makingOffer = false }
    }
    pc.onicecandidate = ({ candidate }) => { if (candidate) sendRtc(peerId, { candidate }) }
    pc.ontrack = ({ streams }) => {
      if (streams?.[0]) onPeerStreamHandler?.(streams[0], peerId, undefined)
    }
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState)) closePc(peerId)
    }
    return entry
  }

  async function handleRtcSignal (from, signal) {
    const entry = ensurePc(from)
    const { pc } = entry
    try {
      if (signal.description) {
        const collision = signal.description.type === 'offer' &&
          (entry.makingOffer || pc.signalingState !== 'stable')
        if (collision && !entry.polite) return
        if (collision) await pc.setLocalDescription({ type: 'rollback' }).catch(() => {})
        await pc.setRemoteDescription(signal.description)
        if (signal.description.type === 'offer') {
          for (const stream of localStreams) {
            for (const track of stream.getTracks()) {
              if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream)
            }
          }
          await pc.setLocalDescription()
          await sendRtc(from, { description: pc.localDescription })
        }
      } else if (signal.candidate) {
        await pc.addIceCandidate(signal.candidate).catch(() => {})
      }
    } catch (error) {
      console.warn('spotme transport: rtc negotiation error:', error?.message)
    }
  }

  function closePc (peerId) {
    const entry = peerPcs.get(peerId)
    if (!entry) return
    peerPcs.delete(peerId)
    try { entry.pc.close() } catch { /* already closed */ }
  }

  /* -- the Trystero-shaped surface --------------------------------------- */

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
    set onPeerStream (fn) { onPeerStreamHandler = fn },

    getPeers () { return Object.fromEntries(peers) },

    addStream (stream, options) {
      localStreams.add(stream)
      const targets = options?.target ? [options.target] : [...peers.keys()]
      for (const peerId of targets) {
        const { pc } = ensurePc(peerId)
        for (const track of stream.getTracks()) {
          if (!pc.getSenders().some((s) => s.track === track)) pc.addTrack(track, stream)
        }
      }
    },

    removeStream (stream) {
      localStreams.delete(stream)
      for (const { pc } of peerPcs.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track && stream.getTracks().includes(sender.track)) {
            try { pc.removeTrack(sender) } catch { /* renegotiating */ }
          }
        }
      }
    },

    replaceTrack (oldTrack, newTrack) {
      for (const { pc } of peerPcs.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track === oldTrack) sender.replaceTrack(newTrack).catch(() => {})
        }
      }
    },

    leave () {
      left = true
      activeRooms.delete(roomId)
      for (const peerId of [...peerPcs.keys()]) closePc(peerId)
      for (const { timer, reject } of pendingRequests.values()) {
        clearTimeout(timer)
        reject(new Error('room left'))
      }
      pendingRequests.clear()
      socketPromise?.then((s) => s.emit('leave', { roomId })).catch(() => {})
    },

    // internals used by the shared socket dispatcher
    onFrame: (frame) => { dispatch(frame, false) },
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
