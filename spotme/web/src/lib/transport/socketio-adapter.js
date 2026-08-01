/**
 * Spot Me — the Socket.IO adapter. The reference implementation of ADR-002.
 *
 * It WRAPS `socket-transport.js` rather than replacing or refactoring it. That
 * module is the live message path for every user today, it carries the
 * base64-not-Buffer framing fix and the ADR-001 key-provider defence, and a
 * "while I'm here" rewrite of it would put both at risk for no gain. The
 * adapter's whole job is to present that behaviour through the narrow contract
 * so a second transport has something to be a peer of.
 *
 * NOTE ON THE KEY BOUNDARY (ADR-002 §2): this file deliberately does NOT
 * re-export `setRoomKey` / `setRoomKeyProvider`, even though the module it
 * wraps has them and re-exporting would be one line. Keys enter the system
 * through `rooms.js` calling socket-transport directly. An adapter that could
 * be handed a key is an adapter that will eventually derive one.
 */
import { joinRoom, freshTokens, serverMode } from '../socket-transport.js'
import { TransportStatus, TransportEvents } from './ITransportAdapter.js'

export function createSocketIOAdapter ({ appId = 'io.ysnapai.spotme', rtcConfig } = {}) {
  /** roomId -> the object joinRoom() returned. */
  const rooms = new Map()
  let state = TransportStatus.IDLE

  /**
   * Socket.IO has no explicit connect step here — `joinRoom` establishes the
   * shared socket lazily on first use, and `freshTokens()` is what actually
   * proves we can reach the server. So connect() verifies reachability rather
   * than pretending to open something.
   */
  async function connect () {
    state = TransportStatus.CONNECTING
    try {
      const { accessToken } = (await freshTokens()) || {}
      if (!accessToken) { state = TransportStatus.FAILED; throw new Error('no access token') }
      state = TransportStatus.CONNECTED
    } catch (err) {
      state = TransportStatus.FAILED
      throw err
    }
  }

  async function disconnect () {
    for (const [roomId, room] of rooms) {
      try { room.leave() } catch { /* already gone */ }
      rooms.delete(roomId)
    }
    state = TransportStatus.CLOSED
  }

  /**
   * `password` is the room secret the CALLER already holds. It is handed
   * straight to joinRoom and never inspected, cached or logged here — for an
   * e2e_v2 room the provider registered in rooms.js wins and this value is
   * never used at all (ADR-001).
   */
  async function subscribe (roomId, { password, onRoomEvent, onPresence } = {}) {
    if (rooms.has(roomId)) return rooms.get(roomId)
    const room = joinRoom({ appId, password, rtcConfig }, roomId)

    if (typeof onRoomEvent === 'function') {
      const action = room.makeAction('action')
      action.onMessage = (frame, meta) => onRoomEvent(TransportEvents.ROOM_EVENT, frame, meta)
    }
    if (typeof onPresence === 'function') {
      room.onPeerJoin = (peerId) => onPresence(TransportEvents.PRESENCE, { userId: peerId, action: 'join' })
      room.onPeerLeave = (peerId) => onPresence(TransportEvents.PRESENCE, { userId: peerId, action: 'leave' })
    }

    rooms.set(roomId, room)
    if (state !== TransportStatus.CONNECTED) state = TransportStatus.CONNECTED
    return room
  }

  async function unsubscribe (roomId) {
    const room = rooms.get(roomId)
    if (!room) return
    try { room.leave() } catch { /* already gone */ }
    rooms.delete(roomId)
  }

  async function publish (roomId, frame) {
    const room = rooms.get(roomId)
    if (!room) throw new Error(`publish: not subscribed to ${roomId}`)
    const action = room.makeAction(frame.type || 'action')
    return action.send(frame.payload, frame.target ? { target: frame.target } : undefined)
  }

  async function presence (roomId) {
    const room = rooms.get(roomId)
    if (!room?.getPeers) return []
    return Object.keys(room.getPeers() || {}).map((userId) => ({ userId }))
  }

  const status = () => state

  return {
    name: 'socketio',
    /** True when this build is actually server-backed rather than P2P. */
    serverMode,
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    publish,
    presence,
    status
  }
}
