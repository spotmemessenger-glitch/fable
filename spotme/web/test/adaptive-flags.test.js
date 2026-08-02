/**
 * Adaptive network FLAGS — layered, all false, and the OFF-state is inert.
 *
 * Three claims, each executable:
 *   1. Every shipped flag is FALSE (the build ships dark).
 *   2. LAYERING: a sub-flag is never effective while its parent is off —
 *      "sub never outlives master" — including the deep chain
 *      MULTIHOP → BLUETOOTH_MESH → OFFLINE_MESSAGING → master.
 *   3. `createAdaptiveNetwork` with the shipped flags constructs NOTHING:
 *      no timers (proven with a clock that throws on any use), no storage
 *      (proven with an idb that throws on open), no supervisor/mesh/outbox.
 */
import {
  DEFAULT_FLAGS, FLAG_NAMES, FLAG_PARENT, resolveFlags, isMasterEnabled, assertShippedDark
} from '../src/lib/transport-supervisor/flags.js'
import { createAdaptiveNetwork } from '../src/lib/transport-supervisor/network.js'
import { ADAPTIVE_TRANSPORT_ENABLED } from '../src/lib/transport-supervisor/index.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ============================ shipped dark ============================ */

check('every shipped flag is false, and assertShippedDark agrees', () => {
  for (const k of FLAG_NAMES) if (DEFAULT_FLAGS[k] !== false) return false
  return assertShippedDark() === true && isMasterEnabled() === false
})

check('the scaffold-era wiring flag is ALSO still false (two independent offs)', () => {
  return ADAPTIVE_TRANSPORT_ENABLED === false
})

check('the flag set is exactly the seven ADR-012b names', () => {
  return FLAG_NAMES.join(',') === [
    'ADAPTIVE_NETWORK_ENABLED', 'TRANSPORT_SUPERVISOR_ENABLED', 'AUTO_TRANSPORT_ENABLED',
    'OFFLINE_MESSAGING_ENABLED', 'BLUETOOTH_MESH_ENABLED', 'MULTIHOP_ENABLED', 'LOCAL_NETWORK_ENABLED'
  ].join(',')
})

/* ============================== layering ============================== */

check('a sub-flag set true is NOT effective while the master is off', () => {
  const eff = resolveFlags({ ADAPTIVE_NETWORK_ENABLED: false, TRANSPORT_SUPERVISOR_ENABLED: true, BLUETOOTH_MESH_ENABLED: true })
  return eff.TRANSPORT_SUPERVISOR_ENABLED === false && eff.BLUETOOTH_MESH_ENABLED === false
})

check('the deep chain: MULTIHOP needs mesh needs offline-messaging needs master', () => {
  // Everything on except one middle link — the break cascades downward.
  const broken = resolveFlags({
    ADAPTIVE_NETWORK_ENABLED: true, OFFLINE_MESSAGING_ENABLED: false,
    BLUETOOTH_MESH_ENABLED: true, MULTIHOP_ENABLED: true
  })
  const whole = resolveFlags({
    ADAPTIVE_NETWORK_ENABLED: true, OFFLINE_MESSAGING_ENABLED: true,
    BLUETOOTH_MESH_ENABLED: true, MULTIHOP_ENABLED: true
  })
  return broken.MULTIHOP_ENABLED === false && broken.BLUETOOTH_MESH_ENABLED === false &&
    whole.MULTIHOP_ENABLED === true && whole.BLUETOOTH_MESH_ENABLED === true
})

check('AUTO_TRANSPORT is layered under the supervisor, not directly under master', () => {
  const eff = resolveFlags({ ADAPTIVE_NETWORK_ENABLED: true, TRANSPORT_SUPERVISOR_ENABLED: false, AUTO_TRANSPORT_ENABLED: true })
  return eff.AUTO_TRANSPORT_ENABLED === false && FLAG_PARENT.AUTO_TRANSPORT_ENABLED === 'TRANSPORT_SUPERVISOR_ENABLED'
})

check('every flag has a parent chain that terminates at the master', () => {
  for (const name of FLAG_NAMES) {
    let cur = name
    let hops = 0
    while (FLAG_PARENT[cur] != null) {
      cur = FLAG_PARENT[cur]
      if (++hops > FLAG_NAMES.length) return false
    }
    if (cur !== 'ADAPTIVE_NETWORK_ENABLED') return false
  }
  return true
})

check('resolveFlags ignores unknown keys and non-boolean values', () => {
  const eff = resolveFlags({ NOT_A_FLAG: true, ADAPTIVE_NETWORK_ENABLED: 'yes' })
  return !('NOT_A_FLAG' in eff) && eff.ADAPTIVE_NETWORK_ENABLED === false
})

/* ===================== the OFF-state constructs NOTHING ===================== */

const throwingClock = new Proxy({}, {
  get () { throw new Error('OFF-state touched the clock — a timer was constructed while the master flag is off') }
})
const throwingIdb = new Proxy({}, {
  get () { throw new Error('OFF-state touched IndexedDB while the master flag is off') }
})

await checkAsync('createAdaptiveNetwork with shipped flags is an inert stub — no clock, no idb, no engines', async () => {
  const net = createAdaptiveNetwork({ clock: throwingClock, idb: throwingIdb, deliver: () => {} })
  const started = await net.start()
  net.stop()
  return net.enabled === false && /ADAPTIVE_NETWORK_ENABLED is false/.test(net.reason) &&
    net.supervisor === null && net.drainer === null && net.mesh === null &&
    net.registry === null && started === false
})

await checkAsync('…and with the master off, even all-subs-true constructs nothing', async () => {
  const net = createAdaptiveNetwork({
    flags: {
      ADAPTIVE_NETWORK_ENABLED: false,
      TRANSPORT_SUPERVISOR_ENABLED: true, AUTO_TRANSPORT_ENABLED: true,
      OFFLINE_MESSAGING_ENABLED: true, BLUETOOTH_MESH_ENABLED: true,
      MULTIHOP_ENABLED: true, LOCAL_NETWORK_ENABLED: true
    },
    clock: throwingClock,
    idb: throwingIdb
  })
  return net.enabled === false && net.supervisor === null && net.mesh === null
})

check('an enabled composition constructs the engines (injected flags = DI, not a runtime override)', () => {
  // A manual-clock composition proves the factory wires when told to — and
  // that timers stay unarmed until start().
  const timers = { armed: 0 }
  const clock = {
    now: () => 0,
    setTimeout: () => { timers.armed++; return 1 },
    clearTimeout: () => {},
    setInterval: () => { timers.armed++; return 1 },
    clearInterval: () => {}
  }
  const net = createAdaptiveNetwork({
    flags: { ADAPTIVE_NETWORK_ENABLED: true, TRANSPORT_SUPERVISOR_ENABLED: true, OFFLINE_MESSAGING_ENABLED: true },
    clock,
    deliver: () => {},
    durableOutbox: false   // memory outbox: this check is about timers, not idb
  })
  return net.enabled === true && net.supervisor !== null && net.drainer !== null &&
    net.mesh === null &&              // mesh flag off ⇒ no mesh engine
    timers.armed === 0                // NOTHING armed before start()
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive flags — layered, dark, inert off-state')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
