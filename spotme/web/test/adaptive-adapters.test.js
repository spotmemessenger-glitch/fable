/**
 * The REAL transport adapters — contract, honesty, and protocol behaviour.
 *
 * Platform objects (the seam module, RTCPeerConnection, navigator.bluetooth)
 * are scripted FAKES injected through each adapter's DI seams; the adapter
 * code under test is the production code, unmodified. What is asserted:
 *
 *   - every adapter satisfies the generalised ITransport contract and grows
 *     no key surface (INV-1 inherited from ADR-002);
 *   - every adapter REFUSES an unsealed envelope (INV-6 at the edge);
 *   - SocketIO: wraps the seam's public API, uses a dedicated action name,
 *     round-trips envelopes, measures RTT from real acked sends;
 *   - Centrifugo: HONEST about its undeployed status (failed + reason);
 *   - WebRTC: perfect negotiation (happy path, polite rollback, impolite
 *     ignore), backpressure-bounded sends, honest platform absence;
 *   - LAN: verifies host↔host candidate pairs, refuses to claim LAN over a
 *     reflexive pair;
 *   - BLE central: chunked GATT writes within MTU, reassembly, reconnect
 *     with backoff after gattserverdisconnected, discovery record read, and
 *     the honest UNAVAILABLE on platforms without Web Bluetooth.
 */
import { createManualClock } from '../src/lib/transport-supervisor/clock.js'
import { assertImplementsITransport, FORBIDDEN_KEY_SURFACE } from '../src/lib/transport-supervisor/ITransport.js'
import { makeSealedEnvelope } from '../src/lib/transport-supervisor/envelope.js'
import { makeOrderingToken } from '../src/lib/transport-supervisor/ordering.js'
import { makeDiscoveryRecord, encodeDiscoveryRecord } from '../src/lib/transport-supervisor/mesh-peers.js'
import {
  encodeEnvelope, decodeEnvelope
} from '../src/lib/transport-supervisor/adapters/adapter-kit.js'
import { createSocketIoTransport, SUP_ACTION } from '../src/lib/transport-supervisor/adapters/socketio-transport.js'
import { createCentrifugoTransport } from '../src/lib/transport-supervisor/adapters/centrifugo-transport.js'
import { createWebRtcTransport } from '../src/lib/transport-supervisor/adapters/webrtc-transport.js'
import { createLanTransport } from '../src/lib/transport-supervisor/adapters/lan-transport.js'
import {
  createBleCentralTransport, SPOTME_GATT
} from '../src/lib/transport-supervisor/adapters/ble-central-transport.js'
import {
  chunkFrame, parseChunk, createReassembler, CHUNK_HEADER_BYTES
} from '../src/lib/transport-supervisor/adapters/ble-chunking.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await tick() }

const sealed = (n = 1, origin = 'alice') => makeSealedEnvelope({
  roomId: 'room-1', origin, ciphertext: `c1ph3r-${n}`,
  ordering: makeOrderingToken({ senderClock: n, origin })
})

/* ===================== envelope codec (shared wire) ===================== */

check('the envelope codec round-trips text AND binary ciphertext bit-identically', () => {
  const text = sealed(1)
  const t2 = decodeEnvelope(encodeEnvelope(text))
  const bin = makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: new Uint8Array([0, 1, 255, 128, 7]) })
  const b2 = decodeEnvelope(encodeEnvelope(bin))
  return t2.envelopeId === text.envelopeId && t2.ciphertext === text.ciphertext &&
    t2.ordering.senderClock === 1 && t2.sealed === true &&
    b2.ciphertext instanceof Uint8Array && b2.ciphertext.length === 5 && b2.ciphertext[2] === 255 &&
    b2.envelopeId === bin.envelopeId
})

check('the codec rejects malformed wires with null, never a throw', () => {
  return decodeEnvelope('not json') === null && decodeEnvelope('{"v":2}') === null &&
    decodeEnvelope(JSON.stringify({ v: 1, envelopeId: 'x' })) === null
})

/* ============================ fakes: socketio ============================ */

