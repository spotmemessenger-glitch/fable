/**
 * Spot Me — Adaptive Transport Supervisor: the barrel + the FLAG. ADR-012.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SCAFFOLDING ONLY. `ADAPTIVE_TRANSPORT_ENABLED` is false and this module is NOT
 * imported by any live code path. Importing it has NO side effects: it pulls in
 * pure logic and the read-only ADR-002 constants, and touches no network, no
 * storage, no crypto. Loading this barrel is the "module loads" smoke test.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT IS HERE (implemented, as scaffolding):
 *   ITransport.js     — generalised transport contract (adds quality/cost/caps)
 *   capabilities.js   — the capability matrix, as data
 *   registry.js       — a transport registry (factory, nothing registered here)
 *   selection.js      — weighted scoring + hysteresis (margin/dwell/stickiness)
 *   envelope.js       — SealedEnvelope + envelopeId dedup
 *   ordering.js       — 3-tier OrderingToken + reorder buffer
 *   mesh.js           — MeshFrame + seen-set/TTL/hopcount bounded flooding
 *   outbox.js         — store-and-forward outbox interface (generalises reach.js)
 *   invariants.js     — the six encryption invariants, as predicates
 *   seal-boundary.js  — the seal-lift boundary, DEFINED but DEFERRED
 *
 * WHAT IS DEFERRED (NOT here): the seal-lift (moving AES-GCM seal/open above the
 * transport — gated on P1 activation), native BLE radio (P10 native app), real
 * ITransport implementations, and any wiring into the message path.
 */

/**
 * The gate for the adaptive transport supervisor. FALSE, and it stays false in
 * scaffolding. Turning it on is a separate, later PR that also does the wiring
 * and the seal-lift — flipping this constant alone would enable nothing, because
 * nothing reads the supervisor yet. It exists so that wiring has ONE switch to
 * find, not a search-and-replace.
 */
export const ADAPTIVE_TRANSPORT_ENABLED = false

/** Read the gate. Returns the constant; there is no runtime override in
 *  scaffolding, deliberately — a flag you can flip from the console is not off. */
export function isAdaptiveTransportEnabled () {
  return ADAPTIVE_TRANSPORT_ENABLED === true
}

export {
  ITRANSPORT_METHODS, FORBIDDEN_KEY_SURFACE, TransportStatus,
  makeQualitySample, makeCostSignal, assertImplementsITransport
} from './ITransport.js'

export {
  RANGE, CAPABILITY_KEYS, CAPABILITY_MATRIX,
  makeCapabilities, latencyScore, bandwidthScore
} from './capabilities.js'

export { createTransportRegistry } from './registry.js'

export {
  DEFAULT_WEIGHTS, DEFAULT_HYSTERESIS,
  scoreCandidate, scoreAll, createSelector
} from './selection.js'

export {
  ENVELOPE_ID_INPUTS, envelopeIdFor, makeSealedEnvelope, createDedupWindow
} from './envelope.js'

export {
  makeOrderingToken, compareTokens, sortEnvelopes, createReorderBuffer
} from './ordering.js'

export {
  MESH_ACTION, makeMeshFrame, forward, createSeenSet, receiveMeshFrame
} from './mesh.js'

export {
  IOUTBOX_METHODS, assertImplementsOutbox, createMemoryOutbox
} from './outbox.js'

export {
  PLAINTEXT_FIELD_NAMES, INVARIANTS,
  assertNoKeySurface, assertOpaquePayload, assertNoSealSurface,
  assertIdInputsOpaque, assertRelayPreservesCiphertext, assertSealedBeforeSend
} from './invariants.js'

export {
  SEAL_LIFT_STATUS, SEALER_METHODS, DEFERRED_SEALER,
  createDeferredSealer, assertSealLiftNotImplemented
} from './seal-boundary.js'
