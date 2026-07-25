/**
 * Spot Me web — peer-to-peer transport.
 *
 * WebRTC via Trystero. Browsers cannot open raw UDP sockets, so the Hyperswarm
 * stack used by the native app physically cannot run here; this is a different
 * transport carrying the same product.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT PRIVATE
 *
 * Messages travel directly browser-to-browser over WebRTC data channels, which
 * are DTLS-encrypted, and Trystero additionally encrypts payloads with the room
 * secret. No message passes through a server we or anyone else runs.
 *
 * Peer DISCOVERY is public infrastructure — BitTorrent trackers see that some
 * peer is looking for a room topic. They never see message content, and the
 * room secret lives in the URL fragment, which browsers never transmit to a
 * server. Metadata leaks; content does not.
 *
 * NOT carried over from the native app: offline delivery and 24-word recovery.
 * Both need the append-only Hypercore log. If every peer is offline here, the
 * conversation is simply gone — say so in the UI rather than implying otherwise.
 * ------------------------------------------------------------------------- */
// Trystero 0.25 split each discovery strategy into its own package; the old
// `trystero/torrent` subpath is now a stub that throws a deprecation error.
// Swap this import for @trystero-p2p/nostr or /mqtt if tracker discovery is
// ever unreliable — the API is identical across strategies.
import { joinRoom, selfId } from '@trystero-p2p/torrent'

/** Namespaces our rooms so we never collide with another Trystero app. */
/**
 * WebRTC needs help crossing carrier-grade NAT. Indian mobile networks (Jio,
 * Airtel) share one public address between many subscribers, so two phones on
 * mobile data usually cannot negotiate a direct path — which is why a friend
 * who was plainly online still appeared offline.
 *
 * Relay credentials are MINTED PER SESSION by /api/turn (Cloudflare hands out
 * short-lived ones, so there is nothing durable to embed in this bundle).
 * Until they arrive we hold STUN-only config, which is enough on friendly
 * networks; joinRoom waits for the real thing via readyRTC().
 *
 * MEASURED 2026-07-25: Cloudflare TURN allocates a relay successfully;
 * ExpressTURN's free host answered nothing at all (3/3 timeouts on both its
 * addresses) while their paid host replied instantly from the same machine.
 */
const STUN_ONLY = {
  iceServers: [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
  ]
}

export let RTC_CONFIG = STUN_ONLY
let rtcReady = null

/** Resolves once relay credentials are in hand (or STUN-only on failure). */
export function readyRTC () {
  if (rtcReady) return rtcReady
  rtcReady = fetch(`${API_ORIGIN}/api/turn`)
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (j?.iceServers?.length) RTC_CONFIG = { iceServers: j.iceServers }
      return RTC_CONFIG
    })
    .catch(() => RTC_CONFIG)
  return rtcReady
}

/** True once a real relay (not just STUN) is configured. */
export const hasRelay = () =>
  RTC_CONFIG.iceServers.some((s) =>
    (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => String(u).startsWith('turn')))

const API_ORIGIN = (location.hostname === 'localhost' || /^[0-9.]+$/.test(location.hostname))
  ? 'https://spotme-messenger.vercel.app'
  : ''

const APP_ID = 'io.ysnapai.spotme'

/**
 * How much backlog a peer offers to someone who has just joined.
 *
 * There is no server holding history, so it comes from whoever is online. Too
 * large and a join floods a mobile connection; this is roughly a screen or two
 * of conversation.
 */
const HISTORY_LIMIT = 100

export { selfId }

/**
 * Join a room.
 *
 * @param {string}   roomId     public room identifier
 * @param {string}   secret     room password; encrypts payloads. Comes from the
 *                              URL fragment, so no server ever receives it.
 * @param {object}   handlers   {onMessage, onReaction, onProfile, onHistory,
 *                               onPeers, profile}
 * @param {function} getHistory called when a new peer needs backlog
 */
