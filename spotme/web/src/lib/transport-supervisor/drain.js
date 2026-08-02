/**
 * Spot Me — the OUTBOX DRAINER: store-and-forward made continuous. ADR-012b.
 *
 * The loop that turns "queued" into "delivered": pull owed envelopes from the
 * outbox, order them by QoS class, respect the congestion window, send via
 * the supervisor, retry with the right backoff class, mark delivered on ack.
 * Background-sync semantics for the web: `kick()` is wired (by the wiring PR)
 * to reconnect/visibility/online events, so a device that comes back drains
 * immediately instead of on the next poll — the same resume shape reach.js
 * uses, generalised.
 *
 * WHAT IT GUARANTEES (and tests assert):
 *   - an envelope leaves the outbox only on markDelivered (ack) or TTL sweep —
 *     never because a send merely happened (ack-or-retry, WS4 §13.4);
 *   - retries reuse the SAME envelopeId, so a retry racing a late ack dedups
 *     at the receiver;
 *   - the drain never exceeds the congestion window, and backs off per
 *     failure class (transient vs persistent);
 *   - priority order: call-signal > message > receipt > telemetry, with
 *     droppable classes shed when stale (qos.js owns that policy).
 *
 * Timers only between start() and stop(), only via the injected clock.
 */
import { QOS, QOS_POLICY, asQosClass, createQosQueue } from './qos.js'
import { createCongestionController, backoffDelay } from './congestion.js'
import { assertSealedBeforeSend } from './invariants.js'

export const DRAIN_DEFAULTS = Object.freeze({
  tickMs: 1_000,          // how often the drain looks for work
  queueCapacity: 512,     // in-memory scheduling queue bound (outbox itself is the durable set)
  maxAttemptsTransient: 20
})

