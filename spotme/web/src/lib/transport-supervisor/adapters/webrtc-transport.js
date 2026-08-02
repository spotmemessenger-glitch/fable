/**
 * Spot Me — WebRtcTransport: a peer-to-peer data path as an ITransport.
 * ADR-012b.
 *
 * A real RTCPeerConnection data channel with PERFECT NEGOTIATION — the same
 * algorithm socket-transport.js runs for calls (polite/impolite by id
 * comparison, rollback on collision), implemented here for a DATA channel
 * because the existing implementation is inside the frozen live path and is
 * call-media-specific. Nothing existing is modified; the SIGNALLING channel
 * is INJECTED (`signal.send` / `signal.onMessage`), and the wiring PR feeds
 * it from the room's public makeAction surface exactly as 'rtc' frames
 * travel today — a new action name, zero changes to existing files.
 *
 * WHAT THIS BUYS. When both peers are online, a DataChannel is a direct,
 * server-free path with the lowest latency of any transport here; on the
 * same network it stays entirely local (the LAN transport builds on this,
 * host-candidates-only). Establishment still needs signalling — capabilities
 * say so honestly (needsInternet: true, ADR-012's matrix note).
 *
 * BACKPRESSURE IS REAL. `send()` consults `bufferedAmount` and waits —
 * bounded — for `bufferedamountlow` before writing when the channel is
 * saturated. A DataChannel silently buffers until it kills the connection;
 * flow control is not optional at this layer.
 *
 * PLATFORM ABSENCE IS A STATE, NOT A CRASH: no RTCPeerConnection (old
 * WebView, Node) ⇒ status FAILED + unavailableReason, and the health FSM
 * parks it at UNAVAILABLE.
 */
import { CAPABILITY_MATRIX } from '../capabilities.js'
import { withTimeout } from '../clock.js'
import { assertSealedBeforeSend } from '../invariants.js'
import {
  TransportStatus, createAdapterStats, costSignalFor, encodeEnvelope, decodeEnvelope, createReceiveHub
} from './adapter-kit.js'

export const WEBRTC_TRANSPORT_DEFAULTS = Object.freeze({
  channelLabel: 'spotme-sup',
  connectTimeoutMs: 15_000,
  sendTimeoutMs: 10_000,
  bufferedHighWater: 1 << 20,       // 1 MiB — wait for drain above this
  bufferedLowWater: 1 << 18,        // resume threshold
  statsIntervalHintMs: 5_000
})

