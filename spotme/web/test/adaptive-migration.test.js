/**
 * SEAMLESS MIGRATION — make-before-break, and a conversation that cannot tell.
 *
 * The centrepiece is the SESSION-CONTINUITY run: one sender streams a
 * conversation while the carrying transport is switched BLE → LAN → relay
 * mid-stream, with scripted latency/loss on every leg, in-flight envelopes at
 * every switch, and deliberate duplicate delivery. The receiver must observe
 * EXACTLY the sent sequence: zero loss, zero duplicates, zero reordering.
 * That is the G2 gate from the WS4 design, executed rather than promised.
 */
import { createManualClock } from '../src/lib/transport-supervisor/clock.js'
import {
  createReceivePipeline, createInFlightTracker, createMigrationExecutor
} from '../src/lib/transport-supervisor/migration.js'
import { makeSealedEnvelope } from '../src/lib/transport-supervisor/envelope.js'
import { makeOrderingToken } from '../src/lib/transport-supervisor/ordering.js'
import { assertNoKeySurface, assertNoSealSurface } from '../src/lib/transport-supervisor/invariants.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const env = (n, origin = 'alice') => makeSealedEnvelope({
  roomId: 'room-1',
  origin,
  ciphertext: `c1ph3r-${origin}-${n}`,
  ordering: makeOrderingToken({ senderClock: n, origin })
})

/* ========================= the receive pipeline ========================= */

check('the pipeline delivers exactly once, in senderClock order, whatever arrives', () => {
  const got = []
  const p = createReceivePipeline({ deliver: (e) => got.push(e.ordering.senderClock) })
  // Arrival order 2,1,1(dup),4,3 → release order 1,2,3,4.
  p.accept(env(2)); p.accept(env(1)); p.accept(env(1)); p.accept(env(4)); p.accept(env(3))
  const s = p.stats()
  return got.join(',') === '1,2,3,4' && s.duplicates === 1 && s.delivered === 4
})

check('a gap HOLDS later envelopes until it fills — and pending() reports the hold', () => {
  const got = []
  const p = createReceivePipeline({ deliver: (e) => got.push(e.ordering.senderClock) })
  p.accept(env(1)); p.accept(env(3)); p.accept(env(4))
  const heldAt = got.join(',')
  const pendingDuringGap = p.pending('alice')
  p.accept(env(2))
  return heldAt === '1' && pendingDuringGap === 2 && got.join(',') === '1,2,3,4'
})

check('envelopes without an ordering token still dedup and deliver', () => {
  const got = []
  const p = createReceivePipeline({ deliver: (e) => got.push(e.envelopeId) })
  const bare = makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: 'xyz' })
  const first = p.accept(bare).status
  const second = p.accept(bare).status
  return first === 'delivered' && second === 'duplicate' && got.length === 1
})

check('pipeline objects carry no key or crypto surface (INV-1/INV-3)', () => {
  const p = createReceivePipeline({ deliver: () => {} })
  assertNoKeySurface(p); assertNoSealSurface(p)
  const t = createInFlightTracker()
  assertNoKeySurface(t); assertNoSealSurface(t)
  return true
})

/* ========================== in-flight tracking ========================== */

check('the tracker owes exactly the unacked, per transport', () => {
  const t = createInFlightTracker()
  t.sent(env(1), 'ble', 0)
  t.sent(env(2), 'ble', 1)
  t.sent(env(3), 'lan', 2)
  t.acked(env(2).envelopeId)
  const bleOwed = t.unacked('ble').map((e) => e.envelope.ordering.senderClock)
  return bleOwed.join(',') === '1' && t.unacked().length === 2 && t.size === 2
})

/* ======================= the migration executor ======================= */

/** A scripted fake transport: per-send latency, scripted drops, a wire tap. */
function fakeTransport (name, clock, { latencyMs = 5, dropEvery = 0 } = {}) {
  let handler = null
  let sends = 0
  const delivered = []            // envelopes that "crossed the wire"
  return {
    entry: null,                  // registry-shaped { name, transport } set below
    name,
    connected: false,
    delivered,
    async connect () { this.connected = true },
    async disconnect () { this.connected = false },
    async send (envelope) {
      sends++
      if (dropEvery > 0 && sends % dropEvery === 0) throw new Error(`${name}: scripted drop`)
      delivered.push(envelope)
      if (handler) {
        // Deliver a copy after scripted latency — like a real wire, possibly
        // AFTER the sender has already switched away.
        clock.setTimeout(() => { if (handler) handler(envelope, { via: name }) }, latencyMs)
      }
      return { accepted: true }
    },
    receive (fn) { handler = fn; return () => { handler = null } },
    quality: () => ({ latencyMs: 5, lossPct: 0, connected: this.connected }),
    costSignal: () => ({ monetary: 0, battery: 0.1, metered: false }),
    capabilities: () => ({}),
    status: () => (this.connected ? 'connected' : 'idle')
  }
}
const entryOf = (t) => ({ name: t.name, transport: t })

await checkAsync('make-before-break: the target connects and attaches BEFORE the old side releases', async () => {
  const clock = createManualClock()
  const inFlight = createInFlightTracker()
  const exec = createMigrationExecutor({ clock, inFlight })
  const got = []
  const pipeline = createReceivePipeline({ deliver: (e) => got.push(e) })
  const a = fakeTransport('a', clock)
  const b = fakeTransport('b', clock)
  const attached = new Map()
  const attach = (entry) => attached.set(entry.name, entry.transport.receive((e, m) => pipeline.accept(e, m)))
  const detach = (entry) => { const un = attached.get(entry.name); attached.delete(entry.name); un?.() }
  await a.connect(); attach(entryOf(a))

  const report = await exec.execute({
    from: entryOf(a), to: entryOf(b), attach, detach,
    resend: (envelope, target) => target.transport.send(envelope)
  })
  // Old transport still attached through the grace window…
  const stillAttached = attached.has('a') && attached.has('b')
  clock.advance(6000)   // grace elapses
  const released = !attached.has('a') && attached.has('b')
  return report.released === true && b.connected === true && stillAttached && released &&
    typeof report.connectMs === 'number' && report.failed == null
})