function fakeSeamModule () {
  // One shared bus per (roomId, action): both "devices" see each other.
  const bus = new Map()   // `${roomId}:${action}` -> Set<fn>
  const calls = { connect: 0, subscribe: 0, publishes: [] }
  const createSocketIOAdapter = () => {
    const rooms = new Map()
    let state = 'idle'
    return {
      name: 'socketio',
      async connect () { calls.connect++; state = 'connected' },
      async disconnect () { state = 'closed' },
      async subscribe (roomId, { password } = {}) {
        calls.subscribe++
        calls.lastPassword = password
        if (rooms.has(roomId)) return rooms.get(roomId)
        const room = {
          makeAction (name) {
            const key = `${roomId}:${name}`
            if (!bus.has(key)) bus.set(key, new Set())
            const record = { onMessage: null }
            bus.get(key).add(record)
            return {
              send: async (payload) => {
                calls.publishes.push({ roomId, name, payload })
                for (const r of bus.get(key)) {
                  if (r !== record && r.onMessage) setTimeout(() => r.onMessage(payload), 0)
                }
                return { seq: calls.publishes.length }
              },
              set onMessage (fn) { record.onMessage = fn }
            }
          },
          leave () {}
        }
        rooms.set(roomId, room)
        return room
      },
      async unsubscribe (roomId) { rooms.delete(roomId) },
      async publish () { throw new Error('unused in this wrapper') },
      async presence () { return [] },
      status: () => state
    }
  }
  return { module: { createSocketIOAdapter }, calls }
}

/* ========================== socketio transport ========================== */

await checkAsync('SocketIoTransport satisfies ITransport and carries no key surface', async () => {
  const { module } = fakeSeamModule()
  const t = createSocketIoTransport({ roomId: 'room-1', loadAdapter: async () => module, isOnline: () => true })
  assertImplementsITransport(t, 'SocketIoTransport')
  for (const banned of FORBIDDEN_KEY_SURFACE) if (banned in t) return false
  return true
})

await checkAsync('two SocketIoTransports round-trip a sealed envelope over the seam bus', async () => {
  const { module, calls } = fakeSeamModule()
  const a = createSocketIoTransport({ roomId: 'room-1', password: 'pw-1', loadAdapter: async () => module, isOnline: () => true })
  const b = createSocketIoTransport({ roomId: 'room-1', loadAdapter: async () => module, isOnline: () => true })
  await a.connect(); await b.connect()
  const got = []
  b.receive((envelope, meta) => got.push({ envelope, meta }))
  const res = await a.send(sealed(7))
  await settle()
  const q = a.quality()
  return res.accepted === true && got.length === 1 &&
    got[0].envelope.ordering.senderClock === 7 && got[0].envelope.sealed === true &&
    got[0].meta.transport === 'socketio' &&
    calls.publishes.every((p) => p.name === SUP_ACTION) &&    // dedicated action, no collision
    calls.lastPassword === undefined &&                        // b passed none; a's went through untouched
    q.connected === true && typeof q.latencyMs === 'number'   // RTT measured from the real acked send
})

await checkAsync('SocketIoTransport REFUSES an unsealed envelope (INV-6 at the edge)', async () => {
  const { module } = fakeSeamModule()
  const t = createSocketIoTransport({ roomId: 'room-1', loadAdapter: async () => module, isOnline: () => true })
  await t.connect()
  try { await t.send({ ciphertext: 'x', roomId: 'room-1' }); return false } catch { return true }
})

await checkAsync('a hung seam send is BOUNDED by the adapter timeout', async () => {
  const clock = createManualClock()
  const module = {
    createSocketIOAdapter: () => ({
      async connect () {},
      async subscribe () {
        return { makeAction: () => ({ send: () => new Promise(() => {}), set onMessage (fn) {} }), leave () {} }
      },
      async unsubscribe () {}, async disconnect () {}, async publish () {}, async presence () { return [] },
      status: () => 'connected'
    })
  }
  const t = createSocketIoTransport({
    roomId: 'r', loadAdapter: async () => module, isOnline: () => true, clock, config: { sendTimeoutMs: 400 }
  })
  await t.connect()
  const p = t.send(sealed(1)).then(() => 'sent', (e) => e)
  clock.advance(500)
  const err = await p
  return err instanceof Error && err.name === 'TimeoutError'
})

