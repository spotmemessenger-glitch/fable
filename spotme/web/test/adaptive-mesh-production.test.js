/**
 * The MESH PRODUCTION LAYER — reliable acks, reputation, discovery, duty
 * cycling, and multi-hop delivery under churn.
 *
 * Topologies are built from mesh engines wired link-to-link in memory: every
 * node runs the REAL engine (seen-sets, acks, reputation, split horizon);
 * only the radio is a function call. The properties pinned:
 *
 *   - multi-hop delivery within TTL, ciphertext BIT-IDENTICAL at arrival
 *     (INV-5 across a whole path, not just one relay);
 *   - end-to-end acks settle the origin's retransmit tracker;
 *   - retransmit-with-cap: a partitioned mesh retries, then reports
 *     exhaustion — never a silent drop;
 *   - node churn: a relay dying mid-conversation is routed around after
 *     the partition heals (store-and-retransmit);
 *   - duplicate suppression under a cyclic topology (no storm);
 *   - misbehaviour (malformed frames, TTL forgery) downgrades the peer;
 *   - MULTIHOP off ⇒ this node originates and delivers but never relays.
 */
import { createManualClock } from '../src/lib/transport-supervisor/clock.js'
import { createMeshEngine } from '../src/lib/transport-supervisor/mesh-engine.js'
import { createAckTracker, makeAckFrame, isAckFrame } from '../src/lib/transport-supervisor/mesh-ack.js'
import {
  createPeerReputation, makeDiscoveryRecord, parseDiscoveryRecord, rssiToLinkQuality, dutyCycleFor, DUTY_CYCLE
} from '../src/lib/transport-supervisor/mesh-peers.js'
import { encodeDiscoveryRecord } from '../src/lib/transport-supervisor/mesh-peers.js'
import { assertNoKeySurface, assertNoSealSurface } from '../src/lib/transport-supervisor/invariants.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ============================ ack tracker ============================ */

check('acks settle tracked frames; unacked frames retransmit on the capped schedule', () => {
  const t = createAckTracker({ config: { baseRetransmitMs: 100, factor: 2, maxAttempts: 3 }, rand: () => 0.5 })
  const frame = { frameId: 'f1' }
  t.track(frame, 0)
  const none = t.due(50).retransmit.length === 0        // not due yet
  const first = t.due(100)                              // attempt 2
  const second = t.due(400)                             // attempt 3 (cap)
  const third = t.due(2000)                             // past cap → exhausted
  return none && first.retransmit.length === 1 && second.retransmit.length === 1 &&
    third.retransmit.length === 0 && third.exhausted.length === 1 && t.pending() === 0
})

check('an ack arriving settles the wait; a second identical ack is a no-op', () => {
  const t = createAckTracker({})
  t.track({ frameId: 'f2' }, 0)
  return t.ackReceived('f2') === true && t.ackReceived('f2') === false && t.pending() === 0
})

check('ack frames carry ONLY routing (frameId + acker id) — INV-4 discipline', () => {
  const a = makeAckFrame({ ackFrameId: 'mf_abc', origin: 'nodeB', ts: 5 })
  assertNoKeySurface(a); assertNoSealSurface(a)
  return isAckFrame(a) && Object.keys(a).sort().join(',') === 'ackFrameId,kind,origin,ts'
})

/* ========================== discovery records ========================== */

check('discovery records encode/parse round-trip; garbage and wrong versions parse to null', () => {
  const rec = makeDiscoveryRecord({ deviceIdHash: 'rotatedhash1', relayCapacity: 5, battery: 0.42 })
  const parsed = parseDiscoveryRecord(encodeDiscoveryRecord(rec))
  return parsed.id === 'rotatedhash1' && parsed.cap === 5 && Math.abs(parsed.bat - 0.42) < 1e-9 &&
    parseDiscoveryRecord(new TextEncoder().encode('garbage')) === null &&
    parseDiscoveryRecord(new TextEncoder().encode(JSON.stringify({ v: 99, id: 'x' }))) === null
})

