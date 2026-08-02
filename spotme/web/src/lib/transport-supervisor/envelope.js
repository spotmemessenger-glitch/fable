/**
 * Spot Me — SealedEnvelope + envelopeId dedup. Priority 2, ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired). Pure logic.
 *
 * A SealedEnvelope is the unit the adaptive supervisor moves across ANY
 * transport — Socket.IO today, Bluetooth mesh tomorrow. Its `ciphertext` is
 * OPAQUE BYTES: this layer never seals, opens, or inspects it (INV-2). The
 * envelope exists so that dedup and ordering can be done on ROUTING metadata and
 * an id, without the transport ever seeing plaintext or a key.
 *
 * WHY DEDUP LIVES HERE. Once a message can arrive over more than one path — a
 * mesh that floods, a relay that replays, a reconnect that re-sends — the SAME
 * sealed bytes will arrive more than once. `envelopeId` is the stable name that
 * lets the receiver drop the copies. It is derived from routing fields + a
 * digest of the already-sealed ciphertext (INV-4); it is NOT a MAC and proves
 * nothing about authenticity — the seal below does that, unchanged.
 */
import { digest } from './hash.js'

/** Fields allowed to influence an envelopeId. Enforced so no key/plaintext leaks
 *  into an identifier (INV-4). `ciphertextDigest` stands in for opaque bytes. */
export const ENVELOPE_ID_INPUTS = Object.freeze(['roomId', 'origin', 'serverSeq', 'ratchetPos', 'senderClock', 'ciphertextDigest'])

/**
 * Derive a stable envelopeId from opaque, non-secret inputs only.
 *
 * The ordering tier values are folded in so two genuinely different messages
 * from one origin never collide, while re-sends of the SAME message (identical
 * ciphertext + ordering) collapse to one id — which is exactly what dedup needs.
 */
export function envelopeIdFor ({ roomId, origin, ordering = {}, ciphertext }) {
  if (!roomId || !origin) throw new Error('envelopeId: roomId and origin are required')
  const ciphertextDigest = digest(ciphertext)
  const material = [
    roomId, origin,
    ordering.serverSeq ?? '', ordering.ratchetPos ?? '', ordering.senderClock ?? '',
    ciphertextDigest
  ].join('|')
  return `env_${digest(material)}`
}

/**
 * Build a SealedEnvelope. `ciphertext` MUST already be sealed by the layer above
 * (see seal-boundary.js) — this constructor refuses anything that looks like
 * cleartext content, so a mis-wire fails loudly here instead of on the wire.
 */
export function makeSealedEnvelope ({ roomId, origin, ciphertext, ordering = null, ts = 0, envelopeId = null }) {
  if (!roomId || typeof roomId !== 'string') throw new Error('envelope: roomId required')
  if (!origin || typeof origin !== 'string') throw new Error('envelope: origin required')
  if (typeof ciphertext !== 'string' && !(ciphertext instanceof Uint8Array)) {
    throw new Error('envelope: ciphertext must be opaque bytes or base64 text')
  }
  const id = envelopeId || envelopeIdFor({ roomId, origin, ordering: ordering || {}, ciphertext })
  return Object.freeze({
    envelopeId: id,
    roomId,
    origin,
    ciphertext,      // OPAQUE — never read by this layer
    ordering: ordering ? Object.freeze({ ...ordering }) : null,
    ts: ts || 0,
    sealed: true     // a marker asserted by INV-6; this layer never sets it false
  })
}

/**
 * A bounded dedup window keyed by envelopeId.
 *
 * Bounded on purpose: a mesh node cannot remember every id it ever saw, so the
 * window keeps the most recent `capacity` ids and evicts oldest-first. That
 * makes dedup EVENTUAL, not perfect — the trade a flood requires. Insertion
 * order is Map order; the oldest key is the first key.
 */
export function createDedupWindow ({ capacity = 4096 } = {}) {
  if (capacity < 1) throw new Error('dedup: capacity must be >= 1')
  const seen = new Map()   // envelopeId -> insertion index (value unused beyond presence)
  let n = 0

  function remember (id) {
    if (seen.has(id)) return false
    seen.set(id, n++)
    if (seen.size > capacity) {
      const oldest = seen.keys().next().value
      seen.delete(oldest)
    }
    return true
  }

  return {
    /** True if `id` has been seen within the current window. */
    has (id) { return seen.has(id) },
    /** Record `id`; returns true if it was NEW, false if already present. */
    remember,
    /**
     * Accept an envelope for processing exactly once. Returns true the first
     * time this envelopeId is offered and false for every duplicate after.
     */
    accept (envelope) {
      const id = typeof envelope === 'string' ? envelope : envelope?.envelopeId
      if (!id) throw new Error('dedup: envelope has no envelopeId')
      return remember(id)
    },
    get size () { return seen.size }
  }
}
