/**
 * Spot Me — Bluetooth MESH scaffolding: MeshFrame + bounded flooding. ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired). PURE functions — NO native BLE calls.
 *
 * True offline Bluetooth chat is what the whole adaptive layer builds toward,
 * and the honest note in views/bluetooth.js still stands: the RADIO is a native-
 * app capability (Priority 10), not something this web layer can open. What CAN
 * exist today, and be tested exhaustively without a radio, is the ROUTING logic
 * a mesh needs: how a frame is named, how a node avoids forwarding the same
 * frame twice, and when a frame stops propagating. That is all this file is.
 *
 * BOUNDED FLOODING. A mesh with no routing table floods: each node rebroadcasts
 * what it hears. Left unbounded that is a broadcast storm. Two bounds tame it:
 *   - a SEEN-SET so a node forwards a given frame at most once, and
 *   - a TTL / HOPCOUNT so a frame dies after a fixed number of hops.
 * Both are enforced here as pure predicates over a frame and local state.
 *
 * The payload a MeshFrame carries is an OPAQUE SealedEnvelope's bytes. A relay
 * forwards them BIT-IDENTICALLY (INV-5): only `hop` changes in transit. A relay
 * that could rewrite the payload could tamper undetected — so it cannot, and
 * `forward()` proves it by copying the payload through untouched.
 */
import { digest } from './hash.js'

/** Build a MeshFrame. `frameId` defaults to a stable id over routing + payload
 *  digest, so the same logical frame gets the same id on every node (INV-4). */
export function makeMeshFrame ({ frameId = null, origin, seq, payload, ttl, hop = 0 }) {
  if (!origin || typeof origin !== 'string') throw new Error('mesh: origin required')
  if (typeof seq !== 'number' || seq < 0) throw new Error('mesh: seq must be a non-negative number')
  if (typeof ttl !== 'number' || ttl < 0) throw new Error('mesh: ttl must be a non-negative number')
  if (typeof hop !== 'number' || hop < 0) throw new Error('mesh: hop must be a non-negative number')
  if (typeof payload !== 'string' && !(payload instanceof Uint8Array)) {
    throw new Error('mesh: payload must be opaque bytes or base64 text')
  }
  const id = frameId || `mf_${digest([origin, seq, digest(payload)].join('|'))}`
  return Object.freeze({ frameId: id, origin, seq, payload, ttl, hop })
}

/** Return a new frame one hop further along. Payload is copied THROUGH untouched
 *  (INV-5); only `hop` advances. Never mutates the input. */
export function forward (frame) {
  return Object.freeze({
    frameId: frame.frameId,
    origin: frame.origin,
    seq: frame.seq,
    payload: frame.payload,   // bit-identical — a relay may not rewrite ciphertext
    ttl: frame.ttl,
    hop: frame.hop + 1
  })
}

/**
 * A bounded, TTL-expiring set of frameIds a node has already handled.
 *
 * Bounded (evict oldest past `capacity`) AND time-expiring (`ttlMs`): a mesh
 * node has finite memory and a frame is only interesting for a short window.
 * Both together are why flooding terminates without a node remembering forever.
 */
export function createSeenSet ({ capacity = 4096, ttlMs = 5 * 60_000 } = {}) {
  if (capacity < 1) throw new Error('seenSet: capacity must be >= 1')
  const seen = new Map()   // frameId -> expiry ms

  function prune (now) {
    for (const [id, exp] of seen) {
      if (exp <= now) seen.delete(id)
      else break   // Map is in insertion order; inserts share a monotonic-ish now,
                   // so the first non-expired entry means the rest are newer too.
    }
  }

  return {
    has (id, now = 0) {
      const exp = seen.get(id)
      if (exp == null) return false
      if (exp <= now) { seen.delete(id); return false }
      return true
    },
    remember (id, now = 0) {
      seen.delete(id)   // reinsert to move it to the newest position
      seen.set(id, now + ttlMs)
      if (seen.size > capacity) {
        const oldest = seen.keys().next().value
        seen.delete(oldest)
      }
      return id
    },
    prune,
    get size () { return seen.size }
  }
}

/** The decisions receiveMeshFrame can return, named so tests read as intent. */
export const MESH_ACTION = Object.freeze({
  DELIVER_AND_FORWARD: 'deliver-and-forward',   // new, in-TTL, not ours -> surface + relay
  DELIVER_ONLY: 'deliver-only',                 // new but TTL spent or ours -> surface, do not relay
  DROP_DUPLICATE: 'drop-duplicate',             // already seen -> ignore
  DROP_INVALID: 'drop-invalid'                  // malformed frame
})

/**
 * The heart of bounded flooding, as a pure decision.
 *
 * Given a frame and local state ({ seen, selfId, now }), decide what this node
 * does — with NO side effects except recording the frame as seen (which IS the
 * dedup, so it must happen here for the decision to be correct on the next copy).
 *
 * Rules, in order:
 *   1. malformed            -> DROP_INVALID
 *   2. already seen         -> DROP_DUPLICATE (this is what kills the storm)
 *   3. new: record as seen, then:
 *        - forwarding one more hop would exceed ttl  -> DELIVER_ONLY
 *        - the frame originated here                 -> DELIVER_ONLY (no echo)
 *        - otherwise                                 -> DELIVER_AND_FORWARD (+forwarded frame)
 */
export function receiveMeshFrame (frame, { seen, selfId, now = 0 }) {
  if (!frame || typeof frame.frameId !== 'string' || typeof frame.hop !== 'number' || typeof frame.ttl !== 'number') {
    return { action: MESH_ACTION.DROP_INVALID, deliver: false, forward: null }
  }
  if (seen.has(frame.frameId, now)) {
    return { action: MESH_ACTION.DROP_DUPLICATE, deliver: false, forward: null }
  }
  seen.remember(frame.frameId, now)

  const ttlSpent = frame.hop + 1 > frame.ttl
  const isOwn = frame.origin === selfId
  if (ttlSpent || isOwn) {
    return { action: MESH_ACTION.DELIVER_ONLY, deliver: true, forward: null }
  }
  return { action: MESH_ACTION.DELIVER_AND_FORWARD, deliver: true, forward: forward(frame) }
}