await checkAsync('in-flight envelopes are RE-QUEUED to the new transport and dedup absorbs the overlap', async () => {
  const clock = createManualClock()
  const inFlight = createInFlightTracker()
  const exec = createMigrationExecutor({ clock, inFlight })
  const got = []
  const pipeline = createReceivePipeline({ deliver: (e) => got.push(e.ordering.senderClock) })
  const a = fakeTransport('a', clock, { latencyMs: 50 })   // slow wire: deliveries straggle
  const b = fakeTransport('b', clock)
  const attached = new Map()
  const attach = (entry) => attached.set(entry.name, entry.transport.receive((e, m) => pipeline.accept(e, m)))
  const detach = (entry) => { const un = attached.get(entry.name); attached.delete(entry.name); un?.() }
  await a.connect(); attach(entryOf(a))

  // Three sends left on A, none acked; their deliveries are still in the air.
  for (const n of [1, 2, 3]) { await a.send(env(n)); inFlight.sent(env(n), 'a', clock.now()) }

  const report = await exec.execute({
    from: entryOf(a), to: entryOf(b), attach, detach,
    resend: (envelope, target) => target.transport.send(envelope)
  })
  // Let A's slow stragglers AND B's re-sends both land.
  clock.advance(10_000)
  const s = pipeline.stats()
  return report.requeued === 3 && report.resent === 3 &&
    got.join(',') === '1,2,3' &&          // exactly once, in order
    s.duplicates === 3                    // the overlap existed and was absorbed
})

await checkAsync('a target that cannot connect FAILS the switch and the incumbent stands', async () => {
  const clock = createManualClock()
  const inFlight = createInFlightTracker()
  const exec = createMigrationExecutor({ clock, inFlight, config: { connectTimeoutMs: 200 } })
  const a = fakeTransport('a', clock)
  const dead = fakeTransport('dead', clock)
  dead.connect = () => new Promise(() => {})   // hangs forever
  await a.connect()
  const attached = new Map()
  const attach = (entry) => attached.set(entry.name, true)
  const detach = (entry) => attached.delete(entry.name)
  attach(entryOf(a))
  const p = exec.execute({ from: entryOf(a), to: entryOf(dead), attach, detach, resend: null })
  clock.advance(300)
  const report = await p
  return /connect/.test(report.failed || '') && report.released === false &&
    attached.has('a') && !attached.has('dead')
})

/* ================== THE SESSION-CONTINUITY GATE (G2) ================== */

await checkAsync('a conversation crossing BLE → LAN → relay arrives with ZERO loss, dupes, or reorder', async () => {
  const clock = createManualClock()
  const inFlight = createInFlightTracker()
  const exec = createMigrationExecutor({ clock, inFlight })
  const got = []
  const pipeline = createReceivePipeline({ deliver: (e) => got.push(e.ordering.senderClock) })

  // Three legs with different personalities: BLE slow + lossy, LAN fast,
  // relay medium + occasionally dropping.
  const ble = fakeTransport('ble', clock, { latencyMs: 120, dropEvery: 4 })
  const lan = fakeTransport('lan', clock, { latencyMs: 3 })
  const relay = fakeTransport('relay', clock, { latencyMs: 40, dropEvery: 7 })
  const attached = new Map()
  const attach = (entry) => attached.set(entry.name, entry.transport.receive((e, m) => pipeline.accept(e, m)))
  const detach = (entry) => { const un = attached.get(entry.name); attached.delete(entry.name); un?.() }

  await ble.connect(); attach(entryOf(ble))
  let current = ble

  // The sender: ack-or-retry over whatever transport is current. A scripted
  // drop re-queues the same envelopeId — never a new one.
  const TOTAL = 60
  const sendWithRetry = async (envelope) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await current.send(envelope)
        inFlight.sent(envelope, current.name, clock.now())
        return
      } catch { clock.advance(10) }
    }
    throw new Error('sender exhausted retries')
  }

  const switchTo = async (target) => {
    const from = entryOf(current)
    const report = await exec.execute({
      from, to: entryOf(target), attach, detach,
      resend: (envelope, t) => t.transport.send(envelope)
    })
    // A CONNECT failure keeps the incumbent; a RESEND failure is DEGRADED —
    // the switch stands and whatever the executor could not resend is still
    // owed (in-flight, old transport). Production's outbox drain re-sends it;
    // this harness plays that role explicitly.
    if (report.failed && report.connectMs == null) throw new Error(`switch failed: ${report.failed}`)
    current = target
    for (const entry of inFlight.unacked(from.name)) {
      await sendWithRetry(entry.envelope)
    }
  }

  for (let n = 1; n <= TOTAL; n++) {
    await sendWithRetry(env(n))
    clock.advance(30)
    if (n === 20) await switchTo(lan)     // mid-stream, in-flight BLE stragglers
    if (n === 40) await switchTo(relay)   // and again
  }
  clock.advance(20_000)   // every wire drains, every grace elapses

  const expected = Array.from({ length: TOTAL }, (_, i) => i + 1).join(',')
  const s = pipeline.stats()
  return got.join(',') === expected &&        // zero loss, zero reorder, exactly once
    s.duplicates > 0 &&                       // overlap really happened (re-queues + stragglers)
    attached.size === 1 && attached.has('relay')
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive migration — make-before-break, session continuity')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
