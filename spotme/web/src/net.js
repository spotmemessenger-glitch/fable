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
  const room = joinRoom({ appId: APP_ID, password: secret }, roomId)

  // Trystero 0.25 API notes, all of which differ from older documentation:
  //   - makeAction returns an OBJECT, not a [send, receive] tuple
  //   - send takes an options object: send(data, {target}), not (data, peerId)
  //   - onMessage / onPeerJoin / onPeerLeave are SETTERS, not methods
  //   - handlers receive (payload, {peerId}), not (payload, peerId)
  const msg = room.makeAction('msg')
  const react = room.makeAction('react')
  const profile = room.makeAction('profile')
  const history = room.makeAction('history')

  msg.onMessage = (payload, meta) => handlers.onMessage(payload, meta?.peerId)
  react.onMessage = (payload, meta) => handlers.onReaction(payload, meta?.peerId)
  profile.onMessage = (payload, meta) => handlers.onProfile(payload, meta?.peerId)

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
