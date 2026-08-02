/**
 * Proves the camera platform's flag layering and its clock discipline.
 *
 * The claims that matter:
 *   - every flag ships FALSE, and assertShippedDark enforces it
 *   - a child flag is effective only through a fully-lit ancestor chain, so
 *     no leaf can light a dark platform, and the master darkens everything
 *   - a typo'd flag name fails loudly instead of shipping a phantom flag
 *   - the manual clock runs timers deterministically, withTimeout names its
 *     failures and never leaks its own timer
 *
 *   node test/camera-flags.test.js
 */
import {
  DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, isMasterEnabled, assertShippedDark,
} from '../src/lib/camera/flags.js'
import { manualClock, throwingClock, withTimeout, TimeoutError } from '../src/lib/camera/clock.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  try { check(name, (await fn()) === true) } catch (e) { check(`${name} [threw: ${e.message}]`, false) }
}

/* ----------------------------------------------------- 1. shipped dark ---- */

check('every default flag is false',
  Object.values(DEFAULT_FLAGS).every((v) => v === false))
check('assertShippedDark passes on the shipped defaults',
  assertShippedDark() === true)
check('assertShippedDark THROWS the moment any flag is not false', (() => {
  try { assertShippedDark({ ...DEFAULT_FLAGS, CAMERA_HDR_ENABLED: true }); return false } catch { return true }
})())
check('the flag set is frozen — a stray write cannot mint a flag', (() => {
  try { DEFAULT_FLAGS.CAMERA_EXTRA = true } catch { /* strict mode throws */ }
  return !('CAMERA_EXTRA' in DEFAULT_FLAGS)
})())

/* -------------------------------------------------------- 2. layering ----- */

check('every flag except the master has a parent, and every parent exists',
  Object.keys(DEFAULT_FLAGS).every((k) =>
    k === 'AI_CAMERA_ENABLED' ? !(k in FLAG_PARENT) : FLAG_PARENT[k] in DEFAULT_FLAGS))

check('all-defaults resolve to all-false',
  Object.values(resolveFlags()).every((v) => v === false))

check('a lit leaf under a dark ancestry stays DARK', (() => {
  const f = resolveFlags({ CAMERA_HDR_ENABLED: true })
  return f.CAMERA_HDR_ENABLED === false
})())

check('a lit leaf under a lit engine but dark MASTER stays dark', (() => {
  const f = resolveFlags({ CAMERA_ENGINE_ENABLED: true, CAMERA_HDR_ENABLED: true })
  return f.CAMERA_HDR_ENABLED === false && f.CAMERA_ENGINE_ENABLED === false
})())

check('the full chain lit makes the leaf effective', (() => {
  const f = resolveFlags({ AI_CAMERA_ENABLED: true, CAMERA_ENGINE_ENABLED: true, CAMERA_HDR_ENABLED: true })
  return f.CAMERA_HDR_ENABLED === true
})())

check('…and its dark siblings stay dark', (() => {
  const f = resolveFlags({ AI_CAMERA_ENABLED: true, CAMERA_ENGINE_ENABLED: true, CAMERA_HDR_ENABLED: true })
  return f.CAMERA_NIGHT_ENABLED === false && f.CAMERA_VIDEO_ENABLED === false
})())

check('turning the MASTER off darkens an otherwise fully-lit tree', (() => {
  const everything = Object.fromEntries(Object.keys(DEFAULT_FLAGS).map((k) => [k, true]))
  const f = resolveFlags({ ...everything, AI_CAMERA_ENABLED: false })
  return Object.values(f).every((v) => v === false)
})())

check('isMasterEnabled needs BOTH the platform master and the engine flag',
  isMasterEnabled(resolveFlags({ AI_CAMERA_ENABLED: true, CAMERA_ENGINE_ENABLED: true })) === true &&
  isMasterEnabled(resolveFlags({ AI_CAMERA_ENABLED: true })) === false &&
  isMasterEnabled(resolveFlags({ CAMERA_ENGINE_ENABLED: true })) === false &&
  isMasterEnabled(resolveFlags()) === false)

check('an unknown flag name THROWS instead of shipping a phantom', (() => {
  try { resolveFlags({ CAMERA_HRD_ENABLED: true }); return false } catch (e) { return /unknown camera flag/.test(e.message) }
})())

check('a non-boolean value throws', (() => {
  try { resolveFlags({ CAMERA_HDR_ENABLED: 1 }); return false } catch { return true }
})())

check('resolved flags are frozen', (() => {
  const f = resolveFlags()
  try { f.CAMERA_HDR_ENABLED = true } catch { /* strict */ }
  return f.CAMERA_HDR_ENABLED === false
})())

/* ----------------------------------------------------------- 3. clock ----- */

await checkAsync('manual clock runs timers in due order, not insertion order', async () => {
  const clock = manualClock()
  const order = []
  clock.setTimeout(() => order.push('late'), 20)
  clock.setTimeout(() => order.push('early'), 5)
  await clock.advance(30)
  return order.join(',') === 'early,late' && clock.now() === 30
})

await checkAsync('intervals fire repeatedly and can be cleared', async () => {
  const clock = manualClock()
  let n = 0
  const id = clock.setInterval(() => { n++ }, 10)
  await clock.advance(35)
  clock.clearInterval(id)
  await clock.advance(50)
  return n === 3 && clock.armed() === 0
})

await checkAsync('a timer armed BY a timer still fires within the same advance', async () => {
  const clock = manualClock()
  let fired = false
  clock.setTimeout(() => { clock.setTimeout(() => { fired = true }, 5) }, 5)
  await clock.advance(20)
  return fired === true
})

await checkAsync('withTimeout resolves and CLEARS its own timer', async () => {
  const clock = manualClock()
  const p = withTimeout(Promise.resolve('ok'), 100, 'fast thing', clock)
  const value = await p
  return value === 'ok' && clock.armed() === 0
})

await checkAsync('withTimeout rejects with a NAMED TimeoutError', async () => {
  const clock = manualClock()
  const never = new Promise(() => {})
  const p = withTimeout(never, 50, 'camera open', clock)
  let caught = null
  p.catch((e) => { caught = e })
  await clock.advance(60)
  await Promise.resolve()
  return caught instanceof TimeoutError && caught.name === 'TimeoutError' &&
    /camera open/.test(caught.message) && caught.ms === 50
})

check('the throwing clock throws on every method', (() => {
  const clock = throwingClock('test')
  return ['now', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'].every((m) => {
    try { clock[m](() => {}, 0); return false } catch { return true }
  })
})())

console.log('\n========================================')
console.log('  camera flags — shipped dark, layered, deterministic clock')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