/* ========================= centrifugo transport ========================= */

await checkAsync('CentrifugoTransport is HONEST about the undeployed broker: failed + reason, contract intact', async () => {
  const t = createCentrifugoTransport({
    roomId: 'room-1',
    loadAdapter: async () => ({
      createCentrifugoAdapter: () => ({
        async connect () { throw new Error('VITE_CENTRIFUGO_URL is not set') },
        async disconnect () {}, async subscribe () {}, async unsubscribe () {},
        async publish () {}, async presence () { return [] }, status: () => 'failed'
      })
    })
  })
  assertImplementsITransport(t, 'CentrifugoTransport')
  let threw = false
  try { await t.connect() } catch { threw = true }
  return threw && t.status() === 'failed' &&
    /VITE_CENTRIFUGO_URL/.test(t.unavailableReason()) &&
    t.quality().connected === false
})

await checkAsync('when a broker EXISTS the same wrapper serves: publish through the server, receive publications', async () => {
  const published = []
  let roomHandler = null
  const t = createCentrifugoTransport({
    roomId: 'room-1',
    loadAdapter: async () => ({
      createCentrifugoAdapter: () => ({
        async connect () {},
        async subscribe (roomId, { onRoomEvent }) { roomHandler = onRoomEvent },
        async publish (roomId, frame) { published.push(frame); return {} },
        async unsubscribe () {}, async disconnect () {}, async presence () { return [] },
        status: () => 'connected'
      })
    })
  })
  await t.connect()
  const got = []
  t.receive((envelope) => got.push(envelope))
  await t.send(sealed(9))
  roomHandler('room_event', { payload: encodeEnvelope(sealed(10, 'bob')) })
  await settle()
  const wire = decodeEnvelope(published[0]?.payload || '')
  return t.status() === 'connected' && t.unavailableReason() === null &&
    published.length === 1 && published[0].type === 'sup-env' &&
    typeof published[0].payload === 'string' &&
    wire != null && wire.ciphertext === 'c1ph3r-9' && wire.sealed === true &&   // sealed bytes cross, opaque and intact
    got.length === 1 && got[0].ordering.senderClock === 10
})

/* ====================== fakes: RTCPeerConnection ====================== */

function fakeWire () {
  return { a: null, b: null }
}

function fakePc (name, log = []) {
  const pc = {
    name,
    signalingState: 'stable',
    connectionState: 'new',
    localDescription: null,
    remoteDescription: null,
    rollbacks: 0,
    candidates: [],
    _channels: [],
    _peer: null,               // the other fake pc, once "the network" links them
    _stats: null,
    onnegotiationneeded: null,
    onicecandidate: null,
    ondatachannel: null,
    onconnectionstatechange: null,
    createDataChannel (label) {
      const dc = fakeDc(label, this)
      this._channels.push(dc)
      queueMicrotask(() => this.onnegotiationneeded?.())
      return dc
    },
    async setLocalDescription (desc) {
      if (desc && desc.type === 'rollback') { this.rollbacks++; this.signalingState = 'stable'; return }
      if (desc) { this.localDescription = desc } else {
        this.localDescription = this.signalingState === 'have-remote-offer'
          ? { type: 'answer', sdp: `${name}-answer` }
          : { type: 'offer', sdp: `${name}-offer` }
      }
      this.signalingState = this.localDescription.type === 'offer' ? 'have-local-offer' : 'stable'
      if (this.localDescription.type === 'answer') queueMicrotask(() => this._maybeOpen())
      log.push(`${name}:setLocal:${this.localDescription.type}`)
    },
    async setRemoteDescription (desc) {
      this.remoteDescription = desc
      this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable'
      if (desc.type === 'answer') queueMicrotask(() => this._maybeOpen())
      log.push(`${name}:setRemote:${desc.type}`)
    },
    async addIceCandidate (c) { this.candidates.push(c) },
    getStats: async function () { return this._stats },
    close () { this.connectionState = 'closed' },
    /** Both descriptions applied on both sides ⇒ open the channel pair. */
    _maybeOpen () {
      const peer = this._peer
      if (!peer) return
      const ready = this.localDescription && this.remoteDescription && peer.localDescription && peer.remoteDescription
      if (!ready) return
      this.connectionState = 'connected'
      peer.connectionState = 'connected'
      this.onconnectionstatechange?.()
      peer.onconnectionstatechange?.()
      // Mirror channels created on either side to the other.
      for (const dc of this._channels) dc._openWithMirror(peer)
      for (const dc of peer._channels) dc._openWithMirror(this)
    }
  }
  return pc
}

