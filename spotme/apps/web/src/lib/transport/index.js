/**
 * Spot Me — which transport this device uses. ADR-002 §1, superseded by ADR-033.
 *
 * The flag is `localStorage['spotme.transport']`.
 *
 *   socketio   (default) the NestJS Socket.IO gateway
 *   centrifugo           opt-in, requires VITE_CENTRIFUGO_URL and the broker
 *
 * ADR-033 (2026-08-06): the `p2p` (Trystero) option has been removed. Spot Me
 * is server-side transport only — no P2P fallback for calls or messaging.
 *
 * FALLBACK IS DELIBERATE AND VISIBLE. Centrifugo is not deployed yet and the
 * `centrifuge` package may not be installed. Asking for it and silently getting
 * Socket.IO would be the worst outcome — you would think you were testing
 * Centrifugo. So `createTransport()` returns which adapter you actually got and
 * why, and the caller decides whether that is acceptable.
 */
import { createSocketIOAdapter } from './socketio-adapter.js'
import { createCentrifugoAdapter } from './centrifugo-adapter.js'
import { assertImplementsTransport } from './ITransportAdapter.js'
import { selectedTransport } from './select.js'

/* The selector lives in select.js so `transport/room.js` — which every screen
 * goes through — can read the flag WITHOUT importing this file, and therefore
 * without dragging the Centrifugo adapter into the app bundle. Re-exported
 * here so existing importers are unaffected. */
export { TRANSPORT_KEYS, selectedTransport, setTransport } from './select.js'

/**
 * Build the adapter for this device.
 *
 * Returns `{ adapter, requested, actual, reason }` rather than a bare adapter
 * so a fallback is visible to the caller instead of being inferred from
 * behaviour.
 */
export async function createTransport (opts = {}) {
  const requested = opts.transport || selectedTransport()

  if (requested === 'centrifugo') {
    const adapter = createCentrifugoAdapter(opts)
    assertImplementsTransport(adapter, 'CentrifugoAdapter')
    try {
      await adapter.connect()
      return { adapter, requested, actual: 'centrifugo', reason: null }
    } catch (err) {
      // Falling back is right — a dead broker must not mean a dead app — but
      // saying WHY is what stops someone believing they tested Centrifugo.
      const fallback = createSocketIOAdapter(opts)
      assertImplementsTransport(fallback, 'SocketIOAdapter')
      return {
        adapter: fallback,
        requested,
        actual: 'socketio',
        reason: `centrifugo unavailable (${err.message}) — fell back to socket.io`
      }
    }
  }

  const adapter = createSocketIOAdapter(opts)
  assertImplementsTransport(adapter, 'SocketIOAdapter')
  return { adapter, requested, actual: 'socketio', reason: null }
}

export {
  assertImplementsTransport,
  TRANSPORT_METHODS,
  FORBIDDEN_KEY_SURFACE,
  TransportStatus,
  TransportEvents,
  makeFrame
} from './ITransportAdapter.js'
