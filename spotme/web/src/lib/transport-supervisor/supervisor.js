/**
 * Spot Me — the ADAPTIVE TRANSPORT SUPERVISOR engine. ADR-012b.
 *
 * The production composition of everything under this directory: the monitor
 * keeps smoothed per-transport estimates; this engine turns them into a
 * RANKING (selection.js scoring over live estimates), applies the existing
 * HYSTERESIS (margin / dwell / stickiness — untouched, it is the anti-flap
 * proof), folds in PREDICTION (a link trending toward unusable is penalised
 * before it dies), and executes switches through the make-before-break
 * MIGRATION executor. Every decision lands in a bounded, machine-readable
 * EVENT LOG with reasons — the same discipline as the translation router:
 * "why did it switch?" must be answerable from data, not from vibes.
 *
 * ZERO USER INTERACTION, STRUCTURALLY. This engine exposes no method that
 * accepts a transport choice from outside — no setTransport, no pick, no
 * prefer. Selection inputs are health, cost, battery, and context; the owner
 * rule ("users never pick a transport") is enforced by the API surface
 * itself, and adaptive-supervisor.test.js asserts the surface. The one
 * existing escape hatch (`localStorage['spotme.transport']`, a debug pin)
 * lives outside this module and gates WIRING, not selection.
 *
 * SENDS NEVER CARRY PLAINTEXT. `send()` asserts INV-6 (sealed, opaque,
 * no cleartext field) before any transport sees the envelope. What arrives
 * here is already-sealed bytes; what leaves is the same bytes. The engine is
 * a router of ciphertext with the same trust level as the network: none.
 *
 * Timers: only via the injected clock, only between start() and stop().
 * Construction arms nothing.
 */
import { createSelector, DEFAULT_HYSTERESIS, scoreAll } from './selection.js'
import { makeQualitySample } from './ITransport.js'
import { createMonitor } from './monitor.js'
import { createMigrationExecutor, createReceivePipeline, createInFlightTracker } from './migration.js'
import { withTimeout } from './clock.js'
import { assertSealedBeforeSend } from './invariants.js'
import { HEALTH } from './health-fsm.js'

export const SUPERVISOR_DEFAULTS = Object.freeze({
  sendTimeoutMs: 10_000,     // bound on a single transport send
  predictionPenalty: 0.15,   // score penalty for a link predicted to degrade
  logCapacity: 256,          // decision ring buffer
  autoSwitch: true           // false = SHADOW MODE: rank + log, never migrate
                             // (AUTO_TRANSPORT_ENABLED off maps here)
})

