/**
 * Spot Me — QoS CLASSES + the priority queue the drain runs on. ADR-012b.
 *
 * Not every envelope is equally urgent, and on a constrained link (BLE, a
 * congested socket) the order the queue drains in IS the user experience.
 * Four classes, strictly ordered:
 *
 *   CALL_SIGNAL  — RTC offers/answers/candidates. A call that connects two
 *                  seconds late is a call that gets abandoned; head of line.
 *   MESSAGE      — the conversation itself, and its attachments.
 *   RECEIPT      — delivery-state: delivered/read receipts, edits' acks.
 *                  Valuable, but never at a message's expense.
 *   TELEMETRY    — typing indicators, presence pulses. DROPPABLE: a typing
 *                  signal that arrives late is not late, it is WRONG, so under
 *                  pressure these are shed first (see maxAgeMs).
 *
 * THE PAYLOAD STAYS OPAQUE. Classification rides BESIDE the envelope as
 * routing metadata (the same standing as roomId), supplied by the caller who
 * knows what it enqueued. This module never inspects ciphertext to classify —
 * it cannot, and the invariant tests would catch it if it tried (INV-2).
 *
 * Delivery-state / receipt / typing signals therefore travel exactly like
 * messages do: as SealedEnvelopes whose ciphertext this layer cannot read,
 * distinguished only by their class label for scheduling.
 */

/** Class ids, ordered by priority (lower = drains first). */
export const QOS = Object.freeze({
  CALL_SIGNAL: 0,
  MESSAGE: 1,
  RECEIPT: 2,
  TELEMETRY: 3
})

export const QOS_NAMES = Object.freeze(['call-signal', 'message', 'receipt', 'telemetry'])

/** Per-class policy: retry posture and how stale is too stale to bother. */
export const QOS_POLICY = Object.freeze({
  [QOS.CALL_SIGNAL]: Object.freeze({ name: 'call-signal', maxAgeMs: 30_000, droppable: true, retries: 3 }),
  [QOS.MESSAGE]: Object.freeze({ name: 'message', maxAgeMs: 24 * 60 * 60_000, droppable: false, retries: Infinity }),
  [QOS.RECEIPT]: Object.freeze({ name: 'receipt', maxAgeMs: 6 * 60 * 60_000, droppable: true, retries: 8 }),
  [QOS.TELEMETRY]: Object.freeze({ name: 'telemetry', maxAgeMs: 15_000, droppable: true, retries: 0 })
})

/** Validate + normalise a class id at the boundary. */
export function asQosClass (cls) {
  if (cls === QOS.CALL_SIGNAL || cls === QOS.MESSAGE || cls === QOS.RECEIPT || cls === QOS.TELEMETRY) return cls
  throw new Error(`qos: unknown class ${String(cls)}`)
}

/**
 * A strict-priority queue with per-class FIFO lanes and bounded size.
 *
 * Strict priority (not weighted fair) is correct at this scale: the classes
 * are few, the starvation case (an unbounded stream of call signals drowning
 * messages) cannot arise because call signalling is brief and bounded, and
 * strictness is what makes "the call connects" a guarantee rather than a
 * probability. Telemetry starving under load is not a bug — it is the shed
 * valve working.
 *
 * Bounded: when full, the LOWEST-priority droppable item is evicted to admit
 * a higher one; an arriving item that is itself the lowest is refused. A
 * non-droppable class (MESSAGE) is never evicted by this queue — backpressure
 * for messages is the congestion controller's job, upstream.
 */
export function createQosQueue ({ capacity = 512 } = {}) {
  if (!(capacity >= 1)) throw new Error('qos: capacity must be >= 1')
  const lanes = [[], [], [], []]   // one FIFO per class
  let size = 0
  let seq = 0
  const counters = { enqueued: 0, dequeued: 0, evicted: 0, refused: 0, expired: 0 }

  function evictLowestDroppable (below) {
    for (let cls = lanes.length - 1; cls > below; cls--) {
      if (!QOS_POLICY[cls].droppable) continue
      const lane = lanes[cls]
      if (lane.length) { lane.pop(); size--; counters.evicted++; return true }
    }
    return false
  }

  return Object.freeze({
    /** Enqueue `item` under `cls` at time `now`. Returns true if admitted. */
    enqueue (item, cls, now = 0) {
      const c = asQosClass(cls)
      if (size >= capacity && !evictLowestDroppable(c)) {
        counters.refused++
        return false
      }
      lanes[c].push({ item, cls: c, at: now, seq: seq++ })
      size++
      counters.enqueued++
      return true
    },

    /**
     * Dequeue the most urgent non-expired item at `now`. Expired droppables
     * (older than their class maxAgeMs) are shed during the scan — this is
     * where a stale typing indicator dies instead of wasting a send.
     */
    dequeue (now = 0) {
      for (let cls = 0; cls < lanes.length; cls++) {
        const lane = lanes[cls]
        while (lane.length) {
          const head = lane.shift()
          size--
          const policy = QOS_POLICY[cls]
          if (policy.droppable && now - head.at > policy.maxAgeMs) { counters.expired++; continue }
          counters.dequeued++
          return head
        }
      }
      return null
    },

    /** Peek class depths without disturbing order. */
    depths () { return lanes.map((l) => l.length) },
    get size () { return size },
    stats () { return { ...counters, size } }
  })
}
