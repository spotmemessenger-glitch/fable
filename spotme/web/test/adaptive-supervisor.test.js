/**
 * The Adaptive Transport Supervisor — estimates, health, monitoring, QoS, and
 * the engine's decisions.
 *
 * Everything runs on the manual clock, so "six ticks of degradation" is six
 * synchronous calls, and "does it flap?" is a counted assertion. Fake
 * transports are deterministic test doubles — the production engine under
 * test is the real one.
 *
 * The two decisions that matter most are pinned hard:
 *   - a NOISY link within the hysteresis margin causes ZERO switches;
 *   - a DEAD incumbent is left immediately, dwell ignored;
 *   - a link TRENDING toward unusable is left BEFORE it dies (prediction).
 * Plus the owner rule as an API property: no user-choice surface exists.
 */
import { createManualClock, withTimeout } from '../src/lib/transport-supervisor/clock.js'
import { createEwma, createTrend, createQualityEstimator } from '../src/lib/transport-supervisor/ewma.js'
import { createHealthTracker, HEALTH } from '../src/lib/transport-supervisor/health-fsm.js'
import { createBatteryReader, BATTERY_POLICY } from '../src/lib/transport-supervisor/battery.js'
import { createMonitor } from '../src/lib/transport-supervisor/monitor.js'
import { QOS, createQosQueue } from '../src/lib/transport-supervisor/qos.js'
import { createSupervisor } from '../src/lib/transport-supervisor/supervisor.js'
import { createTransportRegistry } from '../src/lib/transport-supervisor/registry.js'
import { CAPABILITY_MATRIX, makeCapabilities, RANGE } from '../src/lib/transport-supervisor/capabilities.js'
import { makeQualitySample, makeCostSignal, assertImplementsITransport } from '../src/lib/transport-supervisor/ITransport.js'
import { makeSealedEnvelope } from '../src/lib/transport-supervisor/envelope.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ============================ clock + timeout ============================ */

check('the manual clock fires due timers in order, intervals repeat', () => {
  const clock = createManualClock()
  const fired = []
  clock.setTimeout(() => fired.push('b'), 20)
  clock.setTimeout(() => fired.push('a'), 10)
  const i = clock.setInterval(() => fired.push('i'), 15)
  clock.advance(35)
  clock.clearInterval(i)
  clock.advance(100)
  return fired.join(',') === 'a,i,b,i' && clock.now() === 135 && clock.pending === 0
})

await checkAsync('withTimeout rejects a hung promise with a named TimeoutError, and clears its timer', async () => {
  const clock = createManualClock()
  const hung = new Promise(() => {})
  const p = withTimeout(hung, 50, 'hung thing', clock).then(() => 'resolved', (e) => e)
  clock.advance(60)
  const err = await p
  return err instanceof Error && err.name === 'TimeoutError' && /hung thing timed out after 50ms/.test(err.message) &&
    clock.pending === 0
})

await checkAsync('withTimeout passes a fast promise through and cancels the bound', async () => {
  const clock = createManualClock()
  const v = await withTimeout(Promise.resolve(42), 50, 'fast', clock)
  return v === 42 && clock.pending === 0
})

/* ================================ EWMA ================================ */

check('EWMA smooths: one spike moves the estimate by alpha, not to the spike', () => {
  const e = createEwma({ alpha: 0.3 })
  e.push(100); e.push(100); e.push(100)
  const before = e.value
  e.push(1000)
  return Math.abs(before - 100) < 1e-9 && e.value > 100 && e.value < 500 && e.samples === 4
})

check('trend fits a rising slope and projects forward; <2 points is slope 0', () => {
  const t = createTrend({ window: 8 })
  const empty = t.fit().slope === 0
  for (let i = 0; i < 6; i++) t.push(i * 1000, 100 + i * 50)   // +50 per second
  const { slope } = t.fit()
  const projected = t.projectAt(10_000)
  return empty && Math.abs(slope - 0.05) < 1e-6 && Math.abs(projected - 600) < 1
})

check('the quality estimator tracks latency, jitter, loss and PREDICTS degradation', () => {
  const q = createQualityEstimator({ alpha: 0.5, trendWindow: 10 })
  // Latency climbing steeply: 100 → 1300ms over 6 samples.
  for (let i = 0; i < 6; i++) q.pushLatency(100 + i * 240, i * 1000)
  for (let i = 0; i < 6; i++) q.pushOutcome(true, i * 1000)
  const snap = q.snapshot()
  const pred = q.predict({ now: 6000, horizonMs: 10_000, latencyCeilingMs: 1500 })
  return snap.latencyMs > 100 && snap.jitterMs > 0 && snap.lossPct === 0 && snap.lossKnown === true &&
    pred.degrading === true && pred.reasons.some((r) => /latency-trend/.test(r))
})