export function createOutboxDrainer ({
  outbox,                 // IOutbox (memory or durable)
  supervisor,             // { send(envelope) } — the single sealed-send choke point
  clock,
  rand = Math.random,
  config = {}
} = {}) {
  if (!outbox) throw new Error('drain: outbox required')
  if (!supervisor || typeof supervisor.send !== 'function') throw new Error('drain: supervisor with send() required')
  if (!clock) throw new Error('drain: clock required')
  const cfg = { ...DRAIN_DEFAULTS, ...config }

  const queue = createQosQueue({ capacity: cfg.queueCapacity })
  const congestion = createCongestionController({})
  // envelopeId -> { attempts, notBefore, cls } — retry bookkeeping.
  const retryState = new Map()
  const counters = { sent: 0, acked: 0, retried: 0, abandoned: 0, deferred: 0 }
  let interval = null
  let draining = false

  /**
   * Enqueue an already-sealed envelope for delivery. The DURABLE record goes
   * to the outbox first (a crash after this line owes the message, which is
   * the correct debt); the QoS queue is only the scheduler on top.
   */
  function submit (envelope, cls = QOS.MESSAGE) {
    assertSealedBeforeSend(envelope, 'drain submit')
    const c = asQosClass(cls)
    const now = clock.now()
    outbox.enqueue(envelope.envelopeId, { envelope, cls: c }, now)
    queue.enqueue(envelope.envelopeId, c, now)
    return envelope.envelopeId
  }

  /** The receiver (or server seq) acknowledged: the debt is paid. */
  function acked (envelopeId) {
    if (outbox.markDelivered(envelopeId)) counters.acked++
    retryState.delete(envelopeId)
    supervisor.acked?.(envelopeId)
  }

  /** Re-arm scheduling for everything owed (reload recovery, transport switch). */
  function reschedulePending () {
    const now = clock.now()
    for (const entry of outbox.pending(now)) {
      const cls = entry.item?.cls ?? QOS.MESSAGE
      queue.enqueue(entry.id, cls, entry.first)
    }
  }

  /** Fetch one owed entry. Prefers the store's O(1) get() where offered;
   *  falls back to the contract-only pending() scan. TTL expiry is sweep()'s
   *  job (run at the top of every drain pass), not this lookup's. */
  function owedEntry (envelopeId, now) {
    if (typeof outbox.get === 'function') return outbox.get(envelopeId)
    return outbox.pending(now).find((e) => e.id === envelopeId) || null
  }

  async function sendOne (envelopeId, cls) {
    const entry = owedEntry(envelopeId, clock.now())
    if (!entry) { retryState.delete(envelopeId); return }   // acked or swept meanwhile
    const state = retryState.get(envelopeId) || { attempts: 0, notBefore: 0, cls }
    const now = clock.now()
    if (now < state.notBefore) { counters.deferred++; queue.enqueue(envelopeId, cls, now); return }

    congestion.launched()
    try {
      await supervisor.send(entry.item.envelope)
      congestion.acked()
      counters.sent++
      // Sent is NOT delivered: the entry stays in the outbox until acked().
      // But do not hot-loop resends of the same envelope while unacked —
      // schedule the next attempt on the transient curve.
      state.attempts++
      state.notBefore = now + backoffDelay('transient', state.attempts, rand)
      retryState.set(envelopeId, state)
      queue.enqueue(envelopeId, cls, now)
    } catch (err) {
      congestion.failed()
      state.attempts++
      const persistent = err?.code === 'NO_TRANSPORT' || /unavailable/i.test(String(err?.message))
      const bucket = persistent ? 'persistent' : 'transient'
      const policy = QOS_POLICY[cls]
      const overTransientCap = bucket === 'transient' && state.attempts > cfg.maxAttemptsTransient
      const overClassCap = Number.isFinite(policy.retries) && state.attempts > policy.retries
      if ((overClassCap || overTransientCap) && policy.droppable) {
        // A droppable class out of retries is shed — the outbox entry is
        // released too, because a receipt we will never send is not a debt.
        outbox.markDelivered(envelopeId)
        retryState.delete(envelopeId)
        counters.abandoned++
        return
      }
      state.notBefore = now + backoffDelay(bucket, state.attempts, rand)
      retryState.set(envelopeId, state)
      counters.retried++
      queue.enqueue(envelopeId, cls, now)
    }
  }

  /** One drain pass: launch up to the congestion window's worth of work.
   *
   * THE BUDGET IS LOAD-BEARING. sendOne() re-enqueues items synchronously —
   * a deferred item (backoff not yet due) and a sent-but-unacked item both go
   * back on the queue for a LATER pass. Without a bound on how many dequeues
   * one pass may perform, an all-deferred queue would be dequeued and
   * re-enqueued forever inside this loop (found by the NO_TRANSPORT test:
   * the `launched` array literally overflowed). Snapshotting the queue size
   * makes each pass touch each scheduled item at most once. */
  async function drain () {
    if (draining) return
    draining = true
    try {
      const now = clock.now()
      outbox.sweep(now)
      // RE-ARM FROM THE DURABLE SET when the scheduler runs dry while debts
      // remain. The scheduling queue is bounded (queueCapacity), so a backlog
      // larger than the bound only ever schedules its first wave — submit()'s
      // overflow is REFUSED for non-droppable classes by design. Without this
      // line those envelopes stayed owed in the outbox forever (found by the
      // 5,000-envelope stress test at exactly `owed = backlog − capacity`).
      if (queue.size === 0 && outbox.size > 0) reschedulePending()
      const launched = []
      let budget = queue.size
      while (budget-- > 0 && congestion.canSend()) {
        const head = queue.dequeue(now)
        if (!head) break
        launched.push(sendOne(head.item, head.cls))
      }
      await Promise.all(launched)
    } finally {
      draining = false
    }
  }

  return Object.freeze({
    submit,
    acked,
    /** Immediate drain — wire to online/visibility/reconnect events. */
    kick () { return drain() },
    start () {
      if (interval != null) return
      reschedulePending()
      interval = clock.setInterval(() => { drain() }, cfg.tickMs)
    },
    stop () {
      if (interval == null) return
      clock.clearInterval(interval)
      interval = null
    },
    pressure: () => congestion.pressure(),
    stats: () => ({
      ...counters,
      queue: queue.stats(),
      congestion: congestion.stats(),
      owed: outbox.size
    }),
    get running () { return interval != null }
  })
}
