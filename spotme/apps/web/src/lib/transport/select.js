/**
 * Which transport this device is set to. ADR-002 §1, superseded by ADR-033.
 *
 * The flag is `localStorage['spotme.transport']`.
 *
 *   socketio   (default) the NestJS Socket.IO gateway
 *   centrifugo           opt-in, requires VITE_CENTRIFUGO_URL and the broker
 *
 * ADR-033 (2026-08-06): the `p2p` (Trystero) option has been removed — Spot Me
 * is server-side transport only, with no P2P fallback.
 *
 * WHY THIS IS ITS OWN FILE AND NOT PART OF index.js. `transport/room.js` — the
 * seam every screen goes through — needs the selection and nothing else.
 * Importing index.js to get it pulled centrifugo-adapter.js into the app's
 * module graph, and that file's `import('centrifuge')` cannot resolve because
 * the package is deliberately not installed: the production build failed with
 * `Rolldown failed to resolve import "centrifuge"`. The adapter's dynamic
 * import exists precisely to keep an undeployed SDK out of every user's bundle,
 * so the fix is to stop dragging it in, not to externalise it and ship an
 * import that 404s at runtime. One definition, imported by both.
 */
export const TRANSPORT_KEYS = Object.freeze(['socketio', 'centrifugo'])

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
