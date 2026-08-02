/**
 * Spot Me — SEAMLESS MIGRATION: make-before-break transport switching. ADR-012b.
 *
 * A switch is only "seamless" if a conversation crossing it cannot tell. That
 * decomposes into four properties, each owned by a primitive this module
 * composes rather than re-invents:
 *
 *   NO GAP      — the new transport is connected and receiving BEFORE the old
 *                 one is released (make-before-break). There is no instant
 *                 where the room rides on nothing.
 *   NO LOSS     — envelopes in flight on the old transport at the moment of
 *                 the switch are re-queued (by envelopeId) and re-sent on the
 *                 new one. An unacked send is a debt, not a hope.
 *   NO DUPES    — the same envelope arriving over both transports (the old
 *                 one delivered after all, plus the re-send) collapses to one
 *                 delivery through the shared dedup window (envelope.js).
 *   NO REORDER  — the per-origin reorder buffer (ordering.js) holds gaps and
 *                 releases in senderClock order, whatever path each envelope
 *                 took. Arrival order is meaningless across paths; release
 *                 order is the contract.
 *
 * The receive pipeline (dedup → reorder → deliver) is SHARED ACROSS ALL
 * transports and lives here so that "which link did this arrive on?" is a
 * fact about telemetry, never about correctness.
 *
 * Crypto is untouched by construction: everything this module moves is an
 * already-sealed envelope (INV-6 asserted at every send boundary), and a
 * switch changes zero bytes of any envelope (the WS4 §8.4 no-op argument).
 */
import { withTimeout } from './clock.js'
import { createDedupWindow } from './envelope.js'
import { createReorderBuffer } from './ordering.js'
import { assertSealedBeforeSend } from './invariants.js'

export const MIGRATION_DEFAULTS = Object.freeze({
  connectTimeoutMs: 8_000,    // bound on bringing the new transport up
  releaseGraceMs: 5_000,      // how long the old transport stays attached after
                              // the switch, to catch stragglers already in flight
  resendTimeoutMs: 10_000     // bound on re-sending the in-flight backlog
})

/**
 * The shared receive pipeline: dedup by envelopeId, then per-origin in-order
 * release. `deliver(envelope, meta)` fires exactly once per envelopeId, in
 * senderClock order per origin. Envelopes without an ordering token bypass
 * the reorder buffer (nothing to order by) but still dedup.
 */
export function createReceivePipeline ({ deliver, dedupCapacity = 4096 } = {}) {
  if (typeof deliver !== 'function') throw new Error('pipeline: deliver required')
  const dedup = createDedupWindow({ capacity: dedupCapacity })
  const reorder = createReorderBuffer()
  const counters = { received: 0, duplicates: 0, delivered: 0, buffered: 0 }

  function accept (envelope, meta = {}) {
    counters.received++
    if (!dedup.accept(envelope)) {
      counters.duplicates++
      return { status: 'duplicate', released: 0 }
    }
    const ord = envelope.ordering
    if (!ord || typeof ord.senderClock !== 'number') {
      counters.delivered++
      deliver(envelope, meta)
      return { status: 'delivered', released: 1 }
    }
    const { released, status } = reorder.push({
      origin: envelope.origin,
      senderClock: ord.senderClock,
      item: { envelope, meta }
    })
    for (const r of released) { counters.delivered++; deliver(r.envelope, r.meta) }
    if (status === 'buffered') counters.buffered++
    return { status, released: released.length }
  }

  return Object.freeze({
    accept,
    pending: (origin) => reorder.pending(origin),
    expected: (origin) => reorder.expected(origin),
    stats: () => ({ ...counters })
  })
}

/**
 * Track sends that have left but not been acknowledged. The migration
 * executor re-queues exactly these on a switch; the drain marks them done on
 * ack. Bounded by construction: an entry leaves on ack or when the caller
 * abandons it (TTL is the outbox's job — this is only the in-flight window).
 */
