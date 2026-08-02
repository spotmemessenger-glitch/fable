/**
 * Spot Me — CentrifugoTransport: the ADR-002 broker path as an ITransport.
 * ADR-012b.
 *
 * Wraps the ADR-002 CentrifugoAdapter (transport/centrifugo-adapter.js)
 * through its public factory, lazily. Everything that adapter is careful
 * about is inherited unchanged: the `centrifuge` package is imported
 * dynamically INSIDE its connect() (not installed ⇒ a clean failure, never a
 * build break), publishes go through the server (never client→broker), and
 * no key surface exists anywhere on the path.
 *
 * HONEST ABOUT ITS STATUS. Centrifugo is opt-in and NOT DEPLOYED: no broker
 * URL is configured and the SDK is deliberately absent. This transport does
 * not pretend otherwise — connect() fails fast, `status()` reports FAILED,
 * and `unavailableReason()` carries the adapter's own message, which the
 * health FSM maps to UNAVAILABLE (not probed on a timer, not silently
 * retried). The moment ADR-002's deployment lands, the same wrapper starts
 * reporting healthy without a code change here.
 *
 * THE SEAL CAVEAT, RESTATED (transport/room.js says it first): the underlying
 * adapter has NO seal step — its publish() ships payload verbatim. That is
 * precisely why this transport must only ever be handed ALREADY-SEALED
 * envelopes (INV-6, asserted on every send) and why chat activation over it
 * is gated on the seal-lift (ADR-008 §12; still deferred, still throwing).
 * The supervisor's envelope ciphertext is sealed ABOVE us by contract, so
 * what reaches the broker is ciphertext + routing — the ADR-002 §2 target
 * shape, enforced at this boundary instead of assumed.
 */
import { CAPABILITY_MATRIX } from '../capabilities.js'
import { withTimeout } from '../clock.js'
import { assertSealedBeforeSend } from '../invariants.js'
import {
  TransportStatus, createAdapterStats, costSignalFor, encodeEnvelope, decodeEnvelope, createReceiveHub
} from './adapter-kit.js'

export const CENTRIFUGO_TRANSPORT_DEFAULTS = Object.freeze({
  connectTimeoutMs: 10_000,
  sendTimeoutMs: 15_000
})

export function createCentrifugoTransport ({
  roomId,
  url = undefined,               // broker URL; absent ⇒ the adapter reports unavailable
  loadAdapter = null,            // async () => ({ createCentrifugoAdapter }) — lazy default
  connection = undefined,
  config = {},
  clock = null
} = {}) {
  if (!roomId || typeof roomId !== 'string') throw new Error('centrifugo-transport: roomId required')
  const cfg = { ...CENTRIFUGO_TRANSPORT_DEFAULTS, ...config }
  const load = loadAdapter || (() => import('../../transport/centrifugo-adapter.js'))

  const stats = createAdapterStats()
  const hub = createReceiveHub()
  const nowFn = clock ? () => clock.now() : () => Date.now()
  let adapter = null
  let state = TransportStatus.IDLE
  let unavailable = null         // the honest reason this transport cannot serve

  async function connect () {
    if (state === TransportStatus.CONNECTED) return
    state = TransportStatus.CONNECTING
    try {
      const mod = await withTimeout(load(), cfg.connectTimeoutMs, 'centrifugo adapter load', clock)
      adapter = adapter || mod.createCentrifugoAdapter(url ? { url } : {})
      await withTimeout(adapter.connect(), cfg.connectTimeoutMs, 'centrifugo connect', clock)
      await withTimeout(adapter.subscribe(roomId, {
        onRoomEvent: (_event, data) => {
          const text = typeof data === 'string' ? data : (data?.payload ?? null)
          const envelope = typeof text === 'string' ? decodeEnvelope(text) : null
          if (envelope) hub.emit(envelope, { transport: 'centrifugo' })
        }
      }), cfg.connectTimeoutMs, 'centrifugo subscribe', clock)
      state = TransportStatus.CONNECTED
      unavailable = null
    } catch (err) {
      state = TransportStatus.FAILED
      // The adapter's own message names the truth: URL unset, package absent,
      // broker down. Recorded verbatim so the event log explains itself.
      unavailable = `centrifugo unavailable: ${String(err?.message || err)}`
      throw err
    }
  }

  async function disconnect () {
    if (adapter) {
      try { await adapter.unsubscribe(roomId) } catch { /* already gone */ }
      try { await adapter.disconnect() } catch { /* already gone */ }
    }
    state = TransportStatus.CLOSED
  }

  async function send (envelope) {
    assertSealedBeforeSend(envelope, 'centrifugo-transport send')
    if (state !== TransportStatus.CONNECTED || !adapter) throw new Error(unavailable || 'centrifugo-transport: not connected')
    const wire = encodeEnvelope(envelope)
    await stats.timed(
      withTimeout(
        adapter.publish(roomId, { type: 'sup-env', payload: wire }),
        cfg.sendTimeoutMs, 'centrifugo publish', clock),
      { bytes: wire.length, now: nowFn }
    )
    return { accepted: true }
  }

  return Object.freeze({
    name: 'centrifugo',
    connect,
    disconnect,
    send,
    receive: hub.receive.bind(hub),
    quality: () => stats.sample({ connected: state === TransportStatus.CONNECTED }),
    costSignal: () => costSignalFor({ battery: CAPABILITY_MATRIX.centrifugo.batteryCostPerMin, connection }),
    capabilities: () => CAPABILITY_MATRIX.centrifugo,
    status: () => state,
    unavailableReason: () => unavailable
  })
}