export function createWebRtcTransport ({
  peerId,                           // remote routing id — polite = selfId < peerId
  selfId,
  signal,                           // { send(obj), onMessage(fn) -> unsubscribe }
  rtcConfig = {},
  createPc = null,                  // () => RTCPeerConnection-like; default platform
  capabilities = CAPABILITY_MATRIX.webrtc,
  connection = undefined,
  config = {},
  clock = null
} = {}) {
  if (!peerId || !selfId) throw new Error('webrtc-transport: selfId and peerId required')
  if (!signal || typeof signal.send !== 'function' || typeof signal.onMessage !== 'function') {
    throw new Error('webrtc-transport: signal channel required')
  }
  const cfg = { ...WEBRTC_TRANSPORT_DEFAULTS, ...config }
  const platformPc = typeof RTCPeerConnection !== 'undefined' ? (c) => new RTCPeerConnection(c) : null
  const pcFactory = createPc || platformPc

  const stats = createAdapterStats()
  const hub = createReceiveHub()
  const polite = String(selfId) < String(peerId)

  let pc = null
  let dc = null
  let state = TransportStatus.IDLE
  let unavailable = pcFactory ? null : 'RTCPeerConnection is not available on this platform'
  let makingOffer = false
  let ignoreOffer = false
  let unSignal = null
  let openWaiters = []

  function dcReady () { return dc && dc.readyState === 'open' }

  function settleOpen (err = null) {
    const waiters = openWaiters
    openWaiters = []
    for (const w of waiters) err ? w.reject(err) : w.resolve()
  }

  function wireChannel (channel) {
    dc = channel
    dc.bufferedAmountLowThreshold = cfg.bufferedLowWater
    dc.onopen = () => { state = TransportStatus.CONNECTED; settleOpen() }
    dc.onclose = () => { if (state === TransportStatus.CONNECTED) state = TransportStatus.CLOSED }
    dc.onmessage = (ev) => {
      const envelope = typeof ev.data === 'string' ? decodeEnvelope(ev.data) : null
      if (envelope) hub.emit(envelope, { transport: 'webrtc', peerId })
    }
  }

  /** The perfect-negotiation handler — the W3C-blessed shape, the one the
   *  live call path also follows. Every message is processed; collisions
   *  roll back on the polite side and are ignored on the impolite side. */
  async function onSignal (msg) {
    if (!pc || !msg) return
    try {
      if (msg.description) {
        const collision = msg.description.type === 'offer' &&
          (makingOffer || pc.signalingState !== 'stable')
        ignoreOffer = !polite && collision
        if (ignoreOffer) return
        if (collision) await pc.setLocalDescription({ type: 'rollback' }).catch(() => {})
        await pc.setRemoteDescription(msg.description)
        if (msg.description.type === 'offer') {
          await pc.setLocalDescription()
          signal.send({ description: pc.localDescription })
        }
      } else if (msg.candidate) {
        await pc.addIceCandidate(msg.candidate).catch((err) => { if (!ignoreOffer) throw err })
      }
    } catch { /* negotiation errors surface as a channel that never opens; the
                 connect timeout owns the failure */ }
  }

  async function connect () {
    if (dcReady()) return
    if (!pcFactory) {
      state = TransportStatus.FAILED
      throw new Error(unavailable)
    }
    state = TransportStatus.CONNECTING
    pc = pcFactory(rtcConfig)
    unSignal = signal.onMessage(onSignal)

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true
        await pc.setLocalDescription()
        signal.send({ description: pc.localDescription })
      } catch { /* a failed offer leaves the channel unopened; timeout owns it */ } finally {
        makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => { if (candidate) signal.send({ candidate }) }
    pc.ondatachannel = ({ channel }) => { if (channel?.label === cfg.channelLabel) wireChannel(channel) }
    pc.onconnectionstatechange = () => {
      if (!pc) return
      if (pc.connectionState === 'failed') { state = TransportStatus.FAILED; settleOpen(new Error('webrtc: connection failed')) }
      if (pc.connectionState === 'disconnected') state = TransportStatus.RECONNECTING
      if (pc.connectionState === 'connected' && dcReady()) state = TransportStatus.CONNECTED
    }

    // Deterministic single-channel setup: the POLITE side opens the channel;
    // the impolite side receives it via ondatachannel. (Either works under
    // perfect negotiation; picking one avoids two channels racing.)
    if (polite) wireChannel(pc.createDataChannel(cfg.channelLabel))

    await withTimeout(new Promise((resolve, reject) => {
      if (dcReady()) { resolve(); return }
      openWaiters.push({ resolve, reject })
    }), cfg.connectTimeoutMs, `webrtc connect to ${peerId}`, clock)
  }

  async function disconnect () {
    if (unSignal) { try { unSignal() } catch { /* gone */ } unSignal = null }
    try { dc?.close() } catch { /* gone */ }
    try { pc?.close() } catch { /* gone */ }
    dc = null
    pc = null
    settleOpen(new Error('webrtc: disconnected'))
    state = TransportStatus.CLOSED
  }

  /** Bounded wait for the buffered amount to drain under the low-water mark. */
  function awaitDrain () {
    if (!dc || dc.bufferedAmount <= cfg.bufferedHighWater) return Promise.resolve()
    return withTimeout(new Promise((resolve) => {
      const prev = dc.onbufferedamountlow
      dc.onbufferedamountlow = () => { dc.onbufferedamountlow = prev; resolve() }
    }), cfg.sendTimeoutMs, 'webrtc backpressure drain', clock)
  }

  async function send (envelope) {
    assertSealedBeforeSend(envelope, 'webrtc-transport send')
    if (!dcReady()) throw new Error('webrtc-transport: channel not open')
    await awaitDrain()
    const wire = encodeEnvelope(envelope)
    // DataChannel send is fire-and-forget; RTT truth comes from getStats()
    // (candidate-pair currentRoundTripTime) sampled below, not from faking an
    // ack. Failures here are real failures (throwing send = closed channel).
    try {
      dc.send(wire)
    } catch (err) {
      stats.recordFailure()
      throw err
    }
    sampleStats()   // opportunistic, non-blocking
    return { accepted: true }
  }

  let statsInFlight = false
  let lastStatsAt = 0
  function sampleStats () {
    if (statsInFlight || !pc || typeof pc.getStats !== 'function') return
    const t = Date.now()
    if (t - lastStatsAt < cfg.statsIntervalHintMs) return
    statsInFlight = true
    lastStatsAt = t
    Promise.resolve(pc.getStats()).then((report) => {
      statsInFlight = false
      if (!report || typeof report.forEach !== 'function') return
      report.forEach((row) => {
        if (row.type === 'candidate-pair' && row.state === 'succeeded' && typeof row.currentRoundTripTime === 'number') {
          stats.recordRtt(row.currentRoundTripTime * 1000)
        }
      })
    }).catch(() => { statsInFlight = false })
  }

  return Object.freeze({
    name: 'webrtc',
    connect,
    disconnect,
    send,
    receive: hub.receive.bind(hub),
    quality: () => stats.sample({ connected: dcReady() }),
    costSignal: () => costSignalFor({ battery: capabilities.batteryCostPerMin, connection }),
    capabilities: () => capabilities,
    status: () => state,
    unavailableReason: () => unavailable,
    /** Exposed for the LAN transport's host-candidate verification. */
    getStats: () => (pc && typeof pc.getStats === 'function' ? pc.getStats() : Promise.resolve(null))
  })
}