function fakeDc (label, ownerPc) {
  const dc = {
    label,
    readyState: 'connecting',
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    onopen: null,
    onclose: null,
    onmessage: null,
    onbufferedamountlow: null,
    _mirror: null,
    send (data) {
      if (this.readyState !== 'open') throw new Error('dc not open')
      const m = this._mirror
      setTimeout(() => m?.onmessage?.({ data }), 0)
    },
    close () { this.readyState = 'closed'; this.onclose?.() },
    _openWithMirror (peerPc) {
      if (this.readyState === 'open') return
      let mirror = peerPc._channels.find((d) => d.label === this.label)
      if (!mirror) {
        mirror = fakeDc(this.label, peerPc)
        peerPc._channels.push(mirror)
        peerPc.ondatachannel?.({ channel: mirror })
      }
      this._mirror = mirror
      mirror._mirror = this
      this.readyState = 'open'
      mirror.readyState = 'open'
      this.onopen?.()
      mirror.onopen?.()
    }
  }
  return dc
}

/** A loopback signalling bus with async delivery, like a relay would be. */
function signalPair () {
  const aHandlers = new Set(); const bHandlers = new Set()
  return {
    a: { send: (m) => { for (const h of bHandlers) setTimeout(() => h(m), 0) }, onMessage: (f) => { aHandlers.add(f); return () => aHandlers.delete(f) } },
    b: { send: (m) => { for (const h of aHandlers) setTimeout(() => h(m), 0) }, onMessage: (f) => { bHandlers.add(f); return () => bHandlers.delete(f) } }
  }
}

/* =========================== webrtc transport =========================== */

await checkAsync('WebRtcTransport: perfect negotiation connects a pair; envelopes flow both ways', async () => {
  const log = []
  const pcA = fakePc('A', log); const pcB = fakePc('B', log)
  pcA._peer = pcB; pcB._peer = pcA
  const wire = fakeWire(); void wire
  const sig = signalPair()
  const a = createWebRtcTransport({ selfId: 'aaa', peerId: 'bbb', signal: sig.a, createPc: () => pcA })
  const b = createWebRtcTransport({ selfId: 'bbb', peerId: 'aaa', signal: sig.b, createPc: () => pcB })
  assertImplementsITransport(a, 'WebRtcTransport')
  const [ra, rb] = await Promise.all([a.connect(), b.connect()]).then(() => ['ok', 'ok'])
  const gotB = []; const gotA = []
  b.receive((e) => gotB.push(e.ordering.senderClock))
  a.receive((e) => gotA.push(e.ordering.senderClock))
  await a.send(sealed(1))
  await b.send(sealed(2, 'bob'))
  await settle()
  return ra === 'ok' && rb === 'ok' && a.status() === 'connected' && b.status() === 'connected' &&
    gotB.join(',') === '1' && gotA.join(',') === '2' &&
    // Deterministic single-channel: only the POLITE side (aaa < bbb) created it.
    pcA._channels.length >= 1 && log.some((l) => l === 'A:setLocal:offer')
})