export function createInFlightTracker () {
  const flying = new Map()   // envelopeId -> { envelope, transport, sentAt }
  return Object.freeze({
    sent (envelope, transportName, now) {
      flying.set(envelope.envelopeId, { envelope, transport: transportName, sentAt: now })
    },
    acked (envelopeId) { return flying.delete(envelopeId) },
    /** Everything currently unacked on `transportName` (or all when null). */
    unacked (transportName = null) {
      const out = []
      for (const e of flying.values()) {
        if (transportName == null || e.transport === transportName) out.push(e)
      }
      return out
    },
    forget (envelopeId) { return flying.delete(envelopeId) },
    get size () { return flying.size }
  })
}

/**
 * Execute one make-before-break switch.
 *
 * `attach(transport)` / `detach(transport)` are the supervisor's hooks that
 * plumb the shared receive pipeline into a transport's receive() and back
 * out; they are injected so this executor stays testable with fakes and so
 * attach/detach policy (what to do with subscriptions) lives in one place.
 *
 * Returns a machine-readable report — the event log stores it verbatim.
 */
export function createMigrationExecutor ({ clock, inFlight, config = {} } = {}) {
  if (!clock) throw new Error('migration: clock required')
  if (!inFlight) throw new Error('migration: inFlight tracker required')
  const cfg = { ...MIGRATION_DEFAULTS, ...config }

  async function execute ({ from, to, attach, detach, resend }) {
    if (!to || !to.transport) throw new Error('migration: target transport required')
    const startedAt = clock.now()
    const report = {
      from: from?.name ?? null,
      to: to.name,
      startedAt,
      connectMs: null,
      requeued: 0,
      resent: 0,
      released: false,
      failed: null
    }

    // 1. MAKE: bring the new transport up, bounded. A target that cannot
    //    connect within the bound fails the switch — the incumbent stays.
    try {
      const t0 = clock.now()
      await withTimeout(Promise.resolve(to.transport.connect()), cfg.connectTimeoutMs, `connect ${to.name}`, clock)
      report.connectMs = clock.now() - t0
    } catch (err) {
      report.failed = `connect: ${err.message}`
      return report
    }

    // 2. ATTACH the shared receive pipeline to the new transport BEFORE the
    //    old one detaches — from here, both deliver into the same dedup, so
    //    the overlap window produces no duplicates.
    attach(to)

    // 3. RE-QUEUE in-flight: everything unacked on the old transport is owed
    //    again, over the new one. Same envelopeIds — the receiver's dedup
    //    absorbs any the old link had actually delivered.
    const owed = from ? inFlight.unacked(from.name) : []
    report.requeued = owed.length
    if (owed.length && typeof resend === 'function') {
      try {
        await withTimeout(
          (async () => {
            for (const entry of owed) {
              assertSealedBeforeSend(entry.envelope, 'migration resend')
              await resend(entry.envelope, to)
              inFlight.sent(entry.envelope, to.name, clock.now())
              report.resent++
            }
          })(),
          cfg.resendTimeoutMs, `resend backlog to ${to.name}`, clock
        )
      } catch (err) {
        // The switch itself stands (the new link is attached); unresent
        // backlog stays owed and the outbox drain will retry it. Recorded,
        // not thrown — a partial resend is degraded, not failed.
        report.failed = `resend: ${err.message}`
      }
    }

    // 4. BREAK, after a grace window: the old transport keeps delivering
    //    stragglers into the shared pipeline for `releaseGraceMs`, then
    //    detaches. Dedup makes the overlap harmless; the grace is what makes
    //    "in flight at the instant of the switch" a non-event.
    if (from) {
      clock.setTimeout(() => {
        try { detach(from) } catch { /* already gone */ }
      }, cfg.releaseGraceMs)
    }
    report.released = true
    report.durationMs = clock.now() - startedAt
    return report
  }

  return Object.freeze({ execute, config: Object.freeze({ ...cfg }) })
}
