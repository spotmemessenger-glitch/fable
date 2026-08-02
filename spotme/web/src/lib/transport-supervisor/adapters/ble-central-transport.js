/**
 * Spot Me — BleCentralTransport: real Web Bluetooth, CENTRAL ROLE ONLY.
 * ADR-012b.
 *
 * WHAT THE WEB CAN DO, DONE FULLY: act as a GATT CLIENT. Choose a device
 * (`requestDevice` — user-gesture-bound by spec), connect its GATT server,
 * write envelope chunks to the peer's RX characteristic, subscribe to
 * notifications on its TX characteristic, reassemble, and reconnect with
 * backoff when `gattserverdisconnected` fires. RSSI arrives only where the
 * platform offers `watchAdvertisements` (Chromium, flagged); absence is a
 * neutral 0.5 link quality, never a penalty.
 *
 * WHAT THE WEB CANNOT DO, SAID PLAINLY (same honesty as views/bluetooth.js):
 *   - PERIPHERAL role: no GATT server, no advertising — so a WEB↔WEB pair
 *     cannot connect; a web central needs a native/peripheral peer. P10.
 *   - BACKGROUND radio: no scanning or connections while backgrounded. P10.
 *   - iOS/Firefox: Web Bluetooth is absent entirely. This transport detects
 *     that and parks at UNAVAILABLE with a reason — the health FSM never
 *     probes it again, and the selector never sees it as viable.
 *
 * The GATT SERVICE MODEL below is the app-owned contract the native side
 * (P10) implements as peripheral: one service, an RX characteristic
 * (central writes, write-with-response), a TX characteristic (peripheral
 * notifies), and a DISCOVERY characteristic serving the encoded discovery
 * record (mesh-peers.js).
 *
 * `bluetooth` is INJECTED (default `navigator.bluetooth`), so contract tests
 * and protocol tests run against a scripted fake in Node; nothing here is
 * mocked in production code.
 */
import { makeCapabilities, RANGE } from '../capabilities.js'
import { withTimeout } from '../clock.js'
import { assertSealedBeforeSend } from '../invariants.js'
import { parseDiscoveryRecord, rssiToLinkQuality } from '../mesh-peers.js'
import {
  TransportStatus, createAdapterStats, costSignalFor, encodeEnvelope, decodeEnvelope, createReceiveHub
} from './adapter-kit.js'
import { chunkFrame, createReassembler, BLE_CHUNK_DEFAULTS } from './ble-chunking.js'

/** The app-owned GATT model. The native peripheral (P10) serves these. */
export const SPOTME_GATT = Object.freeze({
  SERVICE: '4f5a3f2e-8a1d-4e6b-9c3a-5d2e7f4a1b30',
  RX_CHAR: '4f5a3f2e-8a1d-4e6b-9c3a-5d2e7f4a1b31',   // central WRITES envelope chunks here
  TX_CHAR: '4f5a3f2e-8a1d-4e6b-9c3a-5d2e7f4a1b32',   // peripheral NOTIFIES chunks here
  DISCOVERY_CHAR: '4f5a3f2e-8a1d-4e6b-9c3a-5d2e7f4a1b33'
})

export const BLE_TRANSPORT_DEFAULTS = Object.freeze({
  connectTimeoutMs: 12_000,
  writeTimeoutMs: 8_000,
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  reconnectMaxAttempts: 6,
  chunkPayloadBytes: BLE_CHUNK_DEFAULTS.chunkPayloadBytes
})

/** The nominal capability row for a single-hop BLE central link. */
export const BLE_CAPABILITIES = makeCapabilities({
  range: RANGE.PROXIMITY,
  needsInternet: false,
  offline: true,
  bandwidthKbps: 200,
  latencyMs: 200,
  batteryCostPerMin: 0.5,
  maxPayloadBytes: BLE_CHUNK_DEFAULTS.maxFrameBytes
})

