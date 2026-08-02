/**
 * LONG-DURATION / STRESS — simulated hours, thousands of envelopes, bounded
 * memory.
 *
 * The manual clock makes "six hours" a loop, not a soak. What is pinned:
 *
 *   - the supervisor rides SIX SIMULATED HOURS of noisy quality without a
 *     single spurious switch, and its event log stays at its bound;
 *   - 5,000 envelopes cross the receive pipeline with churned arrival
 *     (duplicates + reordering) and come out exactly-once, in order, while
 *     the dedup window respects its capacity;
 *   - a 5,000-envelope offline backlog drains completely once a transport
 *     appears, with the congestion window bounding every wave;
 *   - mesh seen-sets, ack trackers, and reassembler partials hold their
 *     bounds under flood, replay, and garbage.
 */
import { createManualClock } from '../src/lib/transport-supervisor/clock.js'
import { createSupervisor } from '../src/lib/transport-supervisor/supervisor.js'
import { createTransportRegistry } from '../src/lib/transport-supervisor/registry.js'
import { CAPABILITY_MATRIX } from '../src/lib/transport-supervisor/capabilities.js'
import { makeQualitySample, makeCostSignal } from '../src/lib/transport-supervisor/ITransport.js'
import { createReceivePipeline } from '../src/lib/transport-supervisor/migration.js'
import { createDedupWindow, makeSealedEnvelope } from '../src/lib/transport-supervisor/envelope.js'
import { makeOrderingToken } from '../src/lib/transport-supervisor/ordering.js'
import { createMemoryOutbox } from '../src/lib/transport-supervisor/outbox.js'
import { createOutboxDrainer } from '../src/lib/transport-supervisor/drain.js'
import { QOS } from '../src/lib/transport-supervisor/qos.js'
import { createSeenSet } from '../src/lib/transport-supervisor/mesh.js'
import { createMeshEngine } from '../src/lib/transport-supervisor/mesh-engine.js'
import { createReassembler, chunkFrame } from '../src/lib/transport-supervisor/adapters/ble-chunking.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Deterministic PRNG so "noise" is reproducible run to run. */
function mulberry32 (seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const env = (n, origin = 'alice') => makeSealedEnvelope({
  roomId: 'room-1', origin, ciphertext: `sealed-${origin}-${n}`,
  ordering: makeOrderingToken({ senderClock: n, origin })
})

/* ================= six hours of noise, zero spurious switches ================= */

await checkAsync('SIX SIMULATED HOURS of jitter: zero spurious switches, event log bounded', async () => {
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const rand = mulberry32(0xC0FFEE)
  const mk = (name) => {
    let q = makeQualitySample({ connected: true, latencyMs: 80, lossPct: 0 })
    return {
      name,
      connect: async () => {},
      disconnect: async () => {},
      send: async () => ({ accepted: true }),
      receive: () => () => {},
      quality: () => q,
      costSignal: () => makeCostSignal({}),
      capabilities: () => CAPABILITY_MATRIX.socketio,
      status: () => 'connected',
      _set: (x) => { q = makeQualitySample(x) }
    }
  }
  const a = mk('alpha'); const b = mk('beta')
  registry.register('alpha', { transport: a, capabilities: CAPABILITY_MATRIX.socketio })
  registry.register('beta', { transport: b, capabilities: CAPABILITY_MATRIX.socketio })
  const supervisor = createSupervisor({
    registry, clock, isOnline: () => true, deliver: () => {}, config: { logCapacity: 128 }
  })
  await supervisor.start()
  await tick()
  const chosen = supervisor.current()
  // 6 hours at one decision per 2s tick = 10,800 decisions, latency wobbling
  // ±20ms around the same mean on both links.
  const HOURS = 6
  for (let i = 0; i < (HOURS * 3600) / 2; i++) {
    a._set({ connected: true, latencyMs: 70 + rand() * 40, lossPct: 0 })
    b._set({ connected: true, latencyMs: 70 + rand() * 40, lossPct: 0 })
    clock.advance(2000)
    if (i % 500 === 0) await tick()   // let the decision chain drain periodically
  }
  await tick()
  supervisor.stop()
  const migrations = supervisor.events().filter((e) => e.type === 'migration')
  return supervisor.current() === chosen && migrations.length <= 1 &&
    supervisor.events().length <= 128 && clock.pending === 0
})

/* ============ 5,000 envelopes, churned arrival, exactly-once ============ */

check('5,000 envelopes with duplicates + reorder release exactly-once, in order', () => {
  const rand = mulberry32(0xBEEF)
  const got = []
  const pipeline = createReceivePipeline({ deliver: (e) => got.push(e.ordering.senderClock), dedupCapacity: 8192 })
  const N = 5000
  // Build a churned arrival schedule: every envelope appears 1–3 times, and
  // each copy is displaced up to 20 positions from its natural slot.
  const arrivals = []
  for (let n = 1; n <= N; n++) {
    const copies = 1 + Math.floor(rand() * 3)
    for (let c = 0; c < copies; c++) {
      arrivals.push({ n, at: n * 10 + Math.floor(rand() * 200) - 100 })
    }
  }
  arrivals.sort((x, y) => x.at - y.at)
  for (const a of arrivals) pipeline.accept(env(a.n))
  const s = pipeline.stats()
  const inOrder = got.every((v, i) => v === i + 1)
  return got.length === N && inOrder && s.duplicates === arrivals.length - N && s.received === arrivals.length
})

check('the dedup window NEVER exceeds its capacity, even under a replay flood', () => {
  const w = createDedupWindow({ capacity: 1024 })
  for (let i = 0; i < 50_000; i++) w.accept(`env_${i % 20_000}`)
  return w.size <= 1024
})

/* ================= offline backlog drains completely ================= */

await checkAsync('a 5,000-envelope offline backlog fully drains on reconnect, window-bounded throughout', async () => {
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  let online = false
  let maxBurst = 0
  let inBurst = 0
  const accepted = new Set()   // envelopeIds the transport REALLY accepted
  const sup = {
    async send (envelope) {
      inBurst++
      maxBurst = Math.max(maxBurst, inBurst)
      try {
        if (!online) { const e = new Error('offline'); e.code = 'NO_TRANSPORT'; throw e }
        accepted.add(envelope.envelopeId)
        return { accepted: true }
      } finally {
        inBurst--
      }
    },
    acked () {}
  }
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  const N = 5000
  for (let i = 1; i <= N; i++) drain.submit(env(i), QOS.MESSAGE)
  drain.start()
  clock.advance(30_000)          // offline: persistent backoff, nothing leaves
  await tick()
  const owedOffline = outbox.size === N

  online = true
  // Drain in bounded waves: acked() must fire to release the outbox rows —
  // the harness plays the receiving side confirming every envelopeId.
  for (let round = 0; round < 4000 && outbox.size > 0; round++) {
    clock.advance(30_000)   // 30s steps: clears every backoff class
    await tick()
    // The harness plays the receiving side: it may only ack what the
    // transport GENUINELY accepted — an envelope never sent stays owed.
    for (const id of accepted) drain.acked(id)
    accepted.clear()
  }
  drain.stop()
  const s = drain.stats()
  return owedOffline && outbox.size === 0 && s.acked === N &&
    maxBurst <= 64 &&              // never beyond the AIMD ceiling
    clock.pending === 0
})

/* ===================== mesh + chunking memory bounds ===================== */

check('mesh seen-sets stay bounded under a 100k-frame flood', () => {
  const seen = createSeenSet({ capacity: 2048, ttlMs: 60_000 })
  for (let i = 0; i < 100_000; i++) seen.remember(`mf_${i}`, i)
  return seen.size <= 2048
})

check('a mesh node under sustained flood keeps bounded seen/ack state', () => {
  const clock = createManualClock()
  const engine = createMeshEngine({
    selfId: 'me', clock, onDeliver: () => {},
    config: { seenCapacity: 1024, tickMs: 500 }
  })
  engine.attachLink('peer', { send: () => {} })
  for (let i = 0; i < 20_000; i++) {
    engine.receiveFrom('peer', { frameId: `mf_${i}`, origin: 'them', seq: i, payload: 'x', ttl: 5, hop: 1 })
    if (i % 1000 === 0) clock.advance(500)
  }
  const stats = engine.stats()
  return stats.seen <= 1024 && stats.delivered === 20_000
})

check('the reassembler survives 10,000 garbage + orphan chunks within its partial bound', () => {
  const rand = mulberry32(0x5EED)
  const r = createReassembler({ config: { maxPartials: 8, partialTtlMs: 1000 } })
  for (let i = 0; i < 10_000; i++) {
    if (rand() < 0.5) {
      r.push(new Uint8Array([rand() * 255, rand() * 255]), i)                        // malformed
    } else {
      const orphan = chunkFrame(new Uint8Array(400), { tag: i % 256, chunkPayloadBytes: 180 })[0]
      r.push(orphan, i)                                                              // never completed
    }
  }
  return r.stats().partials <= 8
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive stress — simulated hours, thousands of envelopes, bounded memory')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
