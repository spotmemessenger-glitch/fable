/**
 * Creative Studio drafts — lifecycle against the shared IndexedDB fake, the
 * flag-off inertness (a THROWING idb proxy proves "never touched"), TTL and
 * corruption behavior, LRU eviction, and the wipe path: wipeDevice() must
 * delete 'spotme-studio-drafts'.
 *
 *   node test/studio-drafts.test.js
 */
import { makeIDB } from './helpers/fake-idb.js'
import { createDraftsStore, DRAFTS_DB, MAX_DRAFTS } from '../src/lib/studio/drafts.js'
import { manualClock } from '../src/lib/studio/clock.js'
import { resolveFlags } from '../src/lib/studio/flags.js'
import { createEditDoc } from '../src/lib/studio/opdoc.js'

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* The dark default can never produce a lit flag set, so the lifecycle tests
 * build one by hand — exactly what the integration wiring will do post-
 * owner-approval. */
const LIT = Object.freeze({ ...resolveFlags({}), STUDIO_DRAFTS_ENABLED: true })

const doc = (ref = 'blob:src-1') => {
  const d = createEditDoc({ source: { w: 100, h: 80, ref } })
  d.addOp({ op: 'exposure', v: 1, params: { ev: 0.5 } })
  return d
}

/* ----------------------------------------------------------- inertness */

await checkAsync('FLAG OFF: a throwing idb fake is NEVER touched by any method', async () => {
  const boobyTrap = new Proxy({}, { get () { throw new Error('idb touched while dark') } })
  const store = createDraftsStore({ flags: resolveFlags({}), clock: manualClock(), idb: boobyTrap })
  const saved = await store.save({ doc: doc() })
  const listed = await store.list()
  const opened = await store.openDraft('x')
  const removed = await store.remove('x')
  return store.available() === false && saved.reason === 'disabled' &&
    listed.reason === 'disabled' && opened.reason === 'disabled' && removed === false
})

await checkAsync('no IndexedDB at all answers unavailable, never throws', async () => {
  const store = createDraftsStore({ flags: LIT, clock: manualClock(), idb: null })
  const saved = await store.save({ doc: doc() })
  const listed = await store.list()
  return store.available() === false && saved.reason === 'unavailable' && listed.reason === 'unavailable'
})

/* ------------------------------------------------------------ lifecycle */

await checkAsync('save → list → openDraft restores the document with its ops', async () => {
  const clock = manualClock(1000)
  const store = createDraftsStore({ flags: LIT, clock, idb: makeIDB() })
  const saved = await store.save({ doc: doc(), refs: ['blob:src-1'], thumb: 'data:image/jpeg;base64,xx' })
  if (!saved.ok) return false
  const { drafts, skipped } = await store.list()
  const opened = await store.openDraft(saved.id)
  return drafts.length === 1 && skipped === 0 && drafts[0].thumb !== null &&
    opened.ok && opened.doc.opCount() === 1 && opened.doc.activeOps()[0].op === 'exposure' &&
    opened.refs[0] === 'blob:src-1'
})

await checkAsync('a draft saved mid-undo restores exactly the active slice', async () => {
  const store = createDraftsStore({ flags: LIT, clock: manualClock(), idb: makeIDB() })
  const d = doc()
  d.addOp({ op: 'contrast', v: 1, params: { amount: 0.4 } })
  d.undo()
  const saved = await store.save({ doc: d })
  const opened = await store.openDraft(saved.id)
  return opened.ok && opened.doc.opCount() === 1 && !opened.doc.canRedo()
})

await checkAsync('an unparseable document is refused at save time', async () => {
  const store = createDraftsStore({ flags: LIT, clock: manualClock(), idb: makeIDB() })
  const out = await store.save({ doc: '{"kind":"garbage"}' })
  return out.ok === false && /invalid document/.test(out.reason)
})

await checkAsync('TTL: an expired draft is skipped by list AND deleted', async () => {
  const clock = manualClock(0)
  const backing = new Map()
  const store = createDraftsStore({ flags: LIT, clock, idb: makeIDB(backing) })
  const saved = await store.save({ doc: doc(), ttlMs: 5000 })
  clock.advance(6000)
  const { drafts, skipped } = await store.list()
  const gone = !backing.get(DRAFTS_DB).stores.get('drafts').data.has(saved.id)
  return drafts.length === 0 && skipped === 0 && gone
})

