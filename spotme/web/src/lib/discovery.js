/**
 * Spot Me — discovery lobby.
 *
 * One app-wide Trystero room every open client joins. It carries three things:
 * presence announcements (who is nearby, with COARSE position), chat requests,
 * and accept notifications. Actual conversations never travel here — each chat
 * is its own encrypted room whose secret is exchanged inside the request.
 *
 * LOCATION HONESTY: positions are rounded to ~110 m and offset with a stable
 * per-person jitter before they ever leave the device. Distance readouts are
 * therefore approximate by construction — the UI shows "~24 m", never an exact
 * figure, and ghost mode (settings.showOnMap=false) withholds position while
 * still allowing chat requests by name.
 */
import { joinRoom } from '@trystero-p2p/torrent'
import { RTC_CONFIG, readyRTC } from '../net.js'
import { db, randomHex } from './db.js'
import { rooms } from './rooms.js'
import { pushNote } from './notify.js'

const APP_ID = 'io.ysnapai.spotme'
const LOBBY_ID = 'spotme-lobby-v1'
const LOBBY_PASS = 'spotme-public-lobby'   // public by design: the lobby is discoverable
const HEARTBEAT_MS = 25_000
const STALE_MS = 90_000

function createLobby () {
  const peers = new Map()          // appId -> {id,name,avatar,lang,lat,lon,ghost,ts,peerId}
  const subscribers = new Set()
  let room = null
  let hello = null
  let req = null
  let acc = null
  let rej = null
  let heartbeat = null
  let position = null              // my coarse {lat, lon} or null

  function notify () { for (const fn of subscribers) fn() }

  function safe (promise) { if (promise?.catch) promise.catch(() => {}) }

  function myAnnouncement () {
    const p = db.profile()
    const show = db.settings().showOnMap
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      lang: p.lang,
      ghost: !show,
      lat: show && position ? position.lat : null,
      lon: show && position ? position.lon : null,
      ts: Date.now()
    }
  }

  let watchId = null
  let relayReady = false

  /**
   * PRECISE positions (owner decision 2026-07-25): the 5–500 m radar needs
   * real GPS, so coords go out exactly as the device reports them, refreshed
   * continuously. Ghost mode (settings.showOnMap=false) remains the privacy
   * switch — it withholds position entirely.
   */
  function acquirePosition () {
    if (!('geolocation' in navigator)) return
    const apply = (fix) => {
      const next = { lat: fix.coords.latitude, lon: fix.coords.longitude }
      const moved = !position || distanceM(position, next) > 3
      position = next
      if (moved) {
        announce()
        notify()
      }
    }
    navigator.geolocation.getCurrentPosition(apply, () => { /* denied */ }, {
      enableHighAccuracy: true, maximumAge: 0, timeout: 12_000
    })
    if (watchId === null && navigator.geolocation.watchPosition) {
      watchId = navigator.geolocation.watchPosition(apply, () => { /* denied */ }, {
        enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000
      })
    }
  }

  function announce () {
    if (hello) safe(hello.send(myAnnouncement()))
  }

  function start () {
    if (room || !db.ready()) return
    // Relay credentials first: joining with STUN-only would strand anyone on
    // mobile data, and Trystero reads the config once at join time.
    if (!relayReady) {
      readyRTC().then(() => { relayReady = true; start() })
      return
    }
    // Same relay config as chat rooms: without TURN, phones on mobile
    // data never discover each other and everyone looks offline.
    room = joinRoom({ appId: APP_ID, password: LOBBY_PASS, rtcConfig: RTC_CONFIG }, LOBBY_ID)

    hello = room.makeAction('hello')
    req = room.makeAction('req')
    acc = room.makeAction('acc')
    rej = room.makeAction('rej')

    hello.onMessage = (payload, meta) => {
      if (!payload?.id || payload.id === db.profile().id) return
      if (db.isBlocked(payload.id)) return
      const existing = peers.get(payload.id)
      const isNew = !existing
      // firstSeen survives re-announcements: the bell badge counts a person
      // as "new" only once, from the moment they first appeared this session.
      peers.set(payload.id, {
        ...payload,
        peerId: meta?.peerId,
        ts: Date.now(),
        firstSeen: existing?.firstSeen || Date.now()
      })
      if (isNew && !payload.ghost) {
        pushNote(`${payload.name || 'Someone'} is nearby`, 'Active on Spot Me right now', `near:${payload.id}`)
      }
      notify()
    }

    req.onMessage = (payload) => {
      if (!payload?.from?.id || !payload.roomId || !payload.secret) return
      /* Addressed requests let us broadcast safely — but the address may be
       * STALE. A username lookup returns the id recorded when that name was
       * claimed, and someone who reinstalled now has a different id. Matching
       * the username as well means a re-registered friend still receives the
       * request instead of it vanishing silently. */
      const me = db.profile()
      const addressed = Boolean(payload.to || payload.toUsername)
      const forMe = (payload.to && payload.to === me.id) ||
        (payload.toUsername && me.username && payload.toUsername === me.username)
      if (addressed && !forMe) return
      const added = db.addRequest({
        fromId: payload.from.id,
        name: payload.from.name || 'Unknown',
        avatar: payload.from.avatar || null,
        lang: payload.from.lang || 'en',
        text: String(payload.text || '').slice(0, 300),
        roomId: payload.roomId,
        secret: payload.secret,
        mode: payload.mode || 'meet'
      })
      if (added) {
        pushNote(`${payload.from.name || 'Someone'} sent a chat request`,
          String(payload.text || 'wants to chat').slice(0, 120), `req:${payload.from.id}`)
        notify()
      }
    }

    acc.onMessage = (payload) => {
      if (!payload?.roomId) return
      const convo = db.convo(payload.roomId)
      if (convo?.pending) {
        db.upsertConvo({ roomId: payload.roomId, pending: false })
        db.addContact(convo.peer)
      }
      notify()
    }

    // Rejection means the profile disappears on the requester's side too —
    // conversation, history, everything. Best-effort (they must be online to
    // hear it); a missed signal just leaves the request looking pending.
    rej.onMessage = (payload) => {
      if (!payload?.roomId) return
      const convo = db.convo(payload.roomId)
      if (convo?.pending) {
        rooms.leave(payload.roomId)
        db.removeConvo(payload.roomId)
        notify()
      }
    }

    room.onPeerJoin = (peerId) => {
      // Introduce ourselves to the newcomer only; no full-room rebroadcast.
      safe(hello.send(myAnnouncement(), { target: peerId }))
    }

    room.onPeerLeave = (peerId) => {
      for (const [id, p] of peers) {
        if (p.peerId === peerId) { peers.delete(id); break }
      }
      notify()
    }

    // Debug handle for live inspection; carries no secrets (lobby is public).
    window.__lobby = { room, peers }

    announce()
    acquirePosition()
    heartbeat = setInterval(() => {
      announce()
      // Reap the silent — a phone that locked or lost signal.
      const cutoff = Date.now() - STALE_MS
      let dropped = false
      for (const [id, p] of peers) {
        if (p.ts < cutoff) { peers.delete(id); dropped = true }
      }
      if (dropped) notify()
    }, HEARTBEAT_MS)
  }

  /** Send a request the moment the lobby can carry one, retrying briefly. */
  function deliverRequest (payload, peerId, attempt = 0) {
    if (!req) {
      start()                                    // idempotent; may still be joining
      if (attempt < 20) {                        // ~30s of patience, then give up
        setTimeout(() => deliverRequest(payload, peerId, attempt + 1), 1500)
      }
      return
    }
    const target = peers.get(peerId)?.peerId
    safe(req.send(payload, target ? { target } : undefined))
  }

  /** Send a chat request. Creates the room credentials and a pending convo. */
  function request (peer, text, mode = 'nearby') {
    const roomId = randomHex(8)
    const secret = randomHex(16)
    const p = db.profile()
    const target = peers.get(peer.id)?.peerId
    const payload = {
      to: peer.id,
      toUsername: peer.username || null,
      from: { id: p.id, name: p.name, avatar: p.avatar, lang: p.lang },
      roomId, secret, text: String(text || '').slice(0, 300), mode
    }
    /**
     * Deliver as soon as the lobby can carry it. The conversation is recorded
     * either way, so the request is never silently lost:
     *  - targeted when we know their transport id, broadcast otherwise (peer
     *    maps fill in slowly over public trackers, and a request must not fail
     *    just because ours has not caught up);
     *  - retried while the lobby is still joining. Waiting for relay
     *    credentials means `req` can legitimately not exist yet, and tapping
     *    send in that window used to throw.
     */
    deliverRequest(payload, peer.id)
    db.upsertConvo({
      roomId, secret, kind: 'dm', mode,
      peer: { id: peer.id, name: peer.name, avatar: peer.avatar || null, lang: peer.lang || 'en' },
      title: peer.name, pending: true,
      last: { text: text || 'Request sent', ts: Date.now(), fromMe: true }
    })
    return roomId
  }

  /** Accept an incoming request: request → conversation + contact. */
  function accept (request_) {
    db.upsertConvo({
      roomId: request_.roomId, secret: request_.secret, kind: 'dm', mode: request_.mode,
      peer: { id: request_.fromId, name: request_.name, avatar: request_.avatar, lang: request_.lang },
      title: request_.name, pending: false,
      last: { text: request_.text || 'Request accepted', ts: Date.now(), fromMe: false }
    })
    db.addContact({ id: request_.fromId, name: request_.name, avatar: request_.avatar, lang: request_.lang })
    db.removeRequest(request_.fromId)
    const target = peers.get(request_.fromId)?.peerId
    if (acc) safe(acc.send({ roomId: request_.roomId }, target ? { target } : undefined))
  }

  function decline (request_) {
    db.removeRequest(request_.fromId)
    // Tell the requester so their side removes the conversation entirely.
    const target = peers.get(request_.fromId)?.peerId
    if (rej) safe(rej.send({ roomId: request_.roomId }, target ? { target } : undefined))
  }

  return {
    start,
    announce,
    refreshPosition: acquirePosition,
    request,
    accept,
    decline,
    /** Live peers, most recently seen first. Excludes blocked. */
    peers: () => Array.from(peers.values())
      .filter((p) => !db.isBlocked(p.id))
      .sort((a, b) => b.ts - a.ts),

    /** Active non-ghost people who aren't already a chat or a pending
     *  request — the "new people around you right now" feed. */
    strangers () {
      const known = new Set()
      for (const convo of db.convos()) if (convo.peer?.id) known.add(convo.peer.id)
      for (const request_ of db.requests()) known.add(request_.fromId)
      return Array.from(peers.values())
        .filter((p) => !p.ghost && !db.isBlocked(p.id) && !known.has(p.id))
        .sort((a, b) => b.ts - a.ts)
    },
    myPosition: () => position,
    subscribe (fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    stop () {
      if (heartbeat) clearInterval(heartbeat)
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId)
        watchId = null
      }
      if (room) room.leave()
      room = null
    }
  }
}

