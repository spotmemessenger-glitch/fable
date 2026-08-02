/**
 * Proves the AR/beauty flag layering: shipped dark, parented UNDER the
 * camera platform master, no leaf can light a dark ancestry, and the
 * advanced beauty tier cannot exist without the base tier.
 *
 *   node test/ar-flags.test.js
 */
import {
  AR_DEFAULT_FLAGS, AR_FLAG_PARENT, resolveArFlags, isArMasterEnabled, assertArShippedDark,
} from '../src/lib/ar/flags.js'
import { DEFAULT_FLAGS as CAMERA_DEFAULT_FLAGS } from '../src/lib/camera/flags.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* ----------------------------------------------------- 1. shipped dark --- */

check('every default AR flag is false',
  Object.values(AR_DEFAULT_FLAGS).every((v) => v === false))
check('assertArShippedDark passes on the shipped defaults',
  assertArShippedDark() === true)
check('assertArShippedDark THROWS the moment any flag is not false', (() => {
  try { assertArShippedDark({ ...AR_DEFAULT_FLAGS, BEAUTY_ENABLED: true }); return false } catch { return true }
})())
check('the flag set is frozen — a stray write cannot mint a flag', (() => {
  try { AR_DEFAULT_FLAGS.AR_EXTRA = true } catch { /* strict mode throws */ }
  return !('AR_EXTRA' in AR_DEFAULT_FLAGS)
})())

/* ------------------------------------- 2. parented to the camera root ---- */

check('the module root AR_BEAUTY_ENABLED parents to the CAMERA platform master',
  AR_FLAG_PARENT.AR_BEAUTY_ENABLED === 'AI_CAMERA_ENABLED')
check('the mirrored master matches the camera module (single source of truth, shipped false there too)',
  AR_DEFAULT_FLAGS.AI_CAMERA_ENABLED === CAMERA_DEFAULT_FLAGS.AI_CAMERA_ENABLED &&
  CAMERA_DEFAULT_FLAGS.AI_CAMERA_ENABLED === false)
check('every flag except the platform master has a parent, and every parent exists',
  Object.keys(AR_DEFAULT_FLAGS).every((k) =>
    k === 'AI_CAMERA_ENABLED' ? !(k in AR_FLAG_PARENT) : AR_FLAG_PARENT[k] in AR_DEFAULT_FLAGS))
check('BEAUTY_ADVANCED_ENABLED parents to BEAUTY_ENABLED — the landmark tier needs the base tier',
  AR_FLAG_PARENT.BEAUTY_ADVANCED_ENABLED === 'BEAUTY_ENABLED')

/* -------------------------------------------------------- 3. layering ---- */

check('all-defaults resolve to all-false',
  Object.values(resolveArFlags()).every((v) => v === false))

check('AR_BEAUTY lit under a dark camera master stays DARK', (() => {
  const f = resolveArFlags({ AR_BEAUTY_ENABLED: true })
  return f.AR_BEAUTY_ENABLED === false
})())

check('a lit leaf under a dark module master stays dark', (() => {
  const f = resolveArFlags({ AI_CAMERA_ENABLED: true, BEAUTY_ENABLED: true })
  return f.BEAUTY_ENABLED === false
})())

check('the full chain lit makes the leaf effective', (() => {
  const f = resolveArFlags({ AI_CAMERA_ENABLED: true, AR_BEAUTY_ENABLED: true, BEAUTY_ENABLED: true })
  return f.BEAUTY_ENABLED === true
})())

check('…and its dark siblings stay dark', (() => {
  const f = resolveArFlags({ AI_CAMERA_ENABLED: true, AR_BEAUTY_ENABLED: true, BEAUTY_ENABLED: true })
  return f.AR_GESTURES_ENABLED === false && f.AR_MASKS_ENABLED === false && f.AR_WORLD_ENABLED === false
})())

check('BEAUTY_ADVANCED needs the WHOLE chain: master → module → base tier', (() => {
  const missingBase = resolveArFlags({ AI_CAMERA_ENABLED: true, AR_BEAUTY_ENABLED: true, BEAUTY_ADVANCED_ENABLED: true })
  const full = resolveArFlags({ AI_CAMERA_ENABLED: true, AR_BEAUTY_ENABLED: true, BEAUTY_ENABLED: true, BEAUTY_ADVANCED_ENABLED: true })
  return missingBase.BEAUTY_ADVANCED_ENABLED === false && full.BEAUTY_ADVANCED_ENABLED === true
})())

check('turning the CAMERA master off darkens an otherwise fully-lit AR tree', (() => {
  const everything = Object.fromEntries(Object.keys(AR_DEFAULT_FLAGS).map((k) => [k, true]))
  const f = resolveArFlags({ ...everything, AI_CAMERA_ENABLED: false })
  return Object.values(f).every((v) => v === false)
})())

/* ------------------------------------------------------- 4. hard edges --- */

check('an unknown flag name THROWS instead of shipping a phantom', (() => {
  try { resolveArFlags({ AR_BEAUTY_ENABLD: true }); return false } catch (e) { return /unknown ar flag/.test(e.message) }
})())
check('a non-boolean value THROWS', (() => {
  try { resolveArFlags({ AR_BEAUTY_ENABLED: 1 }); return false } catch (e) { return /must be boolean/.test(e.message) }
})())
check('the resolved snapshot is frozen', (() => {
  const f = resolveArFlags()
  try { f.AR_BEAUTY_ENABLED = true } catch { /* strict throws */ }
  return f.AR_BEAUTY_ENABLED === false
})())

check('isArMasterEnabled needs BOTH the camera master and the module master',
  isArMasterEnabled(resolveArFlags({ AI_CAMERA_ENABLED: true, AR_BEAUTY_ENABLED: true })) === true &&
  isArMasterEnabled(resolveArFlags({ AI_CAMERA_ENABLED: true })) === false &&
  isArMasterEnabled(resolveArFlags({ AR_BEAUTY_ENABLED: true })) === false &&
  isArMasterEnabled(resolveArFlags()) === false)

/* ------------------------------------------------------------- report ---- */

console.log('\n========================================')
console.log('  ar flags — dark, layered under the camera master')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