check('a discovery record refuses raw-identity-sized ids and stays inside the advert budget', () => {
  let longRefused = false
  try { makeDiscoveryRecord({ deviceIdHash: 'x'.repeat(64) }) } catch { longRefused = true }
  const rec = makeDiscoveryRecord({ deviceIdHash: 'shorthash', relayCapacity: 99 })
  return longRefused && rec.cap === 15 && encodeDiscoveryRecord(rec).byteLength <= 128
})

/* ============================= reputation ============================= */

check('reputation: deliveries earn, failures erode, misbehaviour CRATERS, floor holds', () => {
  const r = createPeerReputation({})
  const start = r.score('p1')
  r.delivered('p1', 1); r.delivered('p1', 2)
  const up = r.score('p1')
  r.failed('p1', 3)
  const down = r.score('p1')
  r.misbehaved('p1', 'ttl-forgery', 4)
  const cratered = r.score('p1')
  for (let i = 0; i < 50; i++) r.misbehaved('p1', 'again', 5 + i)
  return up > start && down < up && cratered < down * 0.6 && r.score('p1') >= 0.05 &&
    r.inspect('p1').misbehaviours === 51
})

check('rank orders neighbours best-first and deprioritises the disgraced', () => {
  const r = createPeerReputation({})
  r.delivered('good', 1); r.delivered('good', 2); r.delivered('good', 3)
  r.misbehaved('bad', 'malformed-frame', 1); r.misbehaved('bad', 'malformed-frame', 2)
  const order = r.rank(['bad', 'unknown', 'good'])
  return order[0] === 'good' && order[order.length - 1] === 'bad'
})

/* =========================== rssi + duty cycle =========================== */

check('RSSI maps to link quality: strong→1, out-of-range→0, hidden→neutral 0.5', () => {
  return rssiToLinkQuality(-45) === 1 && rssiToLinkQuality(-100) === 0 &&
    rssiToLinkQuality(null) === 0.5 &&
    rssiToLinkQuality(-72.5) > 0.4 && rssiToLinkQuality(-72.5) < 0.6
})

check('duty cycle: engaged+healthy scans hard; low battery throttles; critical is receive-only; unknown is conservative', () => {
  return dutyCycleFor({ batteryLevel: 0.9, batteryKnown: true, engaged: true }) === DUTY_CYCLE.active &&
    dutyCycleFor({ batteryLevel: 0.2, batteryKnown: true }) === DUTY_CYCLE.low &&
    dutyCycleFor({ batteryLevel: 0.1, batteryKnown: true }).receiveOnly === true &&
    dutyCycleFor({}) === DUTY_CYCLE.background &&
    dutyCycleFor({ charging: true, engaged: true }) === DUTY_CYCLE.active
})

/* ======================= topologies of real engines ======================= */

/**
 * Build a mesh of REAL engines. `edges` are bidirectional peer pairs. Links
 * deliver asynchronously through the shared manual clock (1ms per hop), so
 * propagation is observable and ordered.
 */
function buildMesh (clock, nodeIds, edges, opts = {}) {
  const nodes = new Map()
  for (const id of nodeIds) {
    const delivered = []
    const exhausted = []
    const engine = createMeshEngine({
      selfId: id,
      clock,
      onDeliver: (frame, meta) => delivered.push({ frame, meta }),
      onExhausted: (frame) => exhausted.push(frame),
      config: { tickMs: 500, ...(opts.config || {}) },
      battery: opts.battery
    })
    nodes.set(id, { id, engine, delivered, exhausted, detachers: new Map() })
  }
  const link = (aId, bId) => {
    const a = nodes.get(aId); const b = nodes.get(bId)
    const unA = a.engine.attachLink(bId, { send: (obj) => { clock.setTimeout(() => b.engine.receiveFrom(aId, obj), 1) } })
    const unB = b.engine.attachLink(aId, { send: (obj) => { clock.setTimeout(() => a.engine.receiveFrom(bId, obj), 1) } })
    a.detachers.set(bId, unA)
    b.detachers.set(aId, unB)
  }
  const unlink = (aId, bId) => {
    nodes.get(aId)?.detachers.get(bId)?.()
    nodes.get(bId)?.detachers.get(aId)?.()
  }
  for (const [a, b] of edges) link(a, b)
  return { nodes, link, unlink }
}

