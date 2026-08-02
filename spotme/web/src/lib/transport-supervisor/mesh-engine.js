/**
 * Spot Me — the MESH ENGINE: the production layer over mesh.js. ADR-012b.
 *
 * mesh.js gave the mesh its pure heart: frames, the seen-set, and the one
 * decision (`receiveMeshFrame`). This engine is everything a REAL node needs
 * around that decision:
 *
 *   - LINKS. Neighbours attach as send functions (a BleCentralTransport
 *     connection, a loopback in tests, a native link on P10). The engine
 *     neither knows nor cares what a link is — it hands opaque frame objects
 *     to `link.send` and receives them via `receiveFrom`.
 *   - FORWARDING with reputation. A frame to relay goes to neighbours
 *     best-first (reputation rank), bounded by the relay fan-out, never back
 *     to the link it arrived on (split horizon).
 *   - RELIABILITY. Origin-tracked acks (mesh-ack.js): the destination acks
 *     end-to-end; the origin retransmits on the capped schedule; exhausted
 *     frames surface to the caller so the outbox can reroute.
 *   - DUTY CYCLE + battery floor. The engine's periodic work (retransmits,
 *     sweep) runs on one clock interval; scan scheduling is exported as
 *     data for the radio layer (web central honours the scan half; native
 *     honours both — P10).
 *   - HYGIENE. Malformed frames and TTL inflation are misbehaviour, recorded
 *     against the link that delivered them; the seen-set prunes on a timer;
 *     everything is bounded.
 *
 * INV-5 HOLDS MECHANICALLY: relaying uses mesh.js's `forward()`, which copies
 * the payload through untouched — the engine has no code path that could
 * rewrite ciphertext, and the invariant test drives this engine end-to-end
 * to prove a multi-hop delivery arrives bit-identical.
 *
 * No radio here. The web radio half lives in adapters/ble-central-transport.js
 * (central-only, honestly); the peripheral half is Priority 10 native.
 */
import { makeMeshFrame, receiveMeshFrame, createSeenSet, MESH_ACTION } from './mesh.js'
import { createAckTracker, makeAckFrame, isAckFrame } from './mesh-ack.js'
import { createPeerReputation, dutyCycleFor } from './mesh-peers.js'

export const MESH_ENGINE_DEFAULTS = Object.freeze({
  ttl: 7,                   // default hop budget (WS4 §7.2)
  relayFanout: 3,           // forward to at most this many neighbours
  tickMs: 1_000,            // retransmit/sweep cadence
  seenCapacity: 4096,
  seenTtlMs: 5 * 60_000,
  ackTtl: 7                 // acks flood with their own hop budget
})

