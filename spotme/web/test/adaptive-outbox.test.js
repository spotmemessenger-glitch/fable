/**
 * OFFLINE MESSAGING — the durable outbox, the wipe path, congestion, and the
 * drain's ack-or-retry loop.
 *
 * The durable outbox runs against the shared IndexedDB fake (test/helpers/
 * fake-idb.js), whose backing map outlives a connection — so "queue, kill the
 * tab, reload, still owed" is a REAL restart test, not a mocked one. The
 * wipe-path check drives db.js's actual wipeDevice() and asserts the adaptive
 * store is on its demolition list.
 */

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=adaptivetest' }
globalThis.window = { location: globalThis.location }
const mem = new Map()
globalThis.localStorage = {
  get length () { return mem.size },
  key: (i) => Array.from(mem.keys())[i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}

import { makeIDB } from './helpers/fake-idb.js'
import {
  createDurableOutbox, wipeDurableOutbox, OUTBOX_DB_NAME
} from '../src/lib/transport-supervisor/durable-outbox.js'
import { assertImplementsOutbox } from '../src/lib/transport-supervisor/outbox.js'
import {
  createCongestionController, backoffDelay, BACKOFF_CLASSES
} from '../src/lib/transport-supervisor/congestion.js'
import { createOutboxDrainer } from '../src/lib/transport-supervisor/drain.js'
import { createMemoryOutbox } from '../src/lib/transport-supervisor/outbox.js'
import { createManualClock } from '../src/lib/transport-supervisor/clock.js'
import { QOS } from '../src/lib/transport-supervisor/qos.js'
import { makeSealedEnvelope } from '../src/lib/transport-supervisor/envelope.js'
import { makeOrderingToken } from '../src/lib/transport-supervisor/ordering.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const env = (n) => makeSealedEnvelope({
  roomId: 'room-1', origin: 'alice', ciphertext: `sealed-${n}`,
  ordering: makeOrderingToken({ senderClock: n, origin: 'alice' })
})

/* ========================== the durable outbox ========================== */

await checkAsync('the durable outbox satisfies IOutbox and SURVIVES A RELOAD', async () => {
  const backing = new Map()
  const box1 = createDurableOutbox({ idb: makeIDB(backing) })
  await box1.whenReady()
  assertImplementsOutbox(box1, 'durableOutbox')
  box1.enqueue('e1', { envelope: env(1), cls: QOS.MESSAGE }, 100)
  box1.enqueue('e2', { envelope: env(2), cls: QOS.MESSAGE }, 200)
  box1.markDelivered('e1')
  await box1.flush()
  box1.close()

  // "Reload": a NEW instance over the SAME backing map.
  const box2 = createDurableOutbox({ idb: makeIDB(backing) })
  await box2.whenReady()
  const owed = box2.pending(300).map((e) => e.id)
  return box1.durable === true && box2.durable === true &&
    owed.join(',') === 'e2' && box2.has('e1') === false &&
    box2.get('e2').item.envelope.ciphertext === 'sealed-2'
})

await checkAsync('enqueue is idempotent by id and keeps the ORIGINAL first-seen time (TTL cannot be reset)', async () => {
  const box = createDurableOutbox({ idb: makeIDB(new Map()), ttlMs: 1000 })
  await box.whenReady()
  box.enqueue('a', 'v1', 0)
  const e = box.enqueue('a', 'v2', 900)
  const stillOwed = box.pending(999).length === 1
  const expired = box.pending(1001).length === 0
  const swept = box.sweep(1001)
  return e.first === 0 && e.item === 'v2' && stillOwed && expired && swept.join(',') === 'a'
})

await checkAsync('no IndexedDB ⇒ HONEST memory-only degradation, not a crash', async () => {
  const box = createDurableOutbox({ idb: null })
  await box.whenReady()
  box.enqueue('x', 'v', 0)
  return box.durable === false && box.pending(0).length === 1
})

await checkAsync('a blocked open degrades to memory-only too (private mode / hostile tab)', async () => {
  const box = createDurableOutbox({ idb: makeIDB(new Map(), { failOpen: true }) })
  await box.whenReady()
  box.enqueue('x', 'v', 0)
  return box.durable === false && box.size === 1
})

/** The shared fake models open() only; deletion is wrapped locally. */
function idbWithDelete (backing) {
  const inner = makeIDB(backing)
  return {
    open: inner.open.bind(inner),
    deleteDatabase (name) {
      const req = {}
      queueMicrotask(() => { backing.delete(name); req.onsuccess?.() })
      return req
    }
  }
}

await checkAsync('wipeDurableOutbox deletes the database (the module-local hook)', async () => {
  const backing = new Map()
  const box = createDurableOutbox({ idb: idbWithDelete(backing) })
  await box.whenReady()
  box.enqueue('secret-ish', 'sealed bytes', 0)
  await box.flush()
  box.close()
  const failure = await wipeDurableOutbox({ idb: idbWithDelete(backing) })
  return failure === null && backing.has(OUTBOX_DB_NAME) === false
})

