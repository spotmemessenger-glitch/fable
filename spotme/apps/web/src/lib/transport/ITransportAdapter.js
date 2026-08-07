/**
 * Spot Me — the transport contract. See ADR-002.
 *
 * JavaScript has no interfaces, so this file is the contract made checkable:
 * a list of required methods, a list of members that must NOT exist, and an
 * assertion that runs in tests rather than a comment nobody executes.
 *
 * THE NARROWNESS IS THE DESIGN. Seven methods, no more. A wider contract would
 * leak Socket.IO's semantics into it and the second implementation would end up
 * a Socket.IO emulator rather than a peer — at which point the abstraction has
 * bought nothing and cost a layer.
 */

/** Every adapter must implement exactly these. */
export const TRANSPORT_METHODS = Object.freeze([
  'connect',      // (opts) -> Promise<void>       establish the session
  'disconnect',   // () -> Promise<void>           tear down, release resources
  'subscribe',    // (roomId, handlers) -> Promise<sub>
  'unsubscribe',  // (roomId) -> Promise<void>
  'publish',      // (roomId, frame) -> Promise<{seq?}>   opaque bytes only
  'presence',     // (roomId) -> Promise<Array<{userId}>>
  'status'        // () -> TransportStatus
])

/**
 * Members an adapter must NOT have — enforced by test/transport.test.js.
 *
 * WHY THIS LIST EXISTS. ADR-001 stopped V-19 by making `roomKey()` consult a
 * provider with NO password fallback for e2e_v2 rooms. That defence lives in
 * socket-transport.js. A transport rewrite is the most likely way to undo it:
 * an adapter that grows its own `deriveKey`/`roomKey`/`password` handling would
 * silently restore the cyrb53 key, both peers would degrade identically, and
 * nothing would surface. So the prohibition is a test, not a paragraph.
 *
 * Adapters move OPAQUE BYTES. Sealing and opening happen above them.
 */
export const FORBIDDEN_KEY_SURFACE = Object.freeze([
  'roomKey', 'deriveKey', 'setRoomKey', 'setRoomKeyProvider', 'clearRoomKey',
  'password', 'secret', 'key', 'keyCache', 'encrypt', 'decrypt', 'seal', 'open'
])

/** Connection lifecycle, normalised across adapters. */
export const TransportStatus = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  CLOSED: 'closed',
  FAILED: 'failed'
})

/** The event names an adapter normalises onto, whatever the wire calls them. */
export const TransportEvents = Object.freeze({
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',
  PRESENCE: 'presence',
  ROOM_EVENT: 'room_event'
})

/**
 * Throw unless `adapter` satisfies the contract.
 *
 * Returns nothing and throws on the first violation, deliberately: a partially
 * conforming transport is worse than an absent one, because it fails later and
 * further from the cause.
 */
export function assertImplementsTransport (adapter, label = 'adapter') {
  if (!adapter || typeof adapter !== 'object') {
    throw new Error(`${label}: not an object`)
  }
  for (const m of TRANSPORT_METHODS) {
    if (typeof adapter[m] !== 'function') {
      throw new Error(`${label}: missing required method ${m}()`)
    }
  }
  for (const banned of FORBIDDEN_KEY_SURFACE) {
    if (banned in adapter) {
      throw new Error(
        `${label}: exposes "${banned}" — transports carry opaque bytes and must ` +
        'never touch key material (ADR-002 §2, ADR-001)'
      )
    }
  }
  const s = adapter.status()
  if (!Object.values(TransportStatus).includes(s)) {
    throw new Error(`${label}: status() returned "${s}", not a TransportStatus`)
  }
}

/**
 * A frame as it crosses any adapter.
 *
 * `payload` is base64 TEXT, never a Buffer — socket.io frames each Buffer
 * separately after the JSON packet, and when anything interleaves the decoder
 * reads text where it expects binary and drops the socket with `parse error`.
 * That cost a day once; the shape is pinned here so a new transport inherits
 * the lesson instead of rediscovering it.
 *
 * `meta` is CLEARTEXT routing only — attachment id/seq/total, never content.
 */
export function makeFrame ({ roomId, type, payload = '', meta = undefined, target = undefined }) {
  if (!roomId || typeof roomId !== 'string') throw new Error('frame: roomId required')
  if (!type || typeof type !== 'string') throw new Error('frame: type required')
  if (typeof payload !== 'string') throw new Error('frame: payload must be base64 text, not binary')
  return { roomId, type, payload, meta, target }
}