await checkAsync('TTL: openDraft on an expired id answers expired and removes it', async () => {
  const clock = manualClock(0)
  const store = createDraftsStore({ flags: LIT, clock, idb: makeIDB() })
  const saved = await store.save({ doc: doc(), ttlMs: 100 })
  clock.advance(200)
  const out = await store.openDraft(saved.id)
  return out.ok === false && out.reason === 'expired'
})

await checkAsync('a draft with no TTL survives the clock', async () => {
  const clock = manualClock(0)
  const store = createDraftsStore({ flags: LIT, clock, idb: makeIDB() })
  await store.save({ doc: doc() })
  clock.advance(1e9)
  const { drafts } = await store.list()
  return drafts.length === 1
})

await checkAsync('CORRUPTION: a bad record is skipped, COUNTED, and deleted — the rest load', async () => {
  const clock = manualClock(0)
  const backing = new Map()
  const idb = makeIDB(backing)
  const store = createDraftsStore({ flags: LIT, clock, idb })
  await store.save({ doc: doc(), id: 'good' })
  // Poison two rows straight in the backing store, as disk corruption would.
  const data = backing.get(DRAFTS_DB).stores.get('drafts').data
  data.set('bad1', { id: 'bad1', updatedAt: 5, doc: 'NOT JSON AT ALL', refs: [] })
  data.set('bad2', { id: 'bad2', updatedAt: 6 })
  const { drafts, skipped } = await store.list()
  return drafts.length === 1 && drafts[0].id === 'good' && skipped === 2 &&
    !data.has('bad1') && !data.has('bad2')
})

await checkAsync('LRU: the count cap evicts the oldest-updated drafts', async () => {
  const clock = manualClock(0)
  const store = createDraftsStore({ flags: LIT, clock, idb: makeIDB() })
  for (let i = 0; i < MAX_DRAFTS + 5; i++) {
    clock.advance(10)
    await store.save({ doc: doc(), id: `d${i}` })
  }
  const { drafts } = await store.list()
  const ids = new Set(drafts.map((d) => d.id))
  return drafts.length === MAX_DRAFTS && !ids.has('d0') && !ids.has('d4') && ids.has('d5') && ids.has(`d${MAX_DRAFTS + 4}`)
})

await checkAsync('updating the same id refreshes recency instead of duplicating', async () => {
  const clock = manualClock(0)
  const store = createDraftsStore({ flags: LIT, clock, idb: makeIDB() })
  await store.save({ doc: doc(), id: 'same' })
  clock.advance(50)
  await store.save({ doc: doc(), id: 'same' })
  const { drafts } = await store.list()
  return drafts.length === 1 && drafts[0].updatedAt === 50
})

/* ------------------------------------------------------------- the wipe */

await checkAsync('wipeDevice() deletes spotme-studio-drafts (and stays ok when it succeeds)', async () => {
  globalThis.location = { hostname: 'localhost', href: 'http://localhost/' }
  globalThis.window = { location: globalThis.location }
  const mem = new Map()
  globalThis.localStorage = {
    get length () { return mem.size },
    key: (i) => Array.from(mem.keys())[i] ?? null,
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k)
  }
  const deleted = []
  globalThis.indexedDB = {
    deleteDatabase: (name) => {
      deleted.push(name)
      const req = {}
      queueMicrotask(() => req.onsuccess?.())
      return req
    },
    open: () => {
      const req = {
        result: {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({}),
          transaction: () => {
            const t = { objectStore: () => ({ clear: () => ({}) }) }
            queueMicrotask(() => t.oncomplete?.())
            return t
          }
        }
      }
      queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.() })
      return req
    }
  }
  const { wipeDevice } = await import('../src/lib/db.js')
  const out = await wipeDevice()
  return deleted.includes('spotme-studio-drafts') && out.ok === true
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio drafts — lifecycle, TTL, wipe')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
