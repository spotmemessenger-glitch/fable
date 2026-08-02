/**
 * Spot Me — SocketIoTransport: the online baseline as an ITransport. ADR-012b.
 *
 * Wraps the ADR-002 SocketIOAdapter (transport/socketio-adapter.js) through
 * its PUBLIC surface only — createSocketIOAdapter(), connect/subscribe/
 * status/disconnect, and the room object subscribe() returns (the same
 * Trystero-shaped surface every screen already consumes). Nothing in the
 * existing transport is modified; this file is a consumer.
 *
 * THE WIRE. Envelopes ride a dedicated action name, 'sup-env', on the
 * existing room — a NEW action, so nothing collides with the live app's
 * 'msg'/'bin'/'rtc' channels. The room seals every action payload with the
 * room key below us (that is where sealing lives today, ADR-012 §2);
 * the supervisor's envelope — routing metadata + ITS OWN opaque ciphertext —
 * is simply the bytes that action carries. Double-wrapped, both layers
 * opaque to this adapter, zero change to cryptographic behaviour.
 *
 * LAZY DEPENDENCIES. The live adapter module is imported on first connect(),
 * not at module load: importing THIS file pulls in none of the live message
 * path, which keeps the barrel side-effect-free and the app bundle unchanged
 * while nothing references the supervisor. Tests inject `loadAdapter` with a
 * fake and never touch the network.
 *
 * QUALITY, MEASURED NOT IMAGINED. RTT/loss come from timing the acked sends
 * this transport actually performs (server emitWithAck under the hood).
 * The one own-traffic-free signal used is navigator.onLine for the
 * connected bit — free, passive, and the same signal the seam trusts.
 */
import { CAPABILITY_MATRIX } from '../capabilities.js'
import { withTimeout } from '../clock.js'
import { assertSealedBeforeSend } from '../invariants.js'
import {
  TransportStatus, createAdapterStats, costSignalFor, encodeEnvelope, decodeEnvelope, createReceiveHub
} from './adapter-kit.js'

export const SUP_ACTION = 'sup-env'

export const SOCKETIO_TRANSPORT_DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  sendTimeoutMs: 15_000,
  subscribeTimeoutMs: 10_000
})

export function createSocketIoTransport ({
  roomId,                        // the one room this transport instance carries
  password = undefined,          // passed through untouched (ADR-001 provider wins for v2)
  loadAdapter = null,            // async () => ({ createSocketIOAdapter }) — lazy default below
  isOnline = null,
  connection = undefined,        // Network Information API override for tests
  config = {},
  clock = null
} = {}) {
  if (!roomId || typeof roomId !== 'string') throw new Error('socketio-transport: roomId required')
  const cfg = { ...SOCKETIO_TRANSPORT_DEFAULTS, ...config }
  const load = loadAdapter || (() => import('../../transport/socketio-adapter.js'))
  const online = typeof isOnline === 'function'
    ? isOnline
    : () => (typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine !== false : true)

  const stats = createAdapterStats()
  const hub = createReceiveHub()
  const nowFn = clock ? () => clock.now() : () => Date.now()
  let adapter = null
  let action = null            // the room's 'sup-env' action, once subscribed
  let state = TransportStatus.IDLE
  let lastError = null

  async function connect () {
    if (state === TransportStatus.CONNECTED) return
    state = TransportStatus.CONNECTING
    try {
      const mod = await withTimeout(load(), cfg.connectTimeoutMs, 'socketio adapter load', clock)
      adapter = adapter || mod.createSocketIOAdapter()
      await withTimeout(adapter.connect(), cfg.connectTimeoutMs, 'socketio connect', clock)
      const room = await withTimeout(
        adapter.subscribe(roomId, { password }), cfg.subscribeTimeoutMs, 'socketio subscribe', clock)
      // The dedicated envelope action on the room's public surface. Incoming
      // bytes were opened by the room's own seal below us; what remains is
      // the supervisor's wire JSON.
      action = room.makeAction(SUP_ACTION)
      action.onMessage = (payload) => {
        const text = typeof payload === 'string'
          ? payload
          : (payload instanceof Uint8Array ? new TextDecoder().decode(payload) : null)
        const envelope = text ? decodeEnvelope(text) : null
        if (envelope) hub.emit(envelope, { transport: 'socketio' })
      }
      state = TransportStatus.CONNECTED
      lastError = null
    } catch (err) {
      state = TransportStatus.FAILED
      lastError = String(err?.message || err)
      throw err
    }
  }

  async function disconnect () {
    action = null
    if (adapter) {
      try { await adapter.unsubscribe(roomId) } catch { /* already gone */ }
      try { await adapter.disconnect() } catch { /* already gone */ }
    }
    state = TransportStatus.CLOSED
  }

  async function send (envelope) {
    assertSealedBeforeSend(envelope, 'socketio-transport send')
    if (state !== TransportStatus.CONNECTED || !action) throw new Error('socketio-transport: not connected')
    const wire = encodeEnvelope(envelope)
    await stats.timed(
      withTimeout(Promise.resolve(action.send(wire)), cfg.sendTimeoutMs, 'socketio send', clock),
      { bytes: wire.length, now: nowFn }
    )
    return { accepted: true }
  }

  return Object.freeze({
    name: 'socketio',
    connect,
    disconnect,
    send,
    receive: hub.receive.bind(hub),
    quality: () => stats.sample({ connected: state === TransportStatus.CONNECTED && online() }),
    costSignal: () => costSignalFor({ battery: CAPABILITY_MATRIX.socketio.batteryCostPerMin, connection }),
    capabilities: () => CAPABILITY_MATRIX.socketio,
    status: () => state,
    unavailableReason: () => (online() ? null : 'offline: no internet route'),
    lastError: () => lastError
  })
}