export function createNet (roomId, secret, handlers, getHistory) {
  const room = joinRoom({ appId: APP_ID, password: secret, rtcConfig: RTC_CONFIG }, roomId)

  // Trystero 0.25 API notes, all of which differ from older documentation:
  //   - makeAction returns an OBJECT, not a [send, receive] tuple
  //   - send takes an options object: send(data, {target}), not (data, peerId)
  //   - onMessage / onPeerJoin / onPeerLeave are SETTERS, not methods
  //   - handlers receive (payload, {peerId}), not (payload, peerId)
  const msg = room.makeAction('msg')
  const react = room.makeAction('react')
  const profile = room.makeAction('profile')
  const history = room.makeAction('history')
  // Attachment bytes travel as BINARY with the envelope in metadata — not as
  // base64 inside JSON. A third smaller on the wire, and both directions get
  // real progress callbacks, which "photo not sending" feedback demands.
  const bin = room.makeAction('bin')
  // Lazy fetch: history backlog carries attachment envelopes without bytes;
  // the receiver requests the bytes on demand from whoever holds them.
  const fetchAction = room.makeAction('fetch', {
    kind: 'request',
    onRequest: (data, context) => handlers.onFetch ? handlers.onFetch(data, context) : null
  })
  // Call signalling: {type:'offer'|'accept'|'decline'|'end', video:bool}.
  // The media itself rides WebRTC tracks via addStream, not this action.
  const call = room.makeAction('call')
  // Live-location updates: {id, lat, lon} while sharing; {id, stop:true} ends.
  const locup = room.makeAction('locup')
  // Cooperative signals. "Cooperative" is doing real work in that word: a
  // modified client can ignore any of these. Honest limits, not guarantees.
  const del = room.makeAction('del')        // delete-without-trace tombstone
  const edit = room.makeAction('edit')      // corrected text for a sent message
  const typing = room.makeAction('typing')  // {on:bool, name}
  const read = room.makeAction('read')      // {upTo:ts} read receipt
  const seen = room.makeAction('seen')      // {id} view-once was opened

  msg.onMessage = (payload, meta) => handlers.onMessage(payload, meta?.peerId)
  react.onMessage = (payload, meta) => handlers.onReaction(payload, meta?.peerId)
  profile.onMessage = (payload, meta) => handlers.onProfile(payload, meta?.peerId)
  del.onMessage = (payload, meta) => handlers.onDelete?.(payload, meta?.peerId)
  edit.onMessage = (payload) => handlers.onEdit?.(payload)
  typing.onMessage = (payload, meta) => handlers.onTyping?.(payload, meta?.peerId)
  read.onMessage = (payload, meta) => handlers.onRead?.(payload, meta?.peerId)
  seen.onMessage = (payload, meta) => handlers.onSeen?.(payload, meta?.peerId)
  bin.onMessage = (payload, context) => handlers.onBinary?.(payload, context)
  bin.onReceiveProgress = (progress, context) => handlers.onBinaryProgress?.(progress, context)
  call.onMessage = (payload, meta) => handlers.onCall?.(payload, meta?.peerId)
  locup.onMessage = (payload, meta) => handlers.onLocup?.(payload, meta?.peerId)

  room.onPeerStream = (stream, peerId, metadata) =>
    handlers.onStream?.(stream, peerId, metadata)

  // Backlog from an existing peer. Merging is the store's job — it may already
  // hold some of these, and several peers may answer the same join.
  history.onMessage = (payload) => {
    if (Array.isArray(payload?.messages)) handlers.onHistory(payload.messages)
  }

  room.onPeerJoin = (peerId) => {
    handlers.onPeers(Object.keys(room.getPeers()).length, peerId, 'join')

    // Introduce ourselves and offer backlog. Targeted at the joiner rather than
    // broadcast, so an established room does not re-send history to everyone
    // each time somebody arrives.
    msgSafe(profile.send(handlers.profile(), { target: peerId }))
    const backlog = getHistory().slice(-HISTORY_LIMIT)
    if (backlog.length > 0) {
      msgSafe(history.send({ messages: backlog }, { target: peerId }))
    }
  }

  room.onPeerLeave = (peerId) => {
    handlers.onPeers(Object.keys(room.getPeers()).length, peerId, 'leave')
  }

  // `send` is async and rejects if the peer vanished mid-flight. A peer leaving
  // during a handshake is normal, not an error worth surfacing to the user.
  function msgSafe (promise) {
    if (promise?.catch) promise.catch(() => {})
  }

  return {
    sendMessage: (data) => msgSafe(msg.send(data)),
    sendReaction: (data) => msgSafe(react.send(data)),
    sendProfile: (data) => msgSafe(profile.send(data)),
    sendDelete: (data) => msgSafe(del.send(data)),
    sendEdit: (data) => msgSafe(edit.send(data)),
    sendTyping: (data) => msgSafe(typing.send(data)),
    sendRead: (data) => msgSafe(read.send(data)),
    sendSeen: (data) => msgSafe(seen.send(data)),
    /** Binary with envelope metadata + progress. Returns the send promise. */
    sendBinary: (buffer, options) => bin.send(buffer, options),
    /** Ask a specific peer for attachment bytes: ({id}, {target}) -> bytes. */
    fetchFrom: (data, options) => fetchAction.request(data, options),
    sendCall: (data, options) => msgSafe(call.send(data, options)),
    sendLocup: (data) => msgSafe(locup.send(data)),
    addStream: (stream, options) => room.addStream(stream, options),
    removeStream: (stream, options) => room.removeStream(stream, options),
    replaceTrack: (oldTrack, newTrack, options) => room.replaceTrack(oldTrack, newTrack, options),
    peerIds: () => Object.keys(room.getPeers()),
    peerCount: () => Object.keys(room.getPeers()).length,
    leave: () => room.leave()
  }
}

/**
 * Build a shareable link.
 *
 * Both the room id and the secret live in the URL FRAGMENT. Fragments are never
 * sent in an HTTP request, so the host serving this app — Vercel or anyone else
 * — never sees either. Putting the secret in the query string instead would
 * hand it to the logs of every hop.
 */
export function roomLink (roomId, secret) {
  const base = window.location.origin + window.location.pathname
  return `${base}#r=${encodeURIComponent(roomId)}&k=${encodeURIComponent(secret)}`
}

/** Read a room out of the current URL, if there is one. */
export function readLink () {
  const hash = window.location.hash.replace(/^#/, '')
  if (!hash) return null
  const params = new URLSearchParams(hash)
  const roomId = params.get('r')
  const secret = params.get('k')
  return roomId && secret ? { roomId, secret } : null
}

/** Cryptographically random id. Math.random is not acceptable for a secret. */
export function randomId (bytes = 16) {
  const buffer = new Uint8Array(bytes)
  crypto.getRandomValues(buffer)
  return Array.from(buffer, (b) => b.toString(16).padStart(2, '0')).join('')
}
