/**
 * Spot Me — which transport this device uses. ADR-002 §1.
 *
 * The flag is `localStorage['spotme.transport']`, which ALREADY EXISTS: it is
 * how a device reverts to the old Trystero P2P stack. Extending it beats
 * inventing a second mechanism — two switches for one decision is how a device
 * ends up in a state neither switch describes.
 *
 *   socketio   (default) the NestJS Socket.IO gateway
 *   centrifugo           opt-in, requires VITE_CENTRIFUGO_URL and the broker
 *   p2p                  legacy Trystero, handled in socket-transport.js
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

export const TRANSPORT_KEYS = Object.freeze(['socketio', 'centrifugo', 'p2p'])
const STORAGE_KEY = 'spotme.transport'
const DEFAULT = 'socketio'

/** What this device is configured to use. Unknown values fall back to default. */
export function selectedTransport () {
  let raw = null
  try { raw = localStorage.getItem(STORAGE_KEY) } catch { /* private mode */ }
  return TRANSPORT_KEYS.includes(raw) ? raw : DEFAULT
}

/** Switch transports. Takes effect on the next connect, not retroactively. */
export function setTransport (key) {
  if (!TRANSPORT_KEYS.includes(key)) throw new Error(`unknown transport: ${key}`)
  try { localStorage.setItem(STORAGE_KEY, key) } catch { /* private mode */ }
  return key
}

/**
 * Build the adapter for this device.
 *
 * Returns `{ adapter, requested, actual, reason }` rather than a bare adapter
 * so a fallback is visible to the caller instead of being inferred from
 * behaviour. `p2p` returns null — that path is not adapter-shaped and is
 * handled inside socket-transport.js.
 */
export async function createTransport (opts = {}) {
  const requested = opts.transport || selectedTransport()

  if (requested === 'p2p') {
    return { adapter: null, requested, actual: 'p2p', reason: 'p2p is handled inside socket-transport.js' }
  }

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