check('a flat healthy link predicts NOT degrading', () => {
  const q = createQualityEstimator()
  for (let i = 0; i < 10; i++) { q.pushLatency(80, i * 1000); q.pushOutcome(true, i * 1000) }
  return q.predict({ now: 10_000 }).degrading === false
})

/* ============================ health FSM ============================ */

check('health walks unknown → healthy → degraded → healthy with different bars (hysteresis)', () => {
  const h = createHealthTracker()
  h.observe({ status: 'connected', at: 0 })
  const healthy = h.state(0) === HEALTH.HEALTHY
  h.observe({ quality: { latencyMs: 900, lossPct: 0, lossKnown: true, sampledAt: 1000 }, at: 1000 })
  const degraded = h.state(1000) === HEALTH.DEGRADED
  // 600ms is under the degrade bar (800) but ABOVE the recover bar (500):
  // the state must HOLD degraded, not flap back.
  h.observe({ quality: { latencyMs: 600, lossPct: 0, lossKnown: true, sampledAt: 2000 }, at: 2000 })
  const held = h.state(2000) === HEALTH.DEGRADED
  h.observe({ quality: { latencyMs: 100, lossPct: 0, lossKnown: true, sampledAt: 3000 }, at: 3000 })
  const recovered = h.state(3000) === HEALTH.HEALTHY
  return healthy && degraded && held && recovered
})

check('hard loss ⇒ DOWN; lifecycle failed ⇒ DOWN; unavailable wins over everything', () => {
  const h = createHealthTracker()
  h.observe({ status: 'connected', quality: { latencyMs: 50, lossPct: 0.7, lossKnown: true, sampledAt: 0 }, at: 0 })
  const down = h.state(0) === HEALTH.DOWN && h.selectable(0) === false
  h.observe({ status: 'connected', quality: { latencyMs: 50, lossPct: 0, lossKnown: true, sampledAt: 1 }, at: 1 })
  h.observe({ status: 'failed', at: 2 })
  const downAgain = h.state(2) === HEALTH.DOWN
  h.observe({ unavailableReason: 'iOS blocks Web Bluetooth', at: 3 })
  return down && downAgain && h.state(3) === HEALTH.UNAVAILABLE && /iOS/.test(h.reason())
})

check('a stale health reading decays to UNKNOWN rather than staying confidently healthy', () => {
  const h = createHealthTracker()
  h.observe({ status: 'connected', quality: { latencyMs: 50, lossPct: 0, lossKnown: true, sampledAt: 0 }, at: 0 })
  return h.state(1000) === HEALTH.HEALTHY && h.state(50_000) === HEALTH.UNKNOWN
})

/* ============================== battery ============================== */

await checkAsync('battery: platform absent ⇒ conservative unknown (0.5, not saver)', async () => {
  const b = createBatteryReader({ getBattery: null })
  const r = await b.read()
  const ctx = b.toContext(r)
  return b.supported === false && r.known === false && r.level === 0.5 && ctx.batterySaver === false
})

await checkAsync('battery: a known low discharging level trips batterySaver; charging does not', async () => {
  const mgr = { level: 0.1, charging: false }
  const b = createBatteryReader({ getBattery: async () => mgr })
  const low = b.toContext(await b.read())
  mgr.charging = true
  const charging = b.toContext(await b.read())
  return low.batterySaver === true && charging.batterySaver === false &&
    BATTERY_POLICY.saverBelow === 0.2
})

await checkAsync('battery: a throwing platform API degrades to unknown and is not re-hammered', async () => {
  let calls = 0
  const b = createBatteryReader({ getBattery: async () => { calls++; throw new Error('nope') } })
  await b.read(); await b.read(); await b.read()
  return calls === 1 && (await b.read()).known === false
})

/* ============================== monitor ============================== */