await checkAsync('perfect negotiation: the POLITE side rolls back on a glare offer; the IMPOLITE side ignores it', async () => {
  // Drive the handler directly through the signal seam with a scripted glare.
  const log = []
  const pcPolite = fakePc('P', log)
  let politeIn = null
  const politeSignal = { send: () => {}, onMessage: (f) => { politeIn = f; return () => {} } }
  const polite = createWebRtcTransport({ selfId: 'aaa', peerId: 'bbb', signal: politeSignal, createPc: () => pcPolite })
  const politeConnect = polite.connect().catch(() => {})
  await settle()
  // The polite side has its own offer outstanding (have-local-offer). Glare:
  pcPolite.signalingState = 'have-local-offer'
  await politeIn({ description: { type: 'offer', sdp: 'remote-offer' } })
  await settle()
  const politeRolledBack = pcPolite.rollbacks === 1 && pcPolite.remoteDescription?.type === 'offer'

  const pcImpolite = fakePc('I', log)
  let impoliteIn = null
  const impoliteSignal = { send: () => {}, onMessage: (f) => { impoliteIn = f; return () => {} } }
  const impolite = createWebRtcTransport({ selfId: 'zzz', peerId: 'bbb', signal: impoliteSignal, createPc: () => pcImpolite })
  const impoliteConnect = impolite.connect().catch(() => {})
  await settle()
  pcImpolite.signalingState = 'have-local-offer'
  await impoliteIn({ description: { type: 'offer', sdp: 'remote-offer' } })
  await settle()
  const impoliteIgnored = pcImpolite.rollbacks === 0 && pcImpolite.remoteDescription == null
  await polite.disconnect(); await impolite.disconnect()
  await politeConnect; await impoliteConnect
  return politeRolledBack && impoliteIgnored
})

await checkAsync('backpressure: a saturated channel makes send WAIT for bufferedamountlow — bounded', async () => {
  const pcA = fakePc('A'); const pcB = fakePc('B')
  pcA._peer = pcB; pcB._peer = pcA
  const sig = signalPair()
  const a = createWebRtcTransport({ selfId: 'aaa', peerId: 'bbb', signal: sig.a, createPc: () => pcA })
  const b = createWebRtcTransport({ selfId: 'bbb', peerId: 'aaa', signal: sig.b, createPc: () => pcB })
  await Promise.all([a.connect(), b.connect()])
  const dc = pcA._channels.find((d) => d.label === 'spotme-sup')
  dc.bufferedAmount = (1 << 20) + 1   // over high water: send must wait
  let sent = false
  const p = a.send(sealed(3)).then(() => { sent = true })
  await settle()
  const heldWhileSaturated = sent === false
  dc.bufferedAmount = 0
  dc.onbufferedamountlow?.()
  await p
  return heldWhileSaturated && sent === true
})

check('WebRtcTransport on a platform with no RTCPeerConnection is honestly unavailable', () => {
  const sig = { send: () => {}, onMessage: () => () => {} }
  const t = createWebRtcTransport({ selfId: 'a', peerId: 'b', signal: sig, createPc: null })
  return typeof t.unavailableReason() === 'string' && /RTCPeerConnection/.test(t.unavailableReason())
})

/* ============================ lan transport ============================ */

function statsFor (localType, remoteType) {
  const rows = [
    { id: 'T', type: 'transport', selectedCandidatePairId: 'CP' },
    { id: 'CP', type: 'candidate-pair', state: 'succeeded', localCandidateId: 'L', remoteCandidateId: 'R', currentRoundTripTime: 0.004 },
    { id: 'L', type: 'local-candidate', candidateType: localType },
    { id: 'R', type: 'remote-candidate', candidateType: remoteType }
  ]
  return { forEach: (fn) => rows.forEach(fn) }
}

await checkAsync('LanTransport verifies a host↔host pair as LAN — and refuses to claim it over srflx', async () => {
  const mk = async (localType, remoteType) => {
    const pcA = fakePc('A'); const pcB = fakePc('B')
    pcA._peer = pcB; pcB._peer = pcA
    pcA._stats = statsFor(localType, remoteType)
    const sig = signalPair()
    const lan = createLanTransport({ selfId: 'aaa', peerId: 'bbb', signal: sig.a, createPc: (cfg) => { pcA._cfg = cfg; return pcA } })
    const far = createWebRtcTransport({ selfId: 'bbb', peerId: 'aaa', signal: sig.b, createPc: () => pcB, config: { channelLabel: 'spotme-sup-lan' } })
    await Promise.all([lan.connect(), far.connect()])
    return { lan, cfg: pcA._cfg }
  }
  const host = await mk('host', 'host')
  const srflx = await mk('srflx', 'host')
  assertImplementsITransport(host.lan, 'LanTransport')
  return host.lan.lanVerified() === true && srflx.lan.lanVerified() === false &&
    Array.isArray(host.cfg.iceServers) && host.cfg.iceServers.length === 0 &&   // NO STUN: the load-bearing difference
    host.lan.capabilities().range === 'lan'
})

