/**
 * Spot Me — discovery lobby.
 *
 * One app-wide Trystero room every open client joins, carrying presence
 * announcements only — who is nearby, with COARSE position. Chat requests no
 * longer travel here: see reach.js, which addresses a request directly to one
 * person's own inbox room instead of broadcasting it through this shared one.
 *
 * LOCATION HONESTY: positions are rounded to ~110 m and offset with a stable
 * per-person jitter before they ever leave the device. Distance readouts are
 * therefore approximate by construction — the UI shows "~24 m", never an exact
 * figure, and ghost mode (settings.showOnMap=false) withholds position while
 * still allowing chat requests by name.
 */
// Server-backed transport, same as chat and knocks. Discovery gains the most
// from the move: tracker-based peer discovery took ~25s and failed outright
// behind carrier NAT, which is exactly when "nobody is nearby" was a lie.
// Presence stays ephemeral server-side (see the gateway's EPHEMERAL set), and
// one global lobby room is a Phase-1 shape — geo-sharded presence is Phase 2.
import { joinRoom } from './transport/room.js'
import { RTC_CONFIG, readyRTC } from '../net.js'
import { db } from './db.js'
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
  let heartbeat = null
  let position = null              // my coarse {lat, lon} or null
  let lastTick = 0                 // last heartbeat time — a stale value means the tab was suspended

  function notify () { for (const fn of subscribers) fn() }

  function safe (promise) { if (promise?.catch) promise.catch(() => {}) }

  function myAnnouncement () {
    const p = db.profile()
    const show = db.settings().showOnMap
    return {
      id: p.id,
      name: p.name,
      // The username registry hands back the id recorded when the name was
      // CLAIMED, which goes stale on reinstall (or on a second origin, which
      // has its own localStorage and its own registry). Announcing the
      // username lets a sender resolve whoever is live right now and address
      // their CURRENT id, instead of a dead one the receiver silently drops.
      username: p.username || null,
      avatar: p.avatar,
      lang: p.lang,
      ghost: !show,
      /* The "Last seen & online" choice has to TRAVEL before any device can
       * honour it. It never did: the setting was written by the Settings screen
       * and read back only by its own label, so choosing "Nobody" changed
       * nothing at all — every peer went on recording and showing exactly the
       * same last-seen time. A privacy control that does nothing is worse than
       * no control, because it is believed.
       *
       * Cooperative, and the row says so: it asks peers not to record, the way
       * a standard client honours it, and cannot compel one. */
      seen: db.settings().lastSeen || 'everyone',
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
    lastTick = Date.now()
    heartbeat = setInterval(() => {
      announce()
      lastTick = Date.now()
      // Reap the silent — a phone that locked or lost signal.
      const cutoff = Date.now() - STALE_MS
      let dropped = false
      for (const [id, p] of peers) {
        if (p.ts < cutoff) { peers.delete(id); dropped = true }
      }
      if (dropped) notify()
    }, HEARTBEAT_MS)
  }

  /**
   * Call when the tab regains foreground.
   *
   * A phone that gets locked or backgrounded can have its WebRTC/tracker
   * connections silently killed by the OS — iOS Safari is aggressive about
   * this — while the setInterval heartbeat above also stops firing. start()'s
   * own guard (`if (room) return`) would otherwise hand back that corpse
   * forever, the same bug already fixed for chat rooms in rooms.js.
   *
   * A missed heartbeat is the tell: if ticks stopped landing on schedule, the
   * whole page was very likely suspended, so the underlying connections are
   * assumed dead and the lobby rejoins from scratch. Otherwise this just
   * re-announces immediately rather than waiting for the next scheduled tick.
   */
  function resume () {
    if (!room) { start(); return }
    const missed = lastTick && Date.now() - lastTick > HEARTBEAT_MS * 3
    if (missed) {
      try { room.leave() } catch { /* already gone */ }
      room = null; hello = null
      start()
      return
    }
    announce()
  }

  return {
    start,
    resume,
    announce,
    refreshPosition: acquirePosition,
    /** Live peers, most recently seen first. Excludes blocked. */
    peers: () => Array.from(peers.values())
      .filter((p) => !db.isBlocked(p.id))
      .sort((a, b) => b.ts - a.ts),

    /** Active non-ghost people who aren't already a chat — the "new people
     *  around you right now" feed. */
    strangers () {
      const known = new Set()
      for (const convo of db.convos()) if (convo.peer?.id) known.add(convo.peer.id)
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
