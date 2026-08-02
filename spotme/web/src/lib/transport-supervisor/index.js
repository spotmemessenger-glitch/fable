/**
 * Spot Me — Adaptive Transport Supervisor: the barrel + the FLAG. ADR-012/012b.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BUILT, TESTED, AND DARK. Every flag (this file's ADAPTIVE_TRANSPORT_ENABLED
 * and all of flags.js) is false, and this module is NOT imported by any live
 * code path. Importing it has NO side effects: it pulls in pure logic and the
 * read-only ADR-002 constants, and touches no network, no storage, no crypto,
 * and constructs no timers. Loading this barrel is the "module loads" test.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SCAFFOLDING (ADR-012, PR D — unchanged):
 *   ITransport.js     — generalised transport contract (adds quality/cost/caps)
 *   capabilities.js   — the capability matrix, as data
 *   registry.js       — a transport registry (factory, nothing registered here)
 *   selection.js      — weighted scoring + hysteresis (margin/dwell/stickiness)
 *   envelope.js       — SealedEnvelope + envelopeId dedup
 *   ordering.js       — 3-tier OrderingToken + reorder buffer
 *   mesh.js           — MeshFrame + seen-set/TTL/hopcount bounded flooding
 *   outbox.js         — store-and-forward outbox interface (generalises reach.js)
 *   invariants.js     — the six encryption invariants, as predicates
 *   seal-boundary.js  — the seal-lift boundary, DEFINED but DEFERRED (throws)
 *
 * PRODUCTION LAYER (ADR-012b, this PR — flag-gated OFF, still wired into
 * nothing; `createAdaptiveNetwork` in network.js is the one factory wiring
 * will call, and with the master flag off it constructs nothing):
 *   flags.js          — the layered flag set (all false; sub never outlives master)
 *   clock.js          — injectable clock/timers + the bounded-timeout helper
 *   ewma.js           — EWMA estimators + trend-based degradation prediction
 *   battery.js        — Battery API awareness with a conservative unknown default
 *   health-fsm.js     — per-transport connection-health state machine
 *   monitor.js        — the continuous sampling loop (passive-first, clock-driven)
 *   qos.js            — QoS classes (call-signal > message > receipt > telemetry)
 *   migration.js      — make-before-break switching + shared receive pipeline
 *   supervisor.js     — the engine: ranking, hysteresis, prediction, event log
 *   congestion.js     — AIMD congestion window + backoff classes
 *   durable-outbox.js — IndexedDB-backed IOutbox (joins the wipe path)
 *   drain.js          — store-and-forward drain (priority + congestion + retry)
 *   mesh-ack.js       — reliable mesh acks (retransmit with cap)
 *   mesh-peers.js     — discovery records, peer reputation, RSSI, duty cycle
 *   mesh-engine.js    — the mesh production layer over mesh.js
 *   network.js        — the flag-gated factory (master off ⇒ inert stub)
 *   adapters/         — real ITransport implementations (NOT exported here;
 *                       wiring imports them explicitly — see adapters/index.js)
 *
 * WHAT REMAINS DEFERRED: the seal-lift (moving AES-GCM seal/open above the
 * transport — gated on P1 activation, ADR-008 §12; seal-boundary.js still
 * throws), the native BLE radio (P10 — peripheral/GATT-server role, background
 * scanning), Wi-Fi Direct / mDNS (native), and any wiring into the message path.
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

/* ── production layer (ADR-012b) — pure at import, dark by flags ────────── */

export {
  ADAPTIVE_NETWORK_ENABLED, TRANSPORT_SUPERVISOR_ENABLED, AUTO_TRANSPORT_ENABLED,
  OFFLINE_MESSAGING_ENABLED, BLUETOOTH_MESH_ENABLED, MULTIHOP_ENABLED,
  LOCAL_NETWORK_ENABLED, DEFAULT_FLAGS, FLAG_NAMES, FLAG_PARENT,
  resolveFlags, isMasterEnabled, assertShippedDark
} from './flags.js'

export { createSystemClock, createManualClock, withTimeout } from './clock.js'
export { createEwma, createTrend, createQualityEstimator } from './ewma.js'
export { createBatteryReader, BATTERY_POLICY } from './battery.js'
export { HEALTH, HEALTH_THRESHOLDS, createHealthTracker } from './health-fsm.js'
export { createMonitor, MONITOR_DEFAULTS } from './monitor.js'
export { QOS, QOS_NAMES, QOS_POLICY, asQosClass, createQosQueue } from './qos.js'
export {
  MIGRATION_DEFAULTS, createReceivePipeline, createInFlightTracker, createMigrationExecutor
} from './migration.js'
export { createSupervisor, SUPERVISOR_DEFAULTS } from './supervisor.js'
export { CONGESTION_DEFAULTS, BACKOFF_CLASSES, createCongestionController, backoffDelay } from './congestion.js'
export { OUTBOX_DB_NAME, OUTBOX_STORE, createDurableOutbox, wipeDurableOutbox } from './durable-outbox.js'
export { DRAIN_DEFAULTS, createOutboxDrainer } from './drain.js'
export { ACK_DEFAULTS, createAckTracker, makeAckFrame, isAckFrame } from './mesh-ack.js'
export {
  REPUTATION_DEFAULTS, DUTY_CYCLE, createPeerReputation, makeDiscoveryRecord,
  parseDiscoveryRecord, rssiToLinkQuality, dutyCycleFor
} from './mesh-peers.js'
export { MESH_ENGINE_DEFAULTS, createMeshEngine } from './mesh-engine.js'
export { createAdaptiveNetwork } from './network.js'
