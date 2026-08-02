/**
 * Bluetooth MESH — bounded flooding: seen-set / TTL / hopcount (ADR-012).
 *
 * Pure functions, no radio. This is the routing logic a native BLE mesh would
 * drive; the radio itself is Priority 10 (native app). Scaffolding only — flag
 * off, not wired.
 */
import {
  makeMeshFrame, forward, createSeenSet, receiveMeshFrame, MESH_ACTION
} from '../src/lib/transport-supervisor/mesh.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const frame = (over = {}) => makeMeshFrame({ origin: 'O', seq: 1, payload: 'c2VhbGVk', ttl: 3, hop: 0, ...over })

/* ============================== frame id =============================== */

check('a frameId is stable across nodes for the same origin+seq+payload', () => {
  const a = makeMeshFrame({ origin: 'O', seq: 7, payload: 'aGVsbG8=', ttl: 3 })
  const b = makeMeshFrame({ origin: 'O', seq: 7, payload: 'aGVsbG8=', ttl: 3 })
  return a.frameId === b.frameId && a.frameId.startsWith('mf_')
})

check('a different payload yields a different frameId', () => {
  const a = makeMeshFrame({ origin: 'O', seq: 7, payload: 'aGVsbG8=', ttl: 3 })
  const b = makeMeshFrame({ origin: 'O', seq: 7, payload: 'Z29vZGJ5', ttl: 3 })
  return a.frameId !== b.frameId
})

/* =============================== forward ============================== */

check('forward() advances hop by one and copies the payload through untouched', () => {
  const f = frame({ hop: 0 })
  const g = forward(f)
  return g.hop === 1 && g.payload === f.payload && g.frameId === f.frameId && g.origin === f.origin
})

check('forward() does not mutate its input', () => {
  const f = frame({ hop: 2 })
  forward(f)
  return f.hop === 2
})

/* ========================= bounded flooding ========================== */

check('a fresh, in-TTL, foreign frame is delivered AND forwarded one hop on', () => {
  const seen = createSeenSet()
  const r = receiveMeshFrame(frame({ hop: 0, ttl: 3 }), { seen, selfId: 'me', now: 0 })
  return r.action === MESH_ACTION.DELIVER_AND_FORWARD && r.deliver === true && r.forward.hop === 1
})

check('the SECOND sighting of a frame is dropped as a duplicate (kills the storm)', () => {
  const seen = createSeenSet()
  const f = frame()
  receiveMeshFrame(f, { seen, selfId: 'me', now: 0 })
  const r = receiveMeshFrame(f, { seen, selfId: 'me', now: 1 })
  return r.action === MESH_ACTION.DROP_DUPLICATE && r.forward === null && r.deliver === false
})

check('a frame whose next hop would exceed TTL is delivered but NOT forwarded', () => {
  const seen = createSeenSet()
  const r = receiveMeshFrame(frame({ hop: 2, ttl: 2 }), { seen, selfId: 'me', now: 0 })  // 2+1 > 2
  return r.action === MESH_ACTION.DELIVER_ONLY && r.deliver === true && r.forward === null
})

check('a node never re-forwards a frame that originated with itself', () => {
  const seen = createSeenSet()
  const r = receiveMeshFrame(frame({ origin: 'me', hop: 0, ttl: 5 }), { seen, selfId: 'me', now: 0 })
  return r.action === MESH_ACTION.DELIVER_ONLY && r.forward === null
})

check('a malformed frame is dropped as invalid', () => {
  const seen = createSeenSet()
  const r = receiveMeshFrame({ nope: true }, { seen, selfId: 'me', now: 0 })
  return r.action === MESH_ACTION.DROP_INVALID
})

check('flooding a line of relays TERMINATES at the TTL bound', () => {
  // ttl=2: O -> n1 (hop0->1) -> n2 (hop1->2) -> n3 (hop2, 2+1>2 so no forward).
  let f = makeMeshFrame({ origin: 'O', seq: 1, payload: 'eA==', ttl: 2, hop: 0 })
  let forwards = 0
  for (const self of ['n1', 'n2', 'n3', 'n4']) {
    const seen = createSeenSet()   // each node its own memory
    const r = receiveMeshFrame(f, { seen, selfId: self, now: 0 })
    if (r.forward) { forwards++; f = r.forward } else break
  }
  // n1 and n2 forward; n3 receives hop=2 and stops. Exactly two forwards.
  return forwards === 2 && f.hop === 2
})

/* ============================== seen-set ============================== */

check('the seen-set expires an id after its TTL', () => {
  const seen = createSeenSet({ ttlMs: 1000 })
  seen.remember('id-1', 0)
  return seen.has('id-1', 500) === true && seen.has('id-1', 1500) === false
})

check('the seen-set evicts the oldest id past capacity', () => {
  const seen = createSeenSet({ capacity: 2, ttlMs: 60_000 })
  seen.remember('a', 0); seen.remember('b', 0); seen.remember('c', 0)
  return seen.has('a', 0) === false && seen.has('b', 0) === true && seen.has('c', 0) === true && seen.size === 2
})

check('re-remembering an id refreshes it rather than duplicating it', () => {
  const seen = createSeenSet({ capacity: 2, ttlMs: 1000 })
  seen.remember('a', 0)
  seen.remember('a', 500)          // refresh
  return seen.size === 1 && seen.has('a', 1200) === true && seen.has('a', 1600) === false
})

/* -------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  bluetooth mesh — bounded flooding')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
if (passed !== names.length) process.exit(1)