export function createSupervisor ({
  registry,
  clock,
  battery = null,             // createBatteryReader() instance, optional
  isOnline = null,            // () => boolean; injected so tests script it
  deliver,                    // (envelope, meta) => void — the app-facing sink
  hysteresis = DEFAULT_HYSTERESIS,
  monitorConfig = {},
  config = {}
} = {}) {
  if (!registry) throw new Error('supervisor: registry required')
  if (!clock) throw new Error('supervisor: clock required')
  if (typeof deliver !== 'function') throw new Error('supervisor: deliver sink required')
  const cfg = { ...SUPERVISOR_DEFAULTS, ...config }

  const monitor = createMonitor({ registry, clock, config: monitorConfig })
  const selector = createSelector(hysteresis)
  const inFlight = createInFlightTracker()
  const pipeline = createReceivePipeline({ deliver })
  const migrator = createMigrationExecutor({ clock, inFlight })

  const online = typeof isOnline === 'function'
    ? isOnline
    : () => (typeof navigator !== 'undefined' && 'onLine' in navigator ? navigator.onLine !== false : true)

  /** name -> unsubscribe fn for the receive attachment. */
  const attached = new Map()
  const log = []               // bounded decision/event ring
  let currentName = null       // the transport carrying the room right now
  let running = false
  let unSample = null
  let batteryContext = { batterySaver: false, batteryLevel: 0.5, batteryKnown: false }

  function record (type, data) {
    log.push(Object.freeze({ at: clock.now(), type, ...data }))
    if (log.length > cfg.logCapacity) log.shift()
  }

  /* ---------------------------------------------------- receive plumbing --- */

  function attach (entry) {
    if (attached.has(entry.name)) return
    const un = entry.transport.receive((envelope, meta = {}) => {
      const res = pipeline.accept(envelope, { ...meta, via: entry.name })
      if (res.status === 'duplicate') record('dedup', { via: entry.name, envelopeId: envelope?.envelopeId })
    })
    attached.set(entry.name, typeof un === 'function' ? un : () => {})
  }

  function detach (entry) {
    const un = attached.get(entry.name)
    if (!un) return
    attached.delete(entry.name)
    try { un() } catch { /* already gone */ }
  }

  /* ------------------------------------------------------------- ranking --- */

  /**
   * Build selection candidates from the registry + the monitor's smoothed
   * estimates. The nominal capability row supplies the static half; the live
   * half comes from the EWMAs; UNAVAILABLE/DOWN links are marked not
   * connected so the scorer disqualifies rather than down-weights them.
   * A prediction of degradation subtracts a penalty AFTER scoring — the
   * anticipatory nudge that lets hysteresis-guarded switching begin before
   * the link actually fails.
   */
  function candidates (snap) {
    const out = []
    for (const entry of registry.list()) {
      if (!entry.transport) continue
      const lane = snap.transports[entry.name]
      const health = lane ? lane.health : HEALTH.UNKNOWN
      const q = lane?.quality
      const connected = health === HEALTH.HEALTHY || health === HEALTH.DEGRADED ||
        (health === HEALTH.UNKNOWN && entry.transport.status() === 'connected')
      out.push({
        name: entry.name,
        capabilities: entry.capabilities,
        quality: makeQualitySample({
          latencyMs: q?.latencyMs ?? null,
          lossPct: q?.lossKnown ? q.lossPct : 0,
          throughputKbps: q?.throughputKbps ?? null,
          jitterMs: q?.jitterMs ?? 0,
          connected
        }),
        cost: lane?.cost ?? undefined,
        prediction: lane?.prediction ?? null
      })
    }
    return out
  }

  function contextNow () {
    return {
      noInternet: online() === false,
      batterySaver: batteryContext.batterySaver === true
    }
  }

  /** Rank once: score, apply prediction penalty, then hysteresis. */
  function rank (snap = monitor.snapshot()) {
    const cands = candidates(snap)
    const context = contextNow()
    const scored = scoreAll(cands, context)
    if (cfg.predictionPenalty > 0) {
      for (const s of scored) {
        const cand = cands.find((c) => c.name === s.name)
        if (s.score != null && cand?.prediction?.degrading) {
          s.score = Math.max(0, s.score - cfg.predictionPenalty)
          s.reason = `prediction penalty −${cfg.predictionPenalty}: ${cand.prediction.reasons.join('; ')}`
        }
      }
    }
    // Re-sort after penalties (scoreAll sorted pre-penalty).
    scored.sort((a, b) => {
      if (a.score == null && b.score == null) return a.name < b.name ? -1 : 1
      if (a.score == null) return 1
      if (b.score == null) return -1
      if (b.score !== a.score) return b.score - a.score
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
    const decision = selector.chooseScored(scored, clock.now())
    return { decision, scored, context }
  }

  /* ------------------------------------------------------------ deciding --- */

  async function decideOnce (snap) {
    const { decision, scored, context } = rank(snap)
    record('decision', {
      selected: decision.selected,
      switched: decision.switched,
      reason: decision.reason,
      context,
      shadow: cfg.autoSwitch !== true,
      scores: scored.map((s) => ({ name: s.name, score: s.score, disqualified: s.disqualified, reason: s.reason }))
    })
    if (!decision.switched || decision.selected == null) return decision
    if (decision.selected === currentName) return decision
    if (cfg.autoSwitch !== true) {
      // SHADOW MODE: the ranking and the would-have-switched decision are
      // logged for observability, but no migration executes and the live
      // path is untouched. Staged-rollout posture (flags.js layering).
      return decision
    }

    const from = currentName ? registry.get(currentName) : null
    const to = registry.get(decision.selected)
    const report = await migrator.execute({
      from,
      to,
      attach,
      detach,
      resend: (envelope, target) => withTimeout(
        Promise.resolve(target.transport.send(envelope)), cfg.sendTimeoutMs, `resend via ${target.name}`, clock)
    })
    record('migration', report)
    if (report.failed && report.connectMs == null) {
      // Connect failed: the switch did not happen. Roll the selector back so
      // the incumbent stays authoritative instead of the selector believing
      // a transport we never reached is current.
      selector.reset()
      if (currentName) {
        // Re-seed the selector with the incumbent by choosing among just it.
        const seed = scored.filter((s) => s.name === currentName)
        if (seed.length) selector.chooseScored(seed, clock.now())
      }
      return decision
    }
    currentName = decision.selected
    return decision
  }

  /** Decisions are SERIALIZED on one chain: two monitor ticks can never run
   *  two migrations concurrently, and poke()/start() can await the tail. */
  let decideChain = Promise.resolve(null)
  function decide (snap) {
    decideChain = decideChain
      .then(() => decideOnce(snap))
      .catch((err) => { record('decide-error', { error: String(err?.message || err) }); return null })
    return decideChain
  }

  /* ---------------------------------------------------------------- send --- */

  /**
   * Send one already-sealed envelope over the current transport. INV-6 is
   * asserted HERE, at the single choke point every send passes through — a
   * transport can never receive an unsealed envelope from this engine.
   * Returns { accepted, via } or throws; the caller (outbox drain) owns
   * retries, so a failure here is a signal, not a loss.
   */
  async function send (envelope) {
    assertSealedBeforeSend(envelope, 'supervisor send')
    const entry = currentName ? registry.get(currentName) : null
    if (!entry?.transport) {
      const err = new Error('no transport selected — enqueue for store-and-forward')
      err.code = 'NO_TRANSPORT'
      throw err
    }
    const t0 = clock.now()
    try {
      const res = await withTimeout(
        Promise.resolve(entry.transport.send(envelope)), cfg.sendTimeoutMs, `send via ${entry.name}`, clock)
      inFlight.sent(envelope, entry.name, t0)
      monitor.reportOutcome(entry.name, { delivered: true, rttMs: clock.now() - t0 })
      return { accepted: res?.accepted !== false, via: entry.name }
    } catch (err) {
      monitor.reportOutcome(entry.name, { delivered: false })
      record('send-failure', { via: entry.name, error: String(err?.message || err) })
      throw err
    }
  }

  /** The receiver acked this envelope (server seq or receipt): stop owing it. */
  function acked (envelopeId) { return inFlight.acked(envelopeId) }

  /* ------------------------------------------------------------ lifecycle --- */

  async function start () {
    if (running) return
    running = true
    record('start', {})
    if (battery) {
      const reading = await battery.read()
      batteryContext = battery.toContext(reading)
    }
    monitor.start()
    unSample = monitor.onSample((snap) => {
      // Refresh battery context opportunistically (cheap: cached manager).
      if (battery) {
        battery.read().then((r) => { batteryContext = battery.toContext(r) }).catch(() => {})
      }
      decide(snap)
    })
    // First decision immediately — a fresh start must not wait a full tick.
    // tick() fires the listener above, which enqueues the decision; awaiting
    // the chain tail makes start() deterministic for callers and tests.
    monitor.tick()
    await decideChain
  }

  function stop () {
    if (!running) return
    running = false
    if (unSample) { unSample(); unSample = null }
    monitor.stop()
    for (const name of [...attached.keys()]) detach({ name })
    record('stop', {})
  }

  return Object.freeze({
    start,
    stop,
    send,
    acked,
    rank,
    /** Force one monitor tick + decision now (network-change hooks call this).
     *  The tick fires the sample listener, which enqueues exactly one
     *  decision; returning the chain tail hands that decision back. */
    async poke () {
      monitor.tick()
      return decideChain
    },
    current: () => currentName,
    events: () => [...log],
    stats: () => ({
      current: currentName,
      running,
      inFlight: inFlight.size,
      pipeline: pipeline.stats(),
      selector: selector.state()
    }),
    monitor,
    pipeline,
    get running () { return running }
  })
}