/* ==================== the wipe path: db.js knows us ==================== */

await checkAsync('db.js wipeDevice() has the adaptive outbox on its demolition list', async () => {
  // The same full stub shape wipe-device.test.js uses: deleteDatabase for the
  // named stores, open for blobstore's clearAll.
  const deleted = []
  globalThis.indexedDB = {
    deleteDatabase: (name) => { deleted.push(name); const req = {}; queueMicrotask(() => req.onsuccess?.()); return req },
    open: () => {
      const req = { result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        transaction: () => {
          const t = { objectStore: () => ({ clear: () => ({}) }) }
          queueMicrotask(() => t.oncomplete?.())
          return t
        }
      } }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
  const { wipeDevice } = await import('../src/lib/db.js')
  const out = await wipeDevice()
  delete globalThis.indexedDB
  return out.ok === true && deleted.includes(OUTBOX_DB_NAME) &&
    ['spotme-e2e', 'spotme-identity-pins', 'spotme-signing'].every((d) => deleted.includes(d))
})

/* ========================== congestion control ========================== */

check('AIMD: acks grow the window additively, a failure HALVES it, floor 1', () => {
  const c = createCongestionController({ config: { initialWindow: 4, maxWindow: 8 } })
  const w0 = c.window
  for (let i = 0; i < 20; i++) { c.launched(); c.acked() }
  const grown = c.window
  c.launched(); c.failed()
  const halved = c.window
  for (let i = 0; i < 10; i++) { c.launched(); c.failed() }
  return w0 === 4 && grown > 4 && grown <= 8 && halved === Math.floor(grown / 2) && c.window === 1
})

check('canSend respects the window: at most `window` in flight', () => {
  const c = createCongestionController({ config: { initialWindow: 2 } })
  const a = c.canSend(); c.launched()
  const b = c.canSend(); c.launched()
  const refused = c.canSend() === false
  c.acked()
  return a && b && refused && c.canSend() === true
})

check('pressure rises with failures and pinned windows; calm lanes read low', () => {
  const calm = createCongestionController({})
  const stressed = createCongestionController({})
  for (let i = 0; i < 6; i++) { stressed.launched(); stressed.failed() }
  return calm.pressure() < stressed.pressure() && stressed.pressure() <= 1
})

check('backoff classes: transient is fast, persistent is slow, both capped and jittered within bounds', () => {
  const t0 = backoffDelay('transient', 0, () => 0.5)   // ×1.0 jitter
  const p0 = backoffDelay('persistent', 0, () => 0.5)
  const tCap = backoffDelay('transient', 30, () => 0.5)
  const pCap = backoffDelay('persistent', 30, () => 0.5)
  const jLow = backoffDelay('transient', 0, () => 0)    // ×0.5
  const jHigh = backoffDelay('transient', 0, () => 1)   // ×1.5
  let unknown = false
  try { backoffDelay('vibes', 0) } catch { unknown = true }
  return t0 === BACKOFF_CLASSES.transient.baseMs && p0 === BACKOFF_CLASSES.persistent.baseMs &&
    tCap === BACKOFF_CLASSES.transient.maxMs && pCap === BACKOFF_CLASSES.persistent.maxMs &&
    jLow === t0 / 2 && jHigh === t0 * 1.5 && unknown
})

/* ============================== the drain ============================== */

function fakeSupervisor (script = {}) {
  const sent = []
  const ackedIds = []
  return {
    sent,
    ackedIds,
    async send (envelope) {
      if (script.failWith) { const e = new Error(script.failWith); e.code = script.code; throw e }
      sent.push(envelope.envelopeId)
      return { accepted: true, via: 'fake' }
    },
    acked (id) { ackedIds.push(id) }
  }
}

await checkAsync('ACK-OR-RETRY: a send alone does NOT settle the debt; only acked() does', async () => {
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  const sup = fakeSupervisor()
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  const e = env(1)
  drain.submit(e, QOS.MESSAGE)
  await drain.kick()
  const stillOwedAfterSend = outbox.has(e.envelopeId)
  drain.acked(e.envelopeId)
  return sup.sent.length === 1 && stillOwedAfterSend === true &&
    outbox.has(e.envelopeId) === false && sup.ackedIds.includes(e.envelopeId)
})

await checkAsync('an UNACKED envelope is re-sent on the transient backoff curve with the SAME envelopeId', async () => {
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  const sup = fakeSupervisor()
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  const e = env(2)
  drain.submit(e, QOS.MESSAGE)
  drain.start()
  clock.advance(1000)          // first drain tick → send #1
  await Promise.resolve()
  clock.advance(1100)          // past the 1s tick + first backoff (1000ms at rand .5)
  await Promise.resolve()
  clock.advance(2200)          // second backoff slot
  await Promise.resolve()
  drain.stop()
  const ids = new Set(sup.sent)
  return sup.sent.length >= 2 && ids.size === 1 && ids.has(e.envelopeId) && clock.pending === 0
})

await checkAsync('the congestion window BOUNDS a burst: a big backlog drains in window-sized waves', async () => {
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  const sup = fakeSupervisor()
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  for (let i = 1; i <= 20; i++) drain.submit(env(i), QOS.MESSAGE)
  await drain.kick()
  // initial AIMD window is 4: the first wave is exactly 4 sends.
  return sup.sent.length === 4
})

await checkAsync('priority: call-signal drains before a backlog of messages; stale telemetry is shed unsent', async () => {
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  const sup = fakeSupervisor()
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  drain.submit(env(1), QOS.MESSAGE)
  drain.submit(env(2), QOS.MESSAGE)
  drain.submit(env(3), QOS.TELEMETRY)
  clock.advance(20_000)                      // the typing signal goes stale in the queue
  drain.submit(env(4), QOS.CALL_SIGNAL)
  await drain.kick()
  const first = sup.sent[0]
  return first === env(4).envelopeId && !sup.sent.includes(env(3).envelopeId) &&
    sup.sent.includes(env(1).envelopeId) && sup.sent.includes(env(2).envelopeId)
})

await checkAsync('NO_TRANSPORT failures take the PERSISTENT backoff; messages stay owed, never dropped', async () => {
  const clock = createManualClock()
  const outbox = createMemoryOutbox({})
  const sup = fakeSupervisor({ failWith: 'no transport selected', code: 'NO_TRANSPORT' })
  const drain = createOutboxDrainer({ outbox, supervisor: sup, clock, rand: () => 0.5 })
  const e = env(5)
  drain.submit(e, QOS.MESSAGE)
  await drain.kick()      // fails; scheduled on the persistent curve (15s base)
  clock.advance(2000)
  await drain.kick()      // still inside the persistent backoff → deferred, no attempt
  const stats = drain.stats()
  return outbox.has(e.envelopeId) === true && stats.retried === 1 && stats.deferred >= 1
})

await checkAsync('a droppable class out of retries is ABANDONED and released; MESSAGE never is', async () => {
  // World 1: a RECEIPT whose sends always fail crosses its 8-retry policy cap
  // and is deliberately shed — a receipt we can never deliver is not a debt.
  const clock1 = createManualClock()
  const outbox1 = createMemoryOutbox({})
  const drain1 = createOutboxDrainer({ outbox: outbox1, supervisor: fakeSupervisor({ failWith: 'boom' }), clock: clock1, rand: () => 0.5 })
  const receipt = env(6)
  drain1.submit(receipt, QOS.RECEIPT)
  for (let i = 0; i < 12; i++) {
    await drain1.kick()
    clock1.advance(35_000)   // beyond any transient backoff slot
  }
  const receiptShed = outbox1.has(receipt.envelopeId) === false && drain1.stats().abandoned >= 1

  // World 2: a MESSAGE failing just as hard blows past even the transient
  // attempt cap (20) and is STILL owed — the conversation is never shed.
  const clock2 = createManualClock()
  const outbox2 = createMemoryOutbox({})
  const drain2 = createOutboxDrainer({ outbox: outbox2, supervisor: fakeSupervisor({ failWith: 'boom' }), clock: clock2, rand: () => 0.5 })
  const message = env(7)
  drain2.submit(message, QOS.MESSAGE)
  for (let i = 0; i < 25; i++) {
    await drain2.kick()
    clock2.advance(35_000)
  }
  const messageKept = outbox2.has(message.envelopeId) === true && drain2.stats().abandoned === 0
  return receiptShed && messageKept
})

await checkAsync('BACKGROUND-SYNC SEMANTICS: a reloaded outbox drains on start() without re-submission', async () => {
  const clock = createManualClock()
  const backing = new Map()
  const box1 = createDurableOutbox({ idb: makeIDB(backing) })
  await box1.whenReady()
  const drain1 = createOutboxDrainer({ outbox: box1, supervisor: fakeSupervisor({ failWith: 'offline', code: 'NO_TRANSPORT' }), clock })
  drain1.submit(env(8), QOS.MESSAGE)
  await drain1.kick()          // offline: still owed
  await box1.flush()
  box1.close()

  // Reload: new outbox over the same backing, new drain, transport now up.
  const box2 = createDurableOutbox({ idb: makeIDB(backing) })
  await box2.whenReady()
  const sup = fakeSupervisor()
  const drain2 = createOutboxDrainer({ outbox: box2, supervisor: sup, clock, rand: () => 0.5 })
  drain2.start()               // reschedulePending() picks the debt up
  clock.advance(1000)
  await Promise.resolve()
  drain2.stop()
  return sup.sent.length === 1 && sup.sent[0] === env(8).envelopeId && clock.pending === 0
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive outbox — durability, wipe, congestion, drain')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
