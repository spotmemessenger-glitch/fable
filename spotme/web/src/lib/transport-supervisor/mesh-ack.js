/**
 * Spot Me — RELIABLE MESH ACKS: per-frame acknowledgement + retransmit. ADR-012b.
 *
 * Bounded flooding (mesh.js) is fire-and-forget: a frame either reaches the
 * destination within TTL or dies. Reliability is layered ON TOP, end-to-end:
 * the DESTINATION (never a relay) emits an ack frame naming the frameId it
 * received; the ORIGIN retransmits unacked frames on a capped backoff until
 * an ack arrives or the cap is spent. Relays gain nothing to forge — an ack
 * only stops the origin's own retransmit timer, and a relay suppressing an
 * ack merely causes a retransmit the seen-sets absorb.
 *
 * WHY END-TO-END AND NOT HOP-BY-HOP. Hop acks multiply radio traffic by the
 * hop count and prove the wrong thing (that a neighbour heard it, not that
 * the destination did). End-to-end acks ride the same flood mechanism
 * backwards and prove exactly the property the outbox needs: the debt is
 * paid. This mirrors the DeliveryAck design in WS4 §9.3 — a signed receipt
 * (P1 crypto) later slots into `proof` without changing this mechanics.
 *
 * AN ACK CARRIES NO CONTENT. It names a frameId (an opaque digest), the
 * acker's routing id, and nothing else — INV-4 discipline. It is NOT a
 * cryptographic receipt; authenticity of receipts arrives with P1 (the
 * signed-receipt slot is reserved, not implemented — no crypto here).
 */

export const ACK_DEFAULTS = Object.freeze({
  baseRetransmitMs: 2_000,   // first retransmit delay
  factor: 2,                 // exponential growth per attempt
  maxRetransmitMs: 60_000,   // per-gap cap
  maxAttempts: 6             // total transmissions = 1 original + this many retries
})

/** The ack frame shape. `kind` keys dispatch; everything else is routing. */
export function makeAckFrame ({ ackFrameId, origin, ts = 0 }) {
  if (!ackFrameId || typeof ackFrameId !== 'string') throw new Error('ack: ackFrameId required')
  if (!origin || typeof origin !== 'string') throw new Error('ack: origin (acker routing id) required')
  return Object.freeze({ kind: 'mesh-ack', ackFrameId, origin, ts })
}

export function isAckFrame (x) {
  return !!x && x.kind === 'mesh-ack' && typeof x.ackFrameId === 'string'
}

/**
 * Track outbound frames awaiting acks and decide retransmits. Pure timing —
 * the engine calls `due(now)` from its clock; this module holds no timers.
 */
export function createAckTracker ({ config = {}, rand = Math.random } = {}) {
  const cfg = { ...ACK_DEFAULTS, ...config }
  // frameId -> { frame, attempts, nextAt, firstAt }
  const waiting = new Map()
  const counters = { tracked: 0, acked: 0, retransmits: 0, exhausted: 0 }

  function delayFor (attempts) {
    const raw = Math.min(cfg.maxRetransmitMs, cfg.baseRetransmitMs * Math.pow(cfg.factor, Math.max(0, attempts - 1)))
    return Math.round(raw * (0.75 + rand() * 0.5))   // ±25% jitter, herd-safe
  }

  return Object.freeze({
    /** The origin sent `frame` (first transmission) at `now`. */
    track (frame, now) {
      if (!frame?.frameId) throw new Error('ack: frame with frameId required')
      if (waiting.has(frame.frameId)) return waiting.get(frame.frameId)
      const entry = { frame, attempts: 1, nextAt: now + delayFor(1), firstAt: now }
      waiting.set(frame.frameId, entry)
      counters.tracked++
      return entry
    },

    /** An ack arrived. True if it settled a waiting frame. */
    ackReceived (ackFrameId) {
      const had = waiting.delete(ackFrameId)
      if (had) counters.acked++
      return had
    },

    /**
     * Everything due for retransmission at `now`. Each returned frame has its
     * attempt counter advanced and its next slot scheduled; frames past the
     * cap are EXHAUSTED and reported so the outbox can fall back to another
     * transport instead of silently giving up.
     */
    due (now) {
      const retransmit = []
      const exhausted = []
      for (const [id, entry] of waiting) {
        if (entry.nextAt > now) continue
        if (entry.attempts >= cfg.maxAttempts) {
          waiting.delete(id)
          counters.exhausted++
          exhausted.push(entry.frame)
          continue
        }
        entry.attempts++
        entry.nextAt = now + delayFor(entry.attempts)
        counters.retransmits++
        retransmit.push(entry.frame)
      }
      return { retransmit, exhausted }
    },

    pending: () => waiting.size,
    stats: () => ({ ...counters, waiting: waiting.size })
  })
}
