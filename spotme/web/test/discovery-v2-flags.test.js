/**
 * Discovery V2 flags — proves the subsystem ships DARK and that the master gate
 * is a hard AND no sub-flag can defeat.
 *
 *   node test/discovery-v2-flags.test.js
 */
import {
  SHIPPED_FLAGS, FEATURE_KEYS, resolveFlags, isFullyDark, assertShippedDark
} from '../src/lib/discovery-v2/flags.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

check('SHIPPED_FLAGS is fully dark (every value false)',
  Object.values(SHIPPED_FLAGS).every((v) => v === false))

check('isFullyDark(SHIPPED_FLAGS) is true', isFullyDark(SHIPPED_FLAGS))

check('assertShippedDark passes on the shipped config', assertShippedDark(SHIPPED_FLAGS) === true)

check('assertShippedDark THROWS if MASTER is lit', (() => {
  try { assertShippedDark({ ...SHIPPED_FLAGS, MASTER: true }); return false } catch { return true }
})())

check('assertShippedDark THROWS if any sub-flag is lit', (() => {
  try { assertShippedDark({ ...SHIPPED_FLAGS, ranking: true }); return false } catch { return true }
})())

check('master gate is a hard AND: a sub-flag alone cannot switch on', (() => {
  const f = resolveFlags({ ranking: true, placeSearch: true }) // MASTER stays false
  return f.MASTER === false && FEATURE_KEYS.every((k) => f[k] === false)
})())

check('with MASTER on, only explicitly-set sub-flags light up', (() => {
  const f = resolveFlags({ MASTER: true, ranking: true })
  return f.MASTER === true && f.ranking === true &&
    FEATURE_KEYS.filter((k) => k !== 'ranking').every((k) => f[k] === false)
})())

check('resolveFlags() with no args returns the shipped dark config', (() => {
  const f = resolveFlags()
  return f.MASTER === false && FEATURE_KEYS.every((k) => f[k] === false)
})())

check('resolved flags are frozen (cannot be mutated on live)', (() => {
  const f = resolveFlags({ MASTER: true })
  try { f.ranking = true } catch { /* strict throw is fine */ }
  return f.ranking === false
})())

check('flags come from module constants, not localStorage/env at read time', (() => {
  // No global read: resolving with no args always yields the shipped dark
  // config, independent of any ambient state.
  const first = JSON.stringify(resolveFlags())
  const shipped = JSON.stringify({ ...SHIPPED_FLAGS })
  return first === shipped
})())

console.log('\n========== discovery-v2 flags ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
