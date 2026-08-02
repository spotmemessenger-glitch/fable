/**
 * Spot Me — the ADAPTERS barrel. ADR-012b.
 *
 * DELIBERATELY SEPARATE from the supervisor's own barrel (../index.js): the
 * main barrel stays a pure-logic import with zero reach toward the live
 * message path, while these factories — though side-effect-free at load
 * (every live-path dependency is a lazy dynamic import or an injected
 * object) — exist to be wired into it. Wiring imports THIS file explicitly;
 * nothing in the app does today, so the whole directory tree-shakes out of
 * the bundle, which the fence test pins.
 *
 * Every factory returns an object satisfying assertImplementsITransport
 * (the 8 methods, no key surface) plus adapter-specific honesty:
 * `unavailableReason()` where a platform cannot serve, `lanVerified()`,
 * `linkQuality()`, and the chunking stats — asserted in
 * test/adaptive-adapters.test.js.
 */
export { createSocketIoTransport, SUP_ACTION, SOCKETIO_TRANSPORT_DEFAULTS } from './socketio-transport.js'
export { createCentrifugoTransport, CENTRIFUGO_TRANSPORT_DEFAULTS } from './centrifugo-transport.js'
export { createWebRtcTransport, WEBRTC_TRANSPORT_DEFAULTS } from './webrtc-transport.js'
export { createLanTransport, LAN_CAPABILITIES } from './lan-transport.js'
export {
  createBleCentralTransport, SPOTME_GATT, BLE_TRANSPORT_DEFAULTS, BLE_CAPABILITIES
} from './ble-central-transport.js'
export {
  chunkFrame, parseChunk, createReassembler, CHUNK_HEADER_BYTES, BLE_CHUNK_DEFAULTS
} from './ble-chunking.js'
export {
  createAdapterStats, costSignalFor, encodeEnvelope, decodeEnvelope, createReceiveHub
} from './adapter-kit.js'