check('MULTI-HOP: a frame crosses a 4-hop line within TTL, ciphertext BIT-IDENTICAL, ack settles the origin', () => {
  const clock = createManualClock()
  const { nodes } = buildMesh(clock, ['A', 'B', 'C', 'D', 'E'],
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E']])
  const payload = new Uint8Array([9, 8, 7, 6, 5, 4])
  const sent = nodes.get('A').engine.originate(payload)
  clock.advance(50)   // hops propagate, acks flood home
  const atE = nodes.get('E').delivered
  const okBits = atE.length === 1 &&
    atE[0].frame.payload instanceof Uint8Array &&
    atE[0].frame.payload.length === payload.length &&
    atE[0].frame.payload.every((v, i) => v === payload[i]) &&
    atE[0].frame.frameId === sent.frameId &&
    atE[0].frame.hop === 3   // forwarded by B, C, D — three hops taken when E hears it
  const ackSettled = nodes.get('A').engine.stats().awaitingAck === 0
  return okBits && ackSettled
})

check('DUPLICATE SUPPRESSION: a cyclic topology floods once per node — no storm', () => {
  const clock = createManualClock()
  // A ring with a chord: plenty of duplicate paths.
  const { nodes } = buildMesh(clock, ['A', 'B', 'C', 'D'],
    [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'A'], ['A', 'C']])
  nodes.get('A').engine.originate('b64payload')
  clock.advance(100)
  // Every OTHER node delivered exactly once despite multiple arrival paths.
  const once = ['B', 'C', 'D'].every((id) => nodes.get(id).delivered.length === 1)
  const aNothing = nodes.get('A').delivered.length === 0   // own frame never re-delivered
  return once && aNothing
})

check('CHURN + PARTITION HEAL: a dead relay is survived via retransmit once a path returns', () => {
  const clock = createManualClock()
  const { nodes, link, unlink } = buildMesh(clock, ['A', 'B', 'C'], [['A', 'B'], ['B', 'C']],
    { config: { tickMs: 500 } })
  // B dies BEFORE A originates: the frame reaches nobody.
  unlink('A', 'B'); unlink('B', 'C')
  nodes.get('A').engine.originate('sealed-bytes-xyz')
  clock.advance(1000)
  const nothingYet = nodes.get('C').delivered.length === 0
  // Heal: a NEW relay D appears bridging A↔C (B stays dead).
  nodes.get('A').engine.attachLink('D', { send: () => {} })   // placeholder replaced below
  // Build D as a real node joined to both sides.
  const dDelivered = []
  const dEngine = createMeshEngine({ selfId: 'D', clock, onDeliver: (f, m) => dDelivered.push({ f, m }), config: { tickMs: 500 } })
  nodes.get('A').engine.detachLink('D')
  nodes.get('A').engine.attachLink('D', { send: (obj) => { clock.setTimeout(() => dEngine.receiveFrom('A', obj), 1) } })
  dEngine.attachLink('A', { send: (obj) => { clock.setTimeout(() => nodes.get('A').engine.receiveFrom('D', obj), 1) } })
  dEngine.attachLink('C', { send: (obj) => { clock.setTimeout(() => nodes.get('C').engine.receiveFrom('D', obj), 1) } })
  nodes.get('C').engine.attachLink('D', { send: (obj) => { clock.setTimeout(() => dEngine.receiveFrom('C', obj), 1) } })
  // The origin's retransmit ticks re-flood the unacked frame over the new link.
  nodes.get('A').engine.start()
  clock.advance(10_000)
  nodes.get('A').engine.stop()
  const healed = nodes.get('C').delivered.length === 1
  const ackSettled = nodes.get('A').engine.stats().awaitingAck === 0
  void link
  return nothingYet && healed && ackSettled && clock.pending === 0
})