function fakeTransport (name, caps, script = {}) {
  let quality = makeQualitySample({ connected: true, latencyMs: 100, lossPct: 0 })
  let status = 'connected'
  return {
    name,
    connect: async () => {},
    disconnect: async () => {},
    send: async (envelope) => (script.onSend ? script.onSend(envelope) : { accepted: true }),
    receive: (handler) => { script.handler = handler; return () => { script.handler = null } },
    quality: () => (script.throwOnQuality ? (() => { throw new Error('broken transport') })() : quality),
    costSignal: () => makeCostSignal({}),
    capabilities: () => caps,
    status: () => status,
    _set: (q, s) => { if (q) quality = makeQualitySample(q); if (s) status = s },
    _script: script
  }
}

check('the monitor samples on its tick, smooths per transport, and a THROWING transport cannot kill the loop', () => {
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const good = fakeTransport('socketio', CAPABILITY_MATRIX.socketio)
  const bad = fakeTransport('webrtc', CAPABILITY_MATRIX.webrtc, { throwOnQuality: true })
  registry.register('socketio', { transport: good, capabilities: CAPABILITY_MATRIX.socketio })
  registry.register('webrtc', { transport: bad, capabilities: CAPABILITY_MATRIX.webrtc })
  const monitor = createMonitor({ registry, clock })
  monitor.start()
  clock.advance(6_500)   // 3 ticks at 2s
  monitor.stop()
  const snap = monitor.snapshot()
  const goodLane = snap.transports.socketio
  const badLane = snap.transports.webrtc
  return monitor.tickCount === 3 &&
    goodLane.quality.latencyMs === 100 && goodLane.health === HEALTH.HEALTHY &&
    badLane.lastError != null && badLane.health === HEALTH.DOWN &&
    clock.pending === 0
})

check('reportOutcome feeds real send results into loss/latency estimates', () => {
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const t = fakeTransport('socketio', CAPABILITY_MATRIX.socketio)
  registry.register('socketio', { transport: t, capabilities: CAPABILITY_MATRIX.socketio })
  const monitor = createMonitor({ registry, clock })
  monitor.reportOutcome('socketio', { delivered: true, rttMs: 40 })
  monitor.reportOutcome('socketio', { delivered: false })
  const q = monitor.snapshot().transports.socketio.quality
  return q.latencyMs === 40 && q.lossPct > 0 && q.lossKnown === true
})

/* ================================ QoS ================================ */

check('the QoS queue drains strictly by class: call-signal > message > receipt > telemetry', () => {
  const q = createQosQueue({})
  q.enqueue('t', QOS.TELEMETRY, 0)
  q.enqueue('m1', QOS.MESSAGE, 0)
  q.enqueue('r', QOS.RECEIPT, 0)
  q.enqueue('c', QOS.CALL_SIGNAL, 0)
  q.enqueue('m2', QOS.MESSAGE, 0)
  const order = []
  let head
  while ((head = q.dequeue(0))) order.push(head.item)
  return order.join(',') === 'c,m1,m2,r,t'
})

check('stale droppables are shed at dequeue; fresh ones survive', () => {
  const q = createQosQueue({})
  q.enqueue('old-typing', QOS.TELEMETRY, 0)
  q.enqueue('fresh-typing', QOS.TELEMETRY, 20_000)
  const got = q.dequeue(20_001)
  return got.item === 'fresh-typing' && q.dequeue(20_001) === null && q.stats().expired === 1
})

check('a full queue evicts the lowest droppable to admit a higher class — and never a MESSAGE', () => {
  const q = createQosQueue({ capacity: 2 })
  q.enqueue('m1', QOS.MESSAGE, 0)
  q.enqueue('t1', QOS.TELEMETRY, 0)
  const admitted = q.enqueue('c1', QOS.CALL_SIGNAL, 0)     // evicts t1
  const refusedTelemetry = q.enqueue('t2', QOS.TELEMETRY, 0) === false
  const s = q.stats()
  return admitted && refusedTelemetry && s.evicted === 1 && s.refused === 1 &&
    q.dequeue(0).item === 'c1' && q.dequeue(0).item === 'm1'
})

/* =========================== the engine itself =========================== */

function makeWorld ({ autoSwitch = true } = {}) {
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const delivered = []
  const socketio = fakeTransport('socketio', CAPABILITY_MATRIX.socketio)
  const webrtc = fakeTransport('webrtc', CAPABILITY_MATRIX.webrtc)
  registry.register('socketio', { transport: socketio, capabilities: CAPABILITY_MATRIX.socketio })
  registry.register('webrtc', { transport: webrtc, capabilities: CAPABILITY_MATRIX.webrtc })
  const supervisor = createSupervisor({
    registry,
    clock,
    isOnline: () => true,
    deliver: (envelope, meta) => delivered.push({ envelope, meta }),
    config: { autoSwitch }
  })
  return { clock, registry, supervisor, socketio, webrtc, delivered }
}

