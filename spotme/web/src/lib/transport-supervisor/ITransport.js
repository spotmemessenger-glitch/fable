/**
 * Spot Me — the ADAPTIVE transport contract: ITransport. Priority 2, ADR-012.
 *
 * SCAFFOLDING ONLY. `ADAPTIVE_TRANSPORT_ENABLED` is false, no real transport
 * implements this yet, and nothing here is wired into the message path.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * transport/ITransportAdapter.js (ADR-002) is the SHIPPING contract: seven
 * methods, opaque bytes, no key surface. It is deliberately narrow so a second
 * transport does not become a Socket.IO emulator. This file does NOT modify it.
 *
 * ITransport GENERALISES that contract for the adaptive supervisor, adding the
 * three signals a selector needs to choose between live transports —
 * `quality()`, `costSignal()`, `capabilities()` — on top of a
 * connect/send/receive lifecycle. A real Socket.IO or Centrifugo adapter
 * *could* implement ITransport by wrapping its ADR-002 adapter; that wrapping
 * is DEFERRED (it is part of wiring, which this PR does not do).
 *
 * THE KEY PROHIBITION IS INHERITED, NOT RELAXED (INV-1). Generalising the
 * contract must not widen the attack surface. `FORBIDDEN_KEY_SURFACE` is
 * imported unchanged from the ADR-002 contract and re-asserted here: an
 * ITransport carries OPAQUE, ALREADY-SEALED bytes and may never touch key
 * material. Sealing happens ABOVE the transport (see seal-boundary.js), and
 * that lift is itself deferred.
 */
import { FORBIDDEN_KEY_SURFACE, TransportStatus } from '../transport/ITransportAdapter.js'

/* Re-exported so supervisor code and tests have one import site, and so the
 * single source of truth for the key prohibition stays ADR-002's list. */
export { FORBIDDEN_KEY_SURFACE, TransportStatus }

/**
 * Every ITransport must implement exactly these.
 *
 *   connect(opts)        -> Promise<void>            establish the session
 *   disconnect()         -> Promise<void>            tear down, release resources
 *   send(envelope)       -> Promise<{accepted,token?}>  OPAQUE SealedEnvelope only
 *   receive(handler)     -> () => void               subscribe; returns unsubscribe
 *   quality()            -> QualitySample            live health, for scoring
 *   costSignal()         -> CostSignal               $ / battery / metered, for scoring
 *   capabilities()       -> Capabilities             the static matrix row
 *   status()             -> TransportStatus          normalised lifecycle state
 */
export const ITRANSPORT_METHODS = Object.freeze([
  'connect', 'disconnect', 'send', 'receive',
  'quality', 'costSignal', 'capabilities', 'status'
])

/** A live health sample a transport reports so the selector can score it. */
export function makeQualitySample ({ latencyMs = null, lossPct = 0, throughputKbps = null, jitterMs = 0, connected = false } = {}) {
  if (latencyMs != null && (typeof latencyMs !== 'number' || latencyMs < 0)) throw new Error('quality: latencyMs must be a non-negative number or null')
  if (typeof lossPct !== 'number' || lossPct < 0 || lossPct > 1) throw new Error('quality: lossPct must be 0..1')
  return Object.freeze({ latencyMs, lossPct, throughputKbps, jitterMs, connected: !!connected })
}

/** A cost sample: monetary/battery pressure and whether the link is metered. */
export function makeCostSignal ({ monetary = 0, battery = 0, metered = false } = {}) {
  for (const [k, v] of [['monetary', monetary], ['battery', battery]]) {
    if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`cost: ${k} must be 0..1`)
  }
  return Object.freeze({ monetary, battery, metered: !!metered })
}

/**
 * Throw unless `t` satisfies ITransport AND exposes no key-shaped surface.
 *
 * Mirrors assertImplementsTransport (ADR-002) deliberately: a partially
 * conforming transport is worse than an absent one, and the key prohibition is
 * a test rather than a paragraph. The status check is skipped when status() is
 * absent so the missing-method error is the one that surfaces first.
 */
export function assertImplementsITransport (t, label = 'transport') {
  if (!t || typeof t !== 'object') throw new Error(`${label}: not an object`)
  for (const m of ITRANSPORT_METHODS) {
    if (typeof t[m] !== 'function') throw new Error(`${label}: missing required method ${m}()`)
  }
  for (const banned of FORBIDDEN_KEY_SURFACE) {
    if (banned in t) {
      throw new Error(
        `${label}: exposes "${banned}" — an ITransport carries opaque, already-sealed ` +
        'bytes and must never touch key material (INV-1; ADR-002 §2, ADR-001)'
      )
    }
  }
  const s = t.status()
  if (!Object.values(TransportStatus).includes(s)) {
    throw new Error(`${label}: status() returned "${s}", not a TransportStatus`)
  }
}