check('EXHAUSTION: a permanently partitioned frame retries to the cap then surfaces — never silent', () => {
  const clock = createManualClock()
  const { nodes } = buildMesh(clock, ['A'], [], { config: { tickMs: 500 } })
  nodes.get('A').engine.start()
  nodes.get('A').engine.originate('unreachable-payload')
  clock.advance(15 * 60_000)   // fifteen minutes alone
  nodes.get('A').engine.stop()
  return nodes.get('A').exhausted.length === 1 && nodes.get('A').engine.stats().awaitingAck === 0
})

check('MISBEHAVIOUR: malformed frames and TTL forgery downgrade the offending link', () => {
  const clock = createManualClock()
  const { nodes } = buildMesh(clock, ['A'], [])
  const a = nodes.get('A').engine
  a.attachLink('evil', { send: () => {} })
  a.receiveFrom('evil', { not: 'a frame' })
  a.receiveFrom('evil', { frameId: 'x', origin: 'evil', seq: 0, payload: 'p', ttl: 700, hop: 0 })   // ttl forgery
  const rep = a.reputation.inspect('evil')
  return rep.misbehaviours === 2 && rep.score < 0.3 &&
    a.stats().misbehaviour === 2 && nodes.get('A').delivered.length === 0
})

check('REPUTATION ROUTES: forwarding fans out to the best neighbours first, bounded by fanout', () => {
  const clock = createManualClock()
  const { nodes } = buildMesh(clock, ['HUB', 'S', 'G1', 'G2', 'BAD'],
    [['HUB', 'S'], ['HUB', 'G1'], ['HUB', 'G2'], ['HUB', 'BAD']],
    { config: { relayFanout: 2, tickMs: 500 } })
  const hub = nodes.get('HUB').engine
  hub.reputation.delivered('G1', 1); hub.reputation.delivered('G1', 2)
  hub.reputation.delivered('G2', 1)
  hub.reputation.misbehaved('BAD', 'malformed-frame', 1)
  // S originates; HUB relays to its best 2 neighbours (G1, G2) — not BAD.
  nodes.get('S').engine.originate('payload-x')
  clock.advance(50)
  return nodes.get('G1').delivered.length === 1 && nodes.get('G2').delivered.length === 1 &&
    nodes.get('BAD').delivered.length === 0
})

check('MULTIHOP OFF (relayFanout 0): the node delivers and acks but NEVER relays', () => {
  const clock = createManualClock()
  const { nodes } = buildMesh(clock, ['A', 'M', 'C'], [['A', 'M'], ['M', 'C']],
    { config: { relayFanout: 0, tickMs: 500 } })
  nodes.get('A').engine.originate('single-hop-only')
  clock.advance(100)
  // M (one hop) delivered; C (would need M to relay) did not.
  return nodes.get('M').delivered.length === 1 && nodes.get('C').delivered.length === 0
})

check('duty schedule flows from the injected battery reading', () => {
  const clock = createManualClock()
  let battery = { batteryLevel: 0.9, batteryKnown: true, engaged: true }
  const engine = createMeshEngine({
    selfId: 'A', clock, onDeliver: () => {}, battery: () => battery
  })
  const active = engine.dutySchedule() === DUTY_CYCLE.active
  battery = { batteryLevel: 0.05, batteryKnown: true }
  const critical = engine.dutySchedule().receiveOnly === true
  return active && critical
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive mesh production — acks, reputation, churn, duty')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