/* ------------------------------------------------------------------- geo */

/**
 * Round to ~110 m and add a stable per-identity jitter so repeated fixes do
 * not triangulate a home address. The jitter derives from the id, so it is
 * consistent across sessions — a person appears in one plausible spot, not
 * teleporting between announcements.
 */
export function coarse (lat, lon, seed) {
  let h = 2166136261
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) }
  const jLat = (((h >>> 16) & 1023) / 1023 - 0.5) * 0.0018   // ±~100 m
  const jLon = ((h & 1023) / 1023 - 0.5) * 0.0018
  return {
    lat: Math.round(lat * 1000) / 1000 + jLat,
    lon: Math.round(lon * 1000) / 1000 + jLon
  }
}

/** Haversine distance in metres; null when either side withholds position. */
export function distanceM (a, b) {
  if (a?.lat == null || b?.lat == null || a?.lon == null || b?.lon == null) return null
  const R = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLon = (b.lon - a.lon) * Math.PI / 180
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2
  return Math.round(2 * R * Math.asin(Math.sqrt(s)))
}

/** "~24 m" / "~1.2 km" — the tilde is honest: positions are coarse by design. */
export function fmtDistance (m) {
  if (m == null) return null
  if (m < 1000) return `~${m} m`
  return `~${(m / 1000).toFixed(1)} km`
}

export const lobby = createLobby()
