/**
 * Live Nearby Events flags — ships DARK, hard master gate.
 *   node test/live-events-flags.test.js
 */
import {
  SHIPPED_FLAGS, FEATURE_KEYS, resolveFlags, isFullyDark, assertShippedDark
} from '../src/lib/live-events/flags.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

check('SHIPPED_FLAGS is fully dark', Object.values(SHIPPED_FLAGS).every((v) => v === false))
check('isFullyDark(SHIPPED_FLAGS)', isFullyDark(SHIPPED_FLAGS))
check('assertShippedDark passes on shipped config', assertShippedDark(SHIPPED_FLAGS) === true)
check('assertShippedDark throws if MASTER lit', (() => {
  try { assertShippedDark({ ...SHIPPED_FLAGS, MASTER: true }); return false } catch { return true }
})())
check('assertShippedDark throws if a sub-flag lit', (() => {
  try { assertShippedDark({ ...SHIPPED_FLAGS, discovery: true }); return false } catch { return true }
})())
check('master gate is a hard AND: sub-flag alone cannot switch on', (() => {
  const f = resolveFlags({ discovery: true, ranking: true })
  return f.MASTER === false && FEATURE_KEYS.every((k) => f[k] === false)
})())
check('with MASTER on, only set sub-flags light', (() => {
  const f = resolveFlags({ MASTER: true, discovery: true })
  return f.discovery === true && FEATURE_KEYS.filter((k) => k !== 'discovery').every((k) => f[k] === false)
})())
check('resolveFlags() with no args = shipped dark', (() => {
  const f = resolveFlags()
  return f.MASTER === false && FEATURE_KEYS.every((k) => f[k] === false)
})())
check('resolved flags are frozen', (() => {
  const f = resolveFlags({ MASTER: true })
  try { f.discovery = true } catch { /* strict throw ok */ }
  return f.discovery === false
})())

console.log('\n========== live-events flags ==========')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log(`  ${passed}/${names.length} passed\n`)
process.exit(passed === names.length ? 0 : 1)