export function createBleCentralTransport ({
  bluetooth = undefined,          // injected; default navigator.bluetooth
  device = null,                  // an already-granted BluetoothDevice (skips the chooser)
  requestOptions = null,          // override for requestDevice options
  config = {},
  clock = null,
  onPeerDiscovery = null          // (discoveryRecord) => void — mesh wiring hook
} = {}) {
  const cfg = { ...BLE_TRANSPORT_DEFAULTS, ...config }
  const bt = bluetooth !== undefined
    ? bluetooth
    : (typeof navigator !== 'undefined' ? navigator.bluetooth : null)
  const supported = !!(bt && typeof bt.requestDevice === 'function')

  const stats = createAdapterStats()
  const hub = createReceiveHub()
  const reassembler = createReassembler({})
  const nowFn = clock ? () => clock.now() : () => Date.now()

  let state = supported ? TransportStatus.IDLE : TransportStatus.FAILED
  let unavailable = supported
    ? null
    : 'Web Bluetooth is not available on this platform (iOS/Firefox block it; native BLE arrives with the P10 app)'
  let dev = device
  let server = null
  let rxChar = null
  let txChar = null
  let notifyCleanup = null
  let advCleanup = null
  let lastRssi = null
  let writeChain = Promise.resolve()   // GATT allows ONE operation at a time per device
  let tag = 0
  let reconnectAttempts = 0
  let reconnectTimer = null
  let wantConnected = false

  function onNotification (ev) {
    const value = ev?.target?.value
    if (!value) return
    const bytes = value.buffer ? new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength) : null
    if (!bytes) return
    const res = reassembler.push(bytes, nowFn())
    if (res.frame) {
      const text = new TextDecoder().decode(res.frame)
      const envelope = decodeEnvelope(text)
      if (envelope) hub.emit(envelope, { transport: 'bleCentral', rssi: lastRssi })
    }
  }

  function watchRssi () {
    // Chromium-only, flag-gated; feature-detect and degrade to null silently.
    if (!dev || typeof dev.watchAdvertisements !== 'function' || typeof dev.addEventListener !== 'function') return
    const onAdv = (ev) => { if (typeof ev?.rssi === 'number') lastRssi = ev.rssi }
    try {
      dev.addEventListener('advertisementreceived', onAdv)
      dev.watchAdvertisements().catch(() => {})
      advCleanup = () => { try { dev.removeEventListener('advertisementreceived', onAdv) } catch { /* gone */ } }
    } catch { /* not offered — RSSI stays null, quality stays neutral */ }
  }

  function scheduleReconnect () {
    if (!wantConnected || reconnectTimer != null) return
    if (reconnectAttempts >= cfg.reconnectMaxAttempts) {
      state = TransportStatus.FAILED
      return
    }
    const delay = Math.min(cfg.reconnectMaxMs, cfg.reconnectBaseMs * Math.pow(2, reconnectAttempts))
    reconnectAttempts++
    state = TransportStatus.RECONNECTING
    const timers = clock || { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) }
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      establish().catch(() => scheduleReconnect())
    }, delay)
  }

  function onDisconnected () {
    server = null
    rxChar = null
    txChar = null
    if (notifyCleanup) { try { notifyCleanup() } catch { /* gone */ } notifyCleanup = null }
    stats.recordFailure()
    if (wantConnected) scheduleReconnect()
    else state = TransportStatus.CLOSED
  }

  /** GATT connect + characteristic discovery, bounded. */
  async function establish () {
    if (!dev) throw new Error('ble: no device granted')
    server = await withTimeout(dev.gatt.connect(), cfg.connectTimeoutMs, 'ble gatt connect', clock)
    const service = await withTimeout(server.getPrimaryService(SPOTME_GATT.SERVICE), cfg.connectTimeoutMs, 'ble service discovery', clock)
    rxChar = await withTimeout(service.getCharacteristic(SPOTME_GATT.RX_CHAR), cfg.connectTimeoutMs, 'ble rx char', clock)
    txChar = await withTimeout(service.getCharacteristic(SPOTME_GATT.TX_CHAR), cfg.connectTimeoutMs, 'ble tx char', clock)
    await withTimeout(txChar.startNotifications(), cfg.connectTimeoutMs, 'ble notifications', clock)
    txChar.addEventListener('characteristicvaluechanged', onNotification)
    notifyCleanup = () => { try { txChar.removeEventListener('characteristicvaluechanged', onNotification) } catch { /* gone */ } }

    // Best-effort: read the peer's discovery record for the mesh layer.
    if (onPeerDiscovery) {
      try {
        const discChar = await service.getCharacteristic(SPOTME_GATT.DISCOVERY_CHAR)
        const value = await withTimeout(discChar.readValue(), cfg.connectTimeoutMs, 'ble discovery read', clock)
        const bytes = value?.buffer ? new Uint8Array(value.buffer, value.byteOffset ?? 0, value.byteLength) : null
        const record = bytes ? parseDiscoveryRecord(bytes) : null
        if (record) onPeerDiscovery(record)
      } catch { /* a peer without the characteristic is a peer, not an error */ }
    }

    reconnectAttempts = 0
    state = TransportStatus.CONNECTED
  }

  async function connect () {
    if (!supported) {
      state = TransportStatus.FAILED
      throw new Error(unavailable)
    }
    if (state === TransportStatus.CONNECTED) return
    state = TransportStatus.CONNECTING
    wantConnected = true
    try {
      if (!dev) {
        // The chooser MUST run inside a user gesture (spec). Wiring calls
        // connect() from the Bluetooth screen's tap; anything else gets the
        // platform's SecurityError, verbatim and honest.
        dev = await withTimeout(
          bt.requestDevice(requestOptions || { filters: [{ services: [SPOTME_GATT.SERVICE] }], optionalServices: [SPOTME_GATT.SERVICE] }),
          cfg.connectTimeoutMs, 'ble requestDevice', clock)
      }
      if (typeof dev.addEventListener === 'function') {
        dev.addEventListener('gattserverdisconnected', onDisconnected)
      }
      watchRssi()
      await establish()
    } catch (err) {
      state = TransportStatus.FAILED
      throw err
    }
  }

  async function disconnect () {
    wantConnected = false
    if (reconnectTimer != null) {
      const timers = clock || { clearTimeout: (t) => clearTimeout(t) }
      timers.clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (advCleanup) { advCleanup(); advCleanup = null }
    if (notifyCleanup) { notifyCleanup(); notifyCleanup = null }
    if (dev && typeof dev.removeEventListener === 'function') {
      try { dev.removeEventListener('gattserverdisconnected', onDisconnected) } catch { /* gone */ }
    }
    try { if (dev?.gatt?.connected) dev.gatt.disconnect() } catch { /* gone */ }
    server = null
    state = TransportStatus.CLOSED
  }

  /**
   * Send one envelope as ordered chunk writes. Writes are SERIALIZED on one
   * chain — GATT rejects concurrent operations on a device — and each write
   * is individually bounded and timed for the quality sample.
   */
  async function send (envelope) {
    assertSealedBeforeSend(envelope, 'ble-transport send')
    if (state !== TransportStatus.CONNECTED || !rxChar) throw new Error(unavailable || 'ble-transport: not connected')
    const bytes = new TextEncoder().encode(encodeEnvelope(envelope))
    const chunks = chunkFrame(bytes, { tag: tag = (tag + 1) & 0xff, chunkPayloadBytes: cfg.chunkPayloadBytes })
    const run = writeChain.then(async () => {
      for (const chunk of chunks) {
        await stats.timed(
          withTimeout(rxChar.writeValueWithResponse(chunk), cfg.writeTimeoutMs, 'ble chunk write', clock),
          { bytes: chunk.byteLength, now: nowFn })
      }
    })
    // The chain must survive a failed send (next send still runs)…
    writeChain = run.catch(() => {})
    // …but THIS send must surface its own failure.
    await run
    return { accepted: true }
  }

  return Object.freeze({
    name: 'bleCentral',
    connect,
    disconnect,
    send,
    receive: hub.receive.bind(hub),
    // RSSI is deliberately NOT folded into the QualitySample (its fields keep
    // their meanings); the radio prior rides separately in linkQuality().
    quality: () => stats.sample({ connected: state === TransportStatus.CONNECTED }),
    costSignal: () => costSignalFor({ battery: BLE_CAPABILITIES.batteryCostPerMin }),
    capabilities: () => BLE_CAPABILITIES,
    status: () => state,
    unavailableReason: () => unavailable,
    /** 0..1 radio-link prior from RSSI where the platform exposes it. */
    linkQuality: () => rssiToLinkQuality(lastRssi),
    lastRssi: () => lastRssi,
    supported,
    chunking: () => reassembler.stats()
  })
}