export function createMeshEngine ({
  selfId,                   // this node's ROUTING id (rotating hash upstream)
  clock,
  config = {},
  onDeliver,                // (frame, { via }) => void — frames FOR this node
  onExhausted = null,       // (frame) => void — retransmit cap spent, reroute
  battery = null            // () => { batteryLevel, batteryKnown, charging, engaged }
} = {}) {
  if (!selfId || typeof selfId !== 'string') throw new Error('mesh-engine: selfId required')
  if (!clock) throw new Error('mesh-engine: clock required')
  if (typeof onDeliver !== 'function') throw new Error('mesh-engine: onDeliver required')
  const cfg = { ...MESH_ENGINE_DEFAULTS, ...config }

  const seen = createSeenSet({ capacity: cfg.seenCapacity, ttlMs: cfg.seenTtlMs })
  const ackSeen = createSeenSet({ capacity: cfg.seenCapacity, ttlMs: cfg.seenTtlMs })
  const acks = createAckTracker({})
  const reputation = createPeerReputation({})
  const links = new Map()      // peerId -> { send, rssi, attachedAt }
  // frameId -> peerId — who handed us the frame we then forwarded; when its
  // end-to-end ack flows back, THAT peer earns the delivery credit. Bounded.
  const creditTrail = new Map()
  const CREDIT_CAP = 2048
  let seq = 0
  let interval = null
  const counters = {
    originated: 0, delivered: 0, forwarded: 0, dropped: 0,
    acksSent: 0, acksReceived: 0, retransmits: 0, misbehaviour: 0
  }

  /* ------------------------------------------------------------- links --- */

  function attachLink (peerId, { send, rssi = null } = {}) {
    if (!peerId || typeof send !== 'function') throw new Error('mesh-engine: link needs peerId and send()')
    links.set(peerId, { send, rssi, attachedAt: clock.now() })
    return () => detachLink(peerId)
  }

  function detachLink (peerId) { return links.delete(peerId) }

  function credit (frameId, peerId) {
    creditTrail.set(frameId, peerId)
    if (creditTrail.size > CREDIT_CAP) {
      const oldest = creditTrail.keys().next().value
      creditTrail.delete(oldest)
    }
  }

  /** Send a raw object to one neighbour; failure is a reputation datum, never
   *  an exception into the caller. */
  function sendTo (peerId, obj) {
    const link = links.get(peerId)
    if (!link) return false
    try { link.send(obj); return true } catch { reputation.failed(peerId, clock.now()); return false }
  }

  /** Fan out to the best neighbours, split-horizon on `exceptPeerId`.
   *
   *  TWO DIFFERENT FAN-OUTS, DELIBERATELY. `cfg.relayFanout` bounds
   *  RELAYING — the flood-control knob, and the one MULTIHOP_ENABLED=false
   *  pins to 0. ORIGINATION (our own frames, our own acks, retransmits) fans
   *  to EVERY attached link instead: transmitting what this node itself owes
   *  is the point of having links, and muting it would make multihop-off mean
   *  "mute" rather than "don't relay strangers' frames" (a bug this exact
   *  distinction was added to fix — the multihop-off test caught it). */
  function fanOut (obj, exceptPeerId = null, fanout = cfg.relayFanout) {
    const candidates = [...links.keys()].filter((p) => p !== exceptPeerId)
    const ranked = reputation.rank(candidates)
    let sent = 0
    for (const peerId of ranked) {
      if (sent >= fanout) break
      if (sendTo(peerId, obj)) sent++
    }
    return sent
  }
  const fanOutOwn = (obj) => fanOut(obj, null, links.size)

  /* ---------------------------------------------------------- originate --- */

  /**
   * Originate one opaque payload into the mesh. Returns the frame (its
   * frameId is the delivery handle the caller correlates acks/exhaustion by).
   */
  function originate (payload, { ttl = cfg.ttl } = {}) {
    const frame = makeMeshFrame({ origin: selfId, seq: seq++, payload, ttl })
    seen.remember(frame.frameId, clock.now())   // never re-handle our own frame
    counters.originated++
    acks.track(frame, clock.now())
    fanOutOwn(frame)                            // origination: every link, not the relay bound
    return frame
  }

  /* ------------------------------------------------------------ receive --- */

  /**
   * A neighbour delivered `obj` over `viaPeerId`'s link. This is the single
   * entry point a radio adapter calls.
   */
  function receiveFrom (viaPeerId, obj) {
    const now = clock.now()

    if (isAckFrame(obj)) {
      // Dedup acks with their own seen-set (they flood too), then settle or
      // keep flooding toward the origin.
      if (ackSeen.has(`ack:${obj.ackFrameId}:${obj.origin}`, now)) return { action: 'ack-duplicate' }
      ackSeen.remember(`ack:${obj.ackFrameId}:${obj.origin}`, now)
      counters.acksReceived++
      if (acks.ackReceived(obj.ackFrameId)) {
        // Our own frame came home: the peer that first carried it away earns
        // the delivery, and so does the peer who brought the ack back.
        const carrier = creditTrail.get(obj.ackFrameId)
        if (carrier) { reputation.delivered(carrier, now); creditTrail.delete(obj.ackFrameId) }
        reputation.delivered(viaPeerId, now)
        return { action: 'ack-settled' }
      }
      // Not ours: relay the ack onward (bounded by its own dedup).
      fanOut(obj, viaPeerId)
      return { action: 'ack-forwarded' }
    }

    // Shape hygiene BEFORE the pure decision: a malformed frame is
    // misbehaviour by the link that handed it over.
    if (!obj || typeof obj.frameId !== 'string' || typeof obj.hop !== 'number' || typeof obj.ttl !== 'number' ||
        (typeof obj.payload !== 'string' && !(obj.payload instanceof Uint8Array))) {
      counters.misbehaviour++
      reputation.misbehaved(viaPeerId, 'malformed-frame', now)
      return { action: MESH_ACTION.DROP_INVALID }
    }
    // TTL inflation guard: a relay may only ever DECREASE remaining budget
    // (hop grows toward ttl). A frame claiming more hops left than the
    // protocol maximum is a forged header.
    if (obj.ttl > cfg.ttl || obj.hop > obj.ttl + 1 || obj.hop < 0) {
      counters.misbehaviour++
      reputation.misbehaved(viaPeerId, 'ttl-forgery', now)
      return { action: MESH_ACTION.DROP_INVALID }
    }

    const decision = receiveMeshFrame(obj, { seen, selfId, now })

    if (decision.action === MESH_ACTION.DROP_DUPLICATE) {
      counters.dropped++
      return { action: decision.action }
    }
    if (decision.action === MESH_ACTION.DROP_INVALID) {
      counters.misbehaviour++
      reputation.misbehaved(viaPeerId, 'invalid-frame', now)
      return { action: decision.action }
    }

    if (decision.deliver && obj.origin !== selfId) {
      counters.delivered++
      // END-TO-END ACK: this node is A destination (flooding means every
      // reached node delivers; the layer above decides whether the envelope
      // inside is for it — dedup upstairs absorbs the fan-in). The ack floods
      // back naming the frameId only.
      const ack = makeAckFrame({ ackFrameId: obj.frameId, origin: selfId, ts: now })
      ackSeen.remember(`ack:${ack.ackFrameId}:${ack.origin}`, now)
      counters.acksSent++
      fanOutOwn(ack)                     // OUR ack is an origination too
      onDeliver(obj, { via: viaPeerId })
    }

    if (decision.forward) {
      const sent = fanOut(decision.forward, viaPeerId)
      if (sent > 0) { counters.forwarded++; credit(obj.frameId, viaPeerId) }
    }
    return { action: decision.action }
  }

  /* ------------------------------------------------------------- upkeep --- */

  function tick () {
    const now = clock.now()
    seen.prune(now)
    ackSeen.prune(now)
    const { retransmit, exhausted } = acks.due(now)
    for (const frame of retransmit) {
      counters.retransmits++
      fanOutOwn(frame)                   // retransmits are re-originations
    }
    for (const frame of exhausted) {
      if (onExhausted) onExhausted(frame)
    }
  }

  return Object.freeze({
    attachLink,
    detachLink,
    originate,
    receiveFrom,
    tick,
    start () {
      if (interval != null) return
      interval = clock.setInterval(tick, cfg.tickMs)
    },
    stop () {
      if (interval == null) return
      clock.clearInterval(interval)
      interval = null
    },
    /** The scan schedule the radio layer should run right now. */
    dutySchedule () {
      const b = battery ? battery() : {}
      return dutyCycleFor(b)
    },
    neighbours: () => [...links.keys()],
    reputation,
    stats: () => ({ ...counters, links: links.size, seen: seen.size, awaitingAck: acks.pending() }),
    get running () { return interval != null }
  })
}