/* ============================== chunking ============================== */

check('chunking splits at the MTU budget and reassembles bit-identically', () => {
  const bytes = new Uint8Array(1000).map((_, i) => i % 251)
  const chunks = chunkFrame(bytes, { tag: 7, chunkPayloadBytes: 180 })
  const sizesOk = chunks.every((c) => c.byteLength <= 180 + CHUNK_HEADER_BYTES)
  const r = createReassembler({})
  let frame = null
  for (const c of chunks) {
    const res = r.push(c, 0)
    if (res.frame) frame = res.frame
  }
  return chunks.length === Math.ceil(1000 / 180) && sizesOk &&
    frame != null && frame.length === 1000 && frame.every((v, i) => v === bytes[i])
})

check('the reassembler drops malformed, duplicate, and oversized input — bounded partials', () => {
  const r = createReassembler({ config: { maxPartials: 2, partialTtlMs: 100 } })
  const drop1 = r.push(new Uint8Array([1, 2]), 0).drop === 'malformed'
  const chunks = chunkFrame(new Uint8Array(400), { tag: 1, chunkPayloadBytes: 180 })
  r.push(chunks[0], 0)
  const dup = r.push(chunks[0], 0).drop === 'duplicate-chunk'
  // Two more partial frames: the third is refused (bound).
  r.push(chunkFrame(new Uint8Array(400), { tag: 2, chunkPayloadBytes: 180 })[0], 0)
  const bound = r.push(chunkFrame(new Uint8Array(400), { tag: 3, chunkPayloadBytes: 180 })[0], 0).drop === 'too-many-partials'
  // Expiry frees the slot.
  const afterExpiry = r.push(chunkFrame(new Uint8Array(400), { tag: 3, chunkPayloadBytes: 180 })[0], 500).pending === true
  const header = parseChunk(chunks[1])
  return drop1 && dup && bound && afterExpiry && header.index === 1 && header.total === 3
})

/* ======================== fakes: Web Bluetooth ======================== */

function fakeBluetoothWorld ({ failFirstConnects = 0 } = {}) {
  const world = {
    writes: [],                 // every chunk written to RX
    connects: 0,
    notifyHandler: null,
    disconnectHandler: null,
    reassembler: createReassembler({}),
    received: []                // frames the fake PERIPHERAL reassembled
  }
  const rxChar = {
    async writeValueWithResponse (chunk) {
      world.writes.push(new Uint8Array(chunk))
      const res = world.reassembler.push(new Uint8Array(chunk), 0)
      if (res.frame) world.received.push(res.frame)
    }
  }
  const txChar = {
    async startNotifications () {},
    addEventListener (name, fn) { if (name === 'characteristicvaluechanged') world.notifyHandler = fn },
    removeEventListener () { world.notifyHandler = null }
  }
  const discChar = {
    async readValue () {
      const bytes = encodeDiscoveryRecord(makeDiscoveryRecord({ deviceIdHash: 'peerhash01', relayCapacity: 3, battery: 0.8 }))
      return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    }
  }
  const service = {
    async getCharacteristic (uuid) {
      if (uuid === SPOTME_GATT.RX_CHAR) return rxChar
      if (uuid === SPOTME_GATT.TX_CHAR) return txChar
      if (uuid === SPOTME_GATT.DISCOVERY_CHAR) return discChar
      throw new Error('unknown characteristic')
    }
  }
  world.failConnects = failFirstConnects > 0
  world.failBudget = failFirstConnects
  const gatt = {
    connected: false,
    async connect () {
      world.connects++
      if (world.failConnects && (world.failBudget < 0 || world.failBudget-- > 0)) {
        throw new Error('scripted gatt failure')
      }
      this.connected = true
      return { getPrimaryService: async (uuid) => { if (uuid !== SPOTME_GATT.SERVICE) throw new Error('no such service'); return service } }
    },
    disconnect () { this.connected = false }
  }
  const device = {
    id: 'fake-device',
    name: 'Fake Peer',
    gatt,
    addEventListener (name, fn) { if (name === 'gattserverdisconnected') world.disconnectHandler = fn },
    removeEventListener () { world.disconnectHandler = null }
  }
  const bluetooth = { requestDevice: async () => device }
  /** The peripheral pushes a frame to the central via TX notifications. */
  world.notifyFrame = (bytes, chunkSize = 180) => {
    for (const chunk of chunkFrame(bytes, { tag: 1, chunkPayloadBytes: chunkSize })) {
      world.notifyHandler?.({ target: { value: new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength) } })
    }
  }
  return { world, bluetooth, device }
}

