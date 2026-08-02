/**
 * Adaptive network BENCHMARKS — p50/p95/p99 for the paths that run per tick,
 * per send, and per mesh frame. ADR-012b §benchmarks.
 *
 * Everything runs on the manual clock with deterministic fakes: these are
 * CPU-cost benchmarks of the production logic (the numbers a phone's main
 * thread pays), not network measurements — the ADR-012 §11 discipline of
 * naming the environment before the number. Run:
 *
 *   node test/bench/adaptive-network.bench.mjs
 *
 * Prints environment + a table; exits non-zero only on a harness error, so
 * CI can run it for drift visibility without flaking on machine speed.
 */
import { cpus, totalmem } from 'node:os'
import { createManualClock } from '../../src/lib/transport-supervisor/clock.js'
import { createSupervisor } from '../../src/lib/transport-supervisor/supervisor.js'
import { createTransportRegistry } from '../../src/lib/transport-supervisor/registry.js'
import { CAPABILITY_MATRIX } from '../../src/lib/transport-supervisor/capabilities.js'
import { scoreAll } from '../../src/lib/transport-supervisor/selection.js'
import { makeQualitySample, makeCostSignal } from '../../src/lib/transport-supervisor/ITransport.js'
import { createReceivePipeline, createInFlightTracker, createMigrationExecutor } from '../../src/lib/transport-supervisor/migration.js'
import { createDedupWindow, makeSealedEnvelope } from '../../src/lib/transport-supervisor/envelope.js'
import { makeOrderingToken } from '../../src/lib/transport-supervisor/ordering.js'
import { createMeshEngine } from '../../src/lib/transport-supervisor/mesh-engine.js'

const now = () => performance.now()

function percentiles (samples) {
  const s = [...samples].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99), max: s[s.length - 1] }
}

const fmt = (ms) => ms >= 1 ? `${ms.toFixed(2)}ms` : `${(ms * 1000).toFixed(1)}µs`
const rows = []
function report (name, samples, unit = 'op') {
  const p = percentiles(samples)
  rows.push({ name, unit, ...p })
}

const env = (n, origin = 'alice') => makeSealedEnvelope({
  roomId: 'room-1', origin, ciphertext: `sealed-${origin}-${n}`,
  ordering: makeOrderingToken({ senderClock: n, origin })
})

/* ------------------------------------------------ ranking: scoreAll N=8 --- */
{
  const candidates = Array.from({ length: 8 }, (_, i) => ({
    name: `t${i}`,
    capabilities: Object.values(CAPABILITY_MATRIX)[i % 4],
    quality: makeQualitySample({ connected: true, latencyMs: 40 + i * 30, lossPct: (i % 5) / 20 }),
    cost: makeCostSignal({ battery: (i % 4) / 10 })
  }))
  const samples = []
  for (let i = 0; i < 20_000; i++) {
    const t0 = now()
    scoreAll(candidates, { noInternet: i % 7 === 0, batterySaver: i % 3 === 0 })
    samples.push(now() - t0)
  }
  report('ranking scoreAll (8 candidates)', samples)
}

/* ------------------------------------------- supervisor tick (full loop) --- */
{
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const mk = (name, caps) => ({
    name,
    connect: async () => {}, disconnect: async () => {},
    send: async () => ({ accepted: true }), receive: () => () => {},
    quality: () => makeQualitySample({ connected: true, latencyMs: 60 + (Math.sin(clock.now() / 1000) + 1) * 40, lossPct: 0 }),
    costSignal: () => makeCostSignal({}),
    capabilities: () => caps,
    status: () => 'connected'
  })
  const names = Object.keys(CAPABILITY_MATRIX)
  for (const n of names) registry.register(n, { transport: mk(n, CAPABILITY_MATRIX[n]), capabilities: CAPABILITY_MATRIX[n] })
  const supervisor = createSupervisor({ registry, clock, isOnline: () => true, deliver: () => {} })
  await supervisor.start()
  const samples = []
  for (let i = 0; i < 10_000; i++) {
    const t0 = now()
    supervisor.monitor.tick()
    samples.push(now() - t0)
    clock.advance(2000)
  }
  supervisor.stop()
  report('supervisor tick (sample+health+predict+decide enqueue, 4 transports)', samples)
}

/* ----------------------------------------------------- migration handoff --- */
{
  const clock = createManualClock()
  const samples = []
  for (let i = 0; i < 2_000; i++) {
    const inFlight = createInFlightTracker()
    const exec = createMigrationExecutor({ clock, inFlight })
    const pipeline = createReceivePipeline({ deliver: () => {} })
    const mk = (name) => {
      let handler = null
      return {
        name,
        transport: {
          connect: async () => {}, disconnect: async () => {},
          send: async () => ({ accepted: true }),
          receive: (fn) => { handler = fn; return () => { handler = null } },
          get _h () { return handler }
        }
      }
    }
    const a = mk('a'); const b = mk('b')
    const attach = (e) => e.transport.receive((x, m) => pipeline.accept(x, m))
    const detach = () => {}
    attach(a)
    for (let k = 1; k <= 5; k++) inFlight.sent(env(i * 10 + k), 'a', clock.now())
    const t0 = now()
    await exec.execute({ from: a, to: b, attach, detach, resend: (e2, t) => t.transport.send(e2) })
    samples.push(now() - t0)
    clock.advance(10_000)
  }
  report('migration handoff (connect+attach+resend 5 in-flight)', samples)
}

