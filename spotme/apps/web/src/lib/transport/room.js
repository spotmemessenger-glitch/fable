/**
 * Spot Me — the one place the app asks for a room. ADR-002 §1.
 *
 * Every screen used to `import { joinRoom } from './socket-transport.js'`, so
 * the transport was decided four times in four files by virtue of what each
 * imported. Now they ask here, this module reads
 * `localStorage['spotme.transport']` once, and there is a single place to
 * change when a second transport can actually carry a room.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS DOES NOT HAND THE CHAT PATH TO AN ADAPTER — read before "finishing"
 * the wiring, because the reason is not stylistic.
 *
 * 1. THE SEAL BOUNDARY IS BELOW THE ADAPTER, NOT ABOVE IT. ADR-002 §2 says
 *    adapters carry opaque bytes and that sealing happens above them. In the
 *    code it does not: AES-GCM seal/open live INSIDE socket-transport.js
 *    (`sendAction`, `dispatch`), which SocketIOAdapter wraps — so for Socket.IO
 *    the crypto sits *under* the adapter and everything is fine, while
 *    CentrifugoAdapter has no seal step at all. Its `publish()` POSTs
 *    `frame.payload` straight through. Routing chat frames through
 *    `createTransport()` and selecting centrifugo would therefore send
 *    PLAINTEXT to the server — the V-19 failure again, arriving through a door
 *    FORBIDDEN_KEY_SURFACE does not watch, because that test checks that an
 *    adapter has no key members and cannot see a keyless adapter wired into the
 *    message path. Moving seal/open above the transport is Phase 3 and is a
 *    real refactor of the message layer, not a wiring change.
 *
 * 2. THE CHAT SURFACE IS WIDER THAN THE CONTRACT, ON PURPOSE. `createNet` needs
 *    per-type action channels, binary sends with progress, request/response
 *    lazy fetch, and live WebRTC stream management. ITransportAdapter has seven
 *    methods and `publish()` drops `frame.meta` — which is the attachment
 *    envelope, so media would break. Widening the contract until createNet fits
 *    is exactly the "second implementation becomes a Socket.IO emulator"
 *    outcome ADR-002 names as the failure mode.
 *
 * So: transport SELECTION runs through this seam today; transport
 * IMPLEMENTATION for chat is still Socket.IO, and asking for Centrifugo gets a
 * loud fallback rather than a silent downgrade. Anything else would be a claim
 * the code cannot back.
 */
/* select.js, NOT index.js — importing index.js here would pull
 * centrifugo-adapter.js into every user's bundle, and its `import('centrifuge')`
 * cannot resolve because that package is deliberately not installed. The
 * production build fails outright: `Rolldown failed to resolve import
 * "centrifuge"`. Same selector, one definition, no undeployed SDK in the graph. */
import { joinRoom as joinSocketIoRoom } from '../socket-transport.js'
import { selectedTransport } from './select.js'

/** What the last room join actually used, and why it may differ from the ask. */
let report = { requested: null, actual: null, reason: null }

/** One warning per requested-but-unavailable transport, not one per room. */
const warned = new Set()

/**
 * Join a room through the selected transport.
 *
 * Signature matches socket-transport's `joinRoom(config, roomId)` so call sites
 * change an import and nothing else. `config.password` is the caller's room
 * secret; it is passed straight down and never inspected here — for an e2e_v2
 * room the provider registered in rooms.js wins and the password is unused
 * (ADR-001).
 */
export function joinRoom (config, roomId) {
  const requested = selectedTransport()
  let actual = requested
  let reason = null

  if (requested === 'centrifugo') {
    // Falling back is right — a transport that cannot seal must not carry a
    // message — but saying WHY is what stops someone believing they tested it.
    actual = 'socketio'
    reason =
      'centrifugo cannot carry chat rooms yet: seal/open live inside ' +
      'socket-transport.js, below the adapter, so publishing through it would ' +
      'send plaintext (see transport/room.js). Fell back to socket.io.'
    if (!warned.has(requested)) {
      warned.add(requested)
      console.warn(`spotme transport: ${reason}`)
    }
  }

  report = { requested, actual, reason }

  return joinSocketIoRoom(config, roomId)
}

/** What the last join resolved to. `reason` is non-null when it was a fallback. */
export function activeTransport () {
  return { ...report }
}

export { selfId } from '../socket-transport.js'