const drainMicrotasks = () => new Promise((r) => setTimeout(r, 0))

await checkAsync('the engine starts, selects a transport, and the decision log says why', async () => {
  const { supervisor } = makeWorld()
  await supervisor.start()
  await drainMicrotasks()
  const events = supervisor.events()
  const decision = events.find((e) => e.type === 'decision')
  const migration = events.find((e) => e.type === 'migration')
  supervisor.stop()
  return supervisor.current() != null && decision != null &&
    typeof decision.reason === 'string' && Array.isArray(decision.scores) &&
    decision.scores.every((s) => typeof s.name === 'string') &&
    migration != null && migration.to === supervisor.current()
})

await checkAsync('NOISE WITHIN THE MARGIN CAUSES ZERO SWITCHES (the anti-flap guarantee)', async () => {
  const { clock, supervisor, socketio, webrtc } = makeWorld()
  await supervisor.start()
  await drainMicrotasks()
  const chosen = supervisor.current()
  // 5 simulated minutes of jitter: both links wobble ±15ms around the same
  // latency — well within margin+stickiness once smoothed.
  for (let i = 0; i < 150; i++) {
    socketio._set({ connected: true, latencyMs: 80 + (i % 3) * 15, lossPct: 0 })
    webrtc._set({ connected: true, latencyMs: 80 + ((i + 1) % 3) * 15, lossPct: 0 })
    clock.advance(2000)
    await drainMicrotasks()
  }
  supervisor.stop()
  const switches = supervisor.events().filter((e) => e.type === 'migration')
  return supervisor.current() === chosen && switches.length === 1   // only the initial selection
})

await checkAsync('a DEAD incumbent is abandoned immediately — availability beats dwell', async () => {
  const { clock, supervisor, socketio, webrtc } = makeWorld()
  socketio._set({ connected: true, latencyMs: 20, lossPct: 0 })
  webrtc._set({ connected: true, latencyMs: 200, lossPct: 0 })
  await supervisor.start()
  await drainMicrotasks()
  const first = supervisor.current()
  // Kill the incumbent INSIDE the dwell window.
  socketio._set({ connected: false }, 'failed')
  clock.advance(2000)
  await drainMicrotasks()
  await drainMicrotasks()
  supervisor.stop()
  const second = supervisor.current()
  const evt = supervisor.events().find((e) => e.type === 'decision' && /no longer viable/.test(e.reason || ''))
  return first === 'socketio' && second === 'webrtc' && evt != null
})

await checkAsync('PREDICTION: a degrading trend triggers the switch EARLIER than raw scores would', async () => {
  // The honest claim of anticipation is TIMING: run the identical shallow
  // degradation twice — once with the prediction penalty disabled, once
  // enabled — and assert the enabled run leaves the worsening link STRICTLY
  // SOONER. Identical capability rows isolate the effect to live latency.
  const runScenario = async (predictionPenalty) => {
    const clock = createManualClock()
    const registry = createTransportRegistry()
    const caps = CAPABILITY_MATRIX.socketio
    const a = fakeTransport('alpha', caps)
    const b = fakeTransport('beta', caps)
    a._set({ connected: true, latencyMs: 100, lossPct: 0 })
    b._set({ connected: true, latencyMs: 120, lossPct: 0 })
    registry.register('alpha', { transport: a, capabilities: caps })
    registry.register('beta', { transport: b, capabilities: caps })
    const supervisor = createSupervisor({
      registry, clock, isOnline: () => true, deliver: () => {},
      monitorConfig: { latencyCeilingMs: 250 },
      config: { predictionPenalty }
    })
    await supervisor.start()
    await drainMicrotasks()
    const first = supervisor.current()
    for (let i = 0; i < 12; i++) {
      a._set({ connected: true, latencyMs: 100 + (i + 1) * 40, lossPct: 0 })
      clock.advance(2000)
      await drainMicrotasks()
    }
    supervisor.stop()
    const migrations = supervisor.events().filter((e) => e.type === 'migration' && e.from === 'alpha')
    const penalised = supervisor.events().some((e) =>
      e.type === 'decision' && (e.scores || []).some((s) => /prediction penalty/.test(s.reason || '')))
    return { first, ended: supervisor.current(), switchAt: migrations[0]?.at ?? Infinity, penalised }
  }

  const withPrediction = await runScenario(0.15)
  const withoutPrediction = await runScenario(0)
  return withPrediction.first === 'alpha' && withPrediction.ended === 'beta' &&
    withoutPrediction.ended === 'beta' &&                       // raw scores get there eventually…
    withPrediction.switchAt < withoutPrediction.switchAt &&     // …prediction gets there FIRST
    withPrediction.penalised === true && withoutPrediction.penalised === false
})