/* ========================= BLE central transport ========================= */

await checkAsync('BleCentralTransport: contract + honest UNAVAILABLE where Web Bluetooth is absent', async () => {
  const none = createBleCentralTransport({ bluetooth: null })
  assertImplementsITransport(none, 'BleCentralTransport')
  let threw = false
  try { await none.connect() } catch { threw = true }
  return none.supported === false && threw && none.status() === 'failed' &&
    /iOS\/Firefox/.test(none.unavailableReason()) && none.quality().connected === false
})

await checkAsync('BLE: connects via GATT, reads the peer discovery record, sends CHUNKED within MTU', async () => {
  const { world, bluetooth } = fakeBluetoothWorld()
  const clock = createManualClock()
  const discovered = []
  const t = createBleCentralTransport({
    bluetooth, clock, onPeerDiscovery: (r) => discovered.push(r),
    config: { chunkPayloadBytes: 100 }
  })
  await t.connect()
  const envelope = sealed(11)
  await t.send(envelope)
  const wireBytes = new TextEncoder().encode(encodeEnvelope(envelope))
  const mtuOk = world.writes.every((w) => w.byteLength <= 100 + CHUNK_HEADER_BYTES)
  const peripheralGot = world.received.length === 1 &&
    decodeEnvelope(new TextDecoder().decode(world.received[0])).envelopeId === envelope.envelopeId
  return t.status() === 'connected' && t.supported === true &&
    world.writes.length === Math.ceil(wireBytes.byteLength / 100) && mtuOk && peripheralGot &&
    discovered.length === 1 && discovered[0].id === 'peerhash01' &&
    typeof t.quality().latencyMs === 'number'          // GATT writes were timed
})

await checkAsync('BLE: receives notified chunks and emits the reassembled envelope', async () => {
  const { world, bluetooth } = fakeBluetoothWorld()
  const t = createBleCentralTransport({ bluetooth, clock: createManualClock() })
  await t.connect()
  const got = []
  t.receive((envelope, meta) => got.push({ envelope, meta }))
  world.notifyFrame(new TextEncoder().encode(encodeEnvelope(sealed(21, 'bob'))))
  await settle()
  return got.length === 1 && got[0].envelope.ordering.senderClock === 21 &&
    got[0].meta.transport === 'bleCentral'
})

await checkAsync('BLE: reconnects with backoff after gattserverdisconnected — and gives up at the cap', async () => {
  const { world, bluetooth } = fakeBluetoothWorld()
  const clock = createManualClock()
  const t = createBleCentralTransport({
    bluetooth, clock, config: { reconnectBaseMs: 100, reconnectMaxAttempts: 2 }
  })
  await t.connect()
  const connectsBefore = world.connects
  // The peer walks away: the platform fires gattserverdisconnected.
  world.disconnectHandler?.()
  const reconnecting = t.status() === 'reconnecting'
  clock.advance(100)   // first backoff slot
  await settle()
  const reconnected = t.status() === 'connected' && world.connects === connectsBefore + 1

  // Now the peer disappears FOR GOOD: every further gatt.connect fails.
  world.failConnects = true
  world.failBudget = -1            // -1 = fail forever
  world.disconnectHandler?.()
  clock.advance(100); await settle()   // attempt 1 fails → next slot 200ms
  clock.advance(200); await settle()   // attempt 2 fails → cap reached
  clock.advance(1000); await settle()
  const gaveUp = t.status() === 'failed'
  await t.disconnect()
  return reconnecting && reconnected && gaveUp
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive adapters — contract, honesty, protocol')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