/* ------------------------------------------------- mesh convergence N=25 --- */
{
  // A 5×5 grid, corner to corner: how long until delivery + ack settle,
  // in simulated ms and in real CPU ms per full convergence.
  const cpuSamples = []
  let simMs = 0
  for (let run = 0; run < 200; run++) {
    const clock = createManualClock()
    const nodes = new Map()
    const N = 5
    const id = (r, c) => `n${r}x${c}`
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const delivered = []
        // ttl 12: corner→corner needs 8 hops, and the engine's TTL-forgery
        // guard drops any frame claiming more than the PROTOCOL max — so the
        // protocol max itself must cover the diameter. (The default 7 suits
        // proximity clusters; a wider mesh raises it deliberately.)
        const engine = createMeshEngine({ selfId: id(r, c), clock, onDeliver: (f) => delivered.push(f), config: { tickMs: 500, ttl: 12 } })
        nodes.set(id(r, c), { engine, delivered })
      }
    }
    const link = (x, y) => {
      const a = nodes.get(x); const b = nodes.get(y)
      a.engine.attachLink(y, { send: (o) => clock.setTimeout(() => b.engine.receiveFrom(x, o), 1) })
      b.engine.attachLink(x, { send: (o) => clock.setTimeout(() => a.engine.receiveFrom(y, o), 1) })
    }
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        if (c + 1 < N) link(id(r, c), id(r, c + 1))
        if (r + 1 < N) link(id(r, c), id(r + 1, c))
      }
    }
    const t0 = now()
    nodes.get('n0x0').engine.originate('payload-bytes', { ttl: 10 })
    let elapsed = 0
    while (nodes.get('n4x4').delivered.length === 0 && elapsed < 1000) { clock.advance(1); elapsed++ }
    if (nodes.get('n4x4').delivered.length === 0) throw new Error('bench harness: grid never converged')
    cpuSamples.push(now() - t0)
    simMs += elapsed
  }
  report('mesh convergence 25-node grid corner→corner (CPU per run)', cpuSamples)
  rows.push({ name: 'mesh convergence 25-node grid (SIMULATED radio ms, mean)', unit: 'sim', n: 200, p50: simMs / 200, p95: simMs / 200, p99: simMs / 200, max: simMs / 200 })
}

/* -------------------------------------------- dedup + ordering under churn --- */
{
  const pipeline = createReceivePipeline({ deliver: () => {}, dedupCapacity: 8192 })
  const samples = []
  let n = 1
  for (let i = 0; i < 100_000; i++) {
    const dup = i % 3 === 0
    const e = env(dup ? Math.max(1, n - 1) : n++)
    const t0 = now()
    pipeline.accept(e)
    samples.push(now() - t0)
  }
  report('receive pipeline accept (dedup+reorder, 33% duplicates)', samples)
}

{
  const w = createDedupWindow({ capacity: 4096 })
  const samples = []
  for (let i = 0; i < 200_000; i++) {
    const t0 = now()
    w.accept(`env_${i % 6000}`)
    samples.push(now() - t0)
  }
  report('dedup window accept (rolling eviction)', samples)
}

/* ------------------------------------------------------------- outbox drain --- */
{
  const { createMemoryOutbox } = await import('../../src/lib/transport-supervisor/outbox.js')
  const { createOutboxDrainer } = await import('../../src/lib/transport-supervisor/drain.js')
  const { QOS } = await import('../../src/lib/transport-supervisor/qos.js')
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  const accepted = new Set()
  const sup = { async send (e) { accepted.add(e.envelopeId); return { accepted: true } }, acked () {} }
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  for (let i = 1; i <= 2000; i++) drain.submit(env(i, 'bench'), QOS.MESSAGE)
  const samples = []
  let guard = 0
  while (outbox.size > 0 && guard++ < 10_000) {
    const t0 = now()
    await drain.kick()
    samples.push(now() - t0)
    clock.advance(30_000)
    for (const id of accepted) drain.acked(id)   // ack only what genuinely sent
    accepted.clear()
  }
  if (outbox.size > 0) throw new Error('bench harness: backlog never drained')
  report('outbox drain pass (window-bounded wave over 2k backlog)', samples)
}

/* ---------------------------------------------------------------- report --- */
console.log('\nadaptive-network bench — environment:')
console.log(`  node ${process.version} · ${cpus()[0]?.model?.trim() || 'unknown cpu'} ×${cpus().length} · ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM`)
console.log(`  deterministic fakes, manual clock; CPU cost of production logic only\n`)
const pad = (s, n) => String(s).padEnd(n)
console.log(pad('benchmark', 66) + pad('n', 8) + pad('p50', 10) + pad('p95', 10) + pad('p99', 10) + 'max')
for (const r of rows) {
  console.log(pad(r.name, 66) + pad(r.n, 8) + pad(fmt(r.p50), 10) + pad(fmt(r.p95), 10) + pad(fmt(r.p99), 10) + fmt(r.max))
}
console.log('')
