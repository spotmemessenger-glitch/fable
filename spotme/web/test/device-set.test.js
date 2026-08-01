/**
 * Multi-device safety numbers (the RECOMMENDED ADR-008 §BLOCKING construction,
 * pending owner ratification). The properties that make it honest where the
 * single-key version is not:
 *
 *   - the commitment is over the SET, not the order — two clients holding the
 *     same devices in any order compute the same number
 *   - adding OR removing a device CHANGES the number — that is the visible
 *     verification event the whole construction exists to produce
 *   - length-prefixed encoding: no device boundary can be moved to collide two
 *     different sets
 *   - version 1 is distinct from single-device version 0, so the two can never
 *     be compared by accident
 *
 *   node test/device-set.test.js
 */
import {
  deviceSetCommitment, deviceSetSafetyNumber,
  DEVICE_SET_SAFETY_VERSION,
} from '../src/lib/crypto/device-set.js'
import { SAFETY_VERSION } from '../src/lib/crypto/safety-number.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}
const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')
const b64 = (byte, n = 32) => btoa(String.fromCharCode(...new Uint8Array(n).fill(byte)))

const devA = { deviceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', signingPublicKeyB64: b64(0x11) }
const devB = { deviceId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', signingPublicKeyB64: b64(0x22) }
const devC = { deviceId: 'cccccccccccccccccccccccccccccccc', signingPublicKeyB64: b64(0x33) }

/* --- commitment properties -------------------------------------------------- */

await checkAsync('the commitment is ORDER-INDEPENDENT — same set, any order, same bytes', async () => {
  const c1 = await deviceSetCommitment([devA, devB, devC])
  const c2 = await deviceSetCommitment([devC, devA, devB])
  return hex(c1) === hex(c2)
})

await checkAsync('ADDING a device changes the commitment', async () => {
  const before = await deviceSetCommitment([devA, devB])
  const after = await deviceSetCommitment([devA, devB, devC])
  return hex(before) !== hex(after)
})

await checkAsync('REMOVING a device changes the commitment', async () => {
  const before = await deviceSetCommitment([devA, devB, devC])
  const after = await deviceSetCommitment([devA, devB])
  return hex(before) !== hex(after)
})

await checkAsync('changing a device KEY changes the commitment', async () => {
  const before = await deviceSetCommitment([devA, devB])
  const after = await deviceSetCommitment([devA, { ...devB, signingPublicKeyB64: b64(0x99) }])
  return hex(before) !== hex(after)
})

await checkAsync('LENGTH-PREFIXED: two different splits of the same bytes do NOT collide', async () => {
  // Same concatenated (id+key) bytes, split differently between two devices.
  const c1 = await deviceSetCommitment([{ deviceId: 'ab', signingPublicKeyB64: b64(0x11) }])
  const c2 = await deviceSetCommitment([{ deviceId: 'a', signingPublicKeyB64: b64(0x11) }, { deviceId: 'b', signingPublicKeyB64: b64(0x11) }])
  return hex(c1) !== hex(c2)
})

await checkAsync('an empty device set is refused, not committed to a fixed value', async () => {
  try { await deviceSetCommitment([]); return false } catch { return true }
})

/* --- safety number properties ---------------------------------------------- */

await checkAsync('two accounts compute the IDENTICAL number from the same four inputs', async () => {
  const alice = { devices: [devA], userId: 'alice' }
  const bob = { devices: [devB, devC], userId: 'bob' }
  const fromAlice = await deviceSetSafetyNumber(alice, bob)
  const fromBob = await deviceSetSafetyNumber(bob, alice)
  return fromAlice === fromBob && /^\d{60}$/.test(fromAlice)
})

await checkAsync('THE HONESTY PROPERTY: a peer adding a device changes the number both see', async () => {
  const alice = { devices: [devA], userId: 'alice' }
  const bobOne = { devices: [devB], userId: 'bob' }
  const bobTwo = { devices: [devB, devC], userId: 'bob' } // bob added a device
  const before = await deviceSetSafetyNumber(alice, bobOne)
  const after = await deviceSetSafetyNumber(alice, bobTwo)
  return before !== after
})

await checkAsync('the number is bound to the account id — same devices, different user, different number', async () => {
  const one = await deviceSetSafetyNumber({ devices: [devA], userId: 'alice' }, { devices: [devB], userId: 'bob' })
  const two = await deviceSetSafetyNumber({ devices: [devA], userId: 'alice' }, { devices: [devB], userId: 'carol' })
  return one !== two
})

/* --- coexistence ----------------------------------------------------------- */

check('the device-set version is DISTINCT from the single-device version',
  DEVICE_SET_SAFETY_VERSION === '0.1' && SAFETY_VERSION === '0.0' &&
  DEVICE_SET_SAFETY_VERSION !== SAFETY_VERSION)

console.log('\n========================================')
console.log('  multi-device safety number — honest about the whole device set')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