await checkAsync('SHADOW MODE (autoSwitch=false): decisions are logged, nothing migrates', async () => {
  const { clock, supervisor, socketio } = makeWorld({ autoSwitch: false })
  await supervisor.start()
  await drainMicrotasks()
  socketio._set({ connected: false }, 'failed')
  clock.advance(4000)
  await drainMicrotasks()
  supervisor.stop()
  const migrations = supervisor.events().filter((e) => e.type === 'migration')
  const decisions = supervisor.events().filter((e) => e.type === 'decision')
  return supervisor.current() === null && migrations.length === 0 &&
    decisions.length > 0 && decisions.every((d) => d.shadow === true)
})

await checkAsync('send() enforces INV-6: an unsealed envelope never reaches a transport', async () => {
  const { supervisor } = makeWorld()
  await supervisor.start()
  await drainMicrotasks()
  let refused = false
  try { await supervisor.send({ ciphertext: 'x' }) } catch { refused = true }
  const ok = await supervisor.send(makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: 'b64' }))
  supervisor.stop()
  return refused && ok.accepted === true && typeof ok.via === 'string'
})

await checkAsync('a hung transport send is BOUNDED by timeout and counted as loss', async () => {
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const hung = fakeTransport('socketio', CAPABILITY_MATRIX.socketio, { onSend: () => new Promise(() => {}) })
  registry.register('socketio', { transport: hung, capabilities: CAPABILITY_MATRIX.socketio })
  const supervisor = createSupervisor({
    registry, clock, isOnline: () => true, deliver: () => {}, config: { sendTimeoutMs: 500 }
  })
  await supervisor.start()
  await drainMicrotasks()
  const p = supervisor.send(makeSealedEnvelope({ roomId: 'r', origin: 'o', ciphertext: 'x' }))
    .then(() => 'sent', (e) => e)
  clock.advance(600)
  const err = await p
  supervisor.stop()
  return err instanceof Error && err.name === 'TimeoutError' &&
    supervisor.events().some((e) => e.type === 'send-failure')
})

check('THE OWNER RULE AS API: the engine exposes no user transport-choice surface', () => {
  const { supervisor } = makeWorld()
  const surface = Object.keys(supervisor)
  const forbidden = /^(set|pick|choose|select|prefer|force).*transport|^setTransport$|^pinTransport$/i
  return surface.every((k) => !forbidden.test(k))
})

check('a supervisor-driven fake transport still satisfies the ITransport contract', () => {
  const t = fakeTransport('socketio', CAPABILITY_MATRIX.socketio)
  assertImplementsITransport(t, 'fake')
  return true
})

check('offline context disqualifies internet transports in ranking (reasons carried)', () => {
  const clock = createManualClock()
  const registry = createTransportRegistry()
  const ble = fakeTransport('bleCentral', makeCapabilities({
    range: RANGE.PROXIMITY, needsInternet: false, offline: true,
    bandwidthKbps: 200, latencyMs: 200, batteryCostPerMin: 0.5, maxPayloadBytes: 64_000
  }))
  const sock = fakeTransport('socketio', CAPABILITY_MATRIX.socketio)
  registry.register('socketio', { transport: sock, capabilities: CAPABILITY_MATRIX.socketio })
  registry.register('bleCentral', { transport: ble, capabilities: ble.capabilities() })
  const supervisor = createSupervisor({ registry, clock, isOnline: () => false, deliver: () => {} })
  const { decision, scored } = supervisor.rank(supervisor.monitor.tick())
  const sockScore = scored.find((s) => s.name === 'socketio')
  return decision.selected === 'bleCentral' && sockScore.disqualified === true &&
    /internet/.test(sockScore.reason)
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive supervisor — estimates, health, decisions, no flap')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
