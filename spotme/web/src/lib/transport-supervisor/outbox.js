/**
 * Spot Me — the store-and-forward OUTBOX interface. Priority 2, ADR-012.
 * SCAFFOLDING ONLY (flag off, not wired). Pure logic — `now` is injected.
 *
 * GENERALISES reach.js's durable outbox WITHOUT touching it. reach.js holds a
 * `Map peerId -> { room, payload, first }`, flushes on peer-join, drops entries
 * on delivery or after `OUTBOX_TTL_MS` (24h). That shape is exactly what a mesh
 * needs too: a message you could not deliver now, held until the recipient is
 * reachable, and abandoned once it is stale. This file lifts that shape into a
 * transport-agnostic contract so the adaptive layer can reuse ONE outbox across
 * Socket.IO, relay, and Bluetooth mesh instead of each growing its own.
 *
 * IOUTBOX — the contract every backing store must satisfy:
 *   enqueue(id, item, now)   idempotent by id; store an item still owed
 *   markDelivered(id)        acknowledge; the debt is paid, drop it
 *   pending(now)             items still owed and not yet expired
 *   sweep(now)               drop expired items, return their ids
 *   has(id) / size           inspection
 *
 * A reference in-memory implementation is provided for tests and benchmarks. A
 * DURABLE implementation (IndexedDB, or the server relay reach.js already uses)
 * is DEFERRED to wiring — the point here is the contract, not the storage.
 */

/** The method names an outbox backing store must provide. */
export const IOUTBOX_METHODS = Object.freeze(['enqueue', 'markDelivered', 'pending', 'sweep', 'has'])

/** Throw unless `store` satisfies IOutbox — same "contract as a test" stance as
 *  the transport contracts. */
export function assertImplementsOutbox (store, label = 'outbox') {
  if (!store || typeof store !== 'object') throw new Error(`${label}: not an object`)
  for (const m of IOUTBOX_METHODS) {
    if (typeof store[m] !== 'function') throw new Error(`${label}: missing required method ${m}()`)
  }
}

/**
 * In-memory reference outbox. `ttlMs` mirrors reach.js's 24h default — a request
 * abandoned earlier than that is the bug reach.js's comment calls out ("was 10
 * min, which silently abandoned most requests"), so the default is generous on
 * purpose.
 *
 * Entries are OPAQUE to the outbox: `item` is whatever the caller must re-send
 * (a SealedEnvelope, a knock payload). The outbox never inspects it — it only
 * remembers, expires, and forgets. Idempotent by `id`: enqueuing an id already
 * present keeps the ORIGINAL `first` timestamp, so a re-enqueue does not reset
 * the TTL and accidentally keep a stale item alive forever.
 */
export function createMemoryOutbox ({ ttlMs = 24 * 60 * 60_000 } = {}) {
  const items = new Map()   // id -> { id, item, first, delivered }

  return {
    enqueue (id, item, now = 0) {
      if (!id) throw new Error('outbox: id required')
      const existing = items.get(id)
      if (existing) { existing.item = item; return existing }   // keep original `first`
      const entry = { id, item, first: now, delivered: false }
      items.set(id, entry)
      return entry
    },

    markDelivered (id) {
      const entry = items.get(id)
      if (!entry) return false
      items.delete(id)   // a paid debt is simply gone; no tombstone needed here
      return true
    },

    /** Items still owed: not delivered and not past TTL. */
    pending (now = 0) {
      const out = []
      for (const e of items.values()) {
        if (!e.delivered && now - e.first <= ttlMs) out.push(e)
      }
      return out
    },

    /** Drop everything past TTL; return the ids dropped so a caller can log/close. */
    sweep (now = 0) {
      const dropped = []
      for (const [id, e] of items) {
        if (now - e.first > ttlMs) { items.delete(id); dropped.push(id) }
      }
      return dropped
    },

    has (id) { return items.has(id) },
    get size () { return items.size }
  }
}
