/**
 * Proves the vision module's flag layering: shipped dark, parented to the
 * AI Camera platform master, and impossible to light from a leaf.
 *
 * The claims that matter:
 *   - every flag ships FALSE and assertShippedDark enforces it
 *   - AI_VISION_ENABLED parents to AI_CAMERA_ENABLED (the ONE platform
 *     master, imported — not restated — from the camera module)
 *   - medical info is a CHILD of the assistant flag, so the safety layer
 *     can never be dark under a lit medical leg
 *   - the cloud flag lights nothing on its own, and the camera master
 *     darkens everything in one move (the rollback lever)
 *   - a typo'd flag name fails loudly instead of shipping a phantom
 *
 *   node test/vision-flags.test.js
 */
import {
  DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, isVisionEnabled, assertShippedDark,
} from '../src/lib/vision/flags.js'
import { DEFAULT_FLAGS as CAMERA_DEFAULT_FLAGS } from '../src/lib/camera/flags.js'
import { VISION_UNAVAILABLE, available, unavailable } from '../src/lib/vision/availability.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* ----------------------------------------------------- 1. shipped dark ---- */

check('every default flag is false',
  Object.values(DEFAULT_FLAGS).every((v) => v === false))
check('assertShippedDark passes on the shipped defaults',
  assertShippedDark() === true)
check('assertShippedDark THROWS the moment any flag is not false', (() => {
  try { assertShippedDark({ ...DEFAULT_FLAGS, VISION_SCAN_ENABLED: true }); return false } catch { return true }
})())
check('the flag set is frozen — a stray write cannot mint a flag', (() => {
  try { DEFAULT_FLAGS.VISION_EXTRA = true } catch { /* strict mode throws */ }
  return !('VISION_EXTRA' in DEFAULT_FLAGS)
})())
check('the platform master default is IMPORTED from the camera module, not restated',
  DEFAULT_FLAGS.AI_CAMERA_ENABLED === CAMERA_DEFAULT_FLAGS.AI_CAMERA_ENABLED &&
  DEFAULT_FLAGS.AI_CAMERA_ENABLED === false)

/* -------------------------------------------------------- 2. layering ----- */

check('every flag except the platform master has a parent, and every parent exists',
  Object.keys(DEFAULT_FLAGS).every((k) =>
    k === 'AI_CAMERA_ENABLED' ? !(k in FLAG_PARENT) : FLAG_PARENT[k] in DEFAULT_FLAGS))

check('AI_VISION_ENABLED parents to the platform master, and medical to the assistant',
  FLAG_PARENT.AI_VISION_ENABLED === 'AI_CAMERA_ENABLED' &&
  FLAG_PARENT.VISION_MEDICAL_INFO_ENABLED === 'VISION_ASSISTANT_ENABLED')

check('all-defaults resolve to all-false',
  Object.values(resolveFlags()).every((v) => v === false))

check('a lit leaf under a dark ancestry stays DARK', (() => {
  const f = resolveFlags({ VISION_SCAN_ENABLED: true })
  return f.VISION_SCAN_ENABLED === false
})())

check('a lit vision root under a dark CAMERA master stays dark', (() => {
  const f = resolveFlags({ AI_VISION_ENABLED: true, VISION_SCAN_ENABLED: true })
  return f.AI_VISION_ENABLED === false && f.VISION_SCAN_ENABLED === false
})())

check('the full chain lit makes the leaf effective', (() => {
  const f = resolveFlags({ AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true, VISION_SCAN_ENABLED: true })
  return f.VISION_SCAN_ENABLED === true
})())

check('…and its dark siblings stay dark', (() => {
  const f = resolveFlags({ AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true, VISION_SCAN_ENABLED: true })
  return f.VISION_DOCSCAN_ENABLED === false && f.VISION_CLOUD_ENABLED === false
})())

check('MEDICAL needs the whole chain: master → vision → assistant → medical', (() => {
  const noAssist = resolveFlags({ AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true, VISION_MEDICAL_INFO_ENABLED: true })
  const withAssist = resolveFlags({
    AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true,
    VISION_ASSISTANT_ENABLED: true, VISION_MEDICAL_INFO_ENABLED: true,
  })
  return noAssist.VISION_MEDICAL_INFO_ENABLED === false && withAssist.VISION_MEDICAL_INFO_ENABLED === true
})())

check('the CLOUD flag lights nothing on its own — it is a boundary, not a feature', (() => {
  const f = resolveFlags({ VISION_CLOUD_ENABLED: true })
  return Object.values(f).every((v) => v === false)
})())

check('turning the CAMERA MASTER off darkens an otherwise fully-lit vision tree', (() => {
  const everything = Object.fromEntries(Object.keys(DEFAULT_FLAGS).map((k) => [k, true]))
  const f = resolveFlags({ ...everything, AI_CAMERA_ENABLED: false })
  return Object.values(f).every((v) => v === false)
})())

check('turning only AI_VISION_ENABLED off darkens all of vision the same way', (() => {
  const everything = Object.fromEntries(Object.keys(DEFAULT_FLAGS).map((k) => [k, true]))
  const f = resolveFlags({ ...everything, AI_VISION_ENABLED: false })
  return Object.keys(f).every((k) => (k === 'AI_CAMERA_ENABLED' ? f[k] === true : f[k] === false))
})())

check('isVisionEnabled needs BOTH the platform master and the vision root',
  isVisionEnabled(resolveFlags({ AI_CAMERA_ENABLED: true, AI_VISION_ENABLED: true })) === true &&
  isVisionEnabled(resolveFlags({ AI_CAMERA_ENABLED: true })) === false &&
  isVisionEnabled(resolveFlags({ AI_VISION_ENABLED: true })) === false &&
  isVisionEnabled(resolveFlags()) === false)

check('an unknown flag name THROWS instead of shipping a phantom', (() => {
  try { resolveFlags({ VISION_SACN_ENABLED: true }); return false } catch (e) { return /unknown vision flag/.test(e.message) }
})())

check('a CAMERA-ENGINE flag is not a vision flag — vision parents to the master, not the engine', (() => {
  try { resolveFlags({ CAMERA_ENGINE_ENABLED: true }); return false } catch (e) { return /unknown vision flag/.test(e.message) }
})())

check('a non-boolean value throws', (() => {
  try { resolveFlags({ VISION_SCAN_ENABLED: 1 }); return false } catch { return true }
})())

check('resolved flags are frozen', (() => {
  const f = resolveFlags()
  try { f.VISION_SCAN_ENABLED = true } catch { /* strict */ }
  return f.VISION_SCAN_ENABLED === false
})())

/* -------------------------------------------------- 3. the vocabulary ----- */

check('every unavailability reason is a closed-set constant equal to its own name',
  Object.entries(VISION_UNAVAILABLE).every(([k, v]) => k === v))

check('FLAG_DISABLED is spelled the same in both platform vocabularies',
  VISION_UNAVAILABLE.FLAG_DISABLED === CAMERA_UNAVAILABLE.FLAG_DISABLED)

check('available() carries facts and is frozen', (() => {
  const a = available({ engine: 'x' })
  try { a.engine = 'y' } catch { /* strict */ }
  return a.available === true && a.engine === 'x'
})())

check('unavailable() with an unknown reason THROWS — no unnamed shrugs', (() => {
  try { unavailable('BECAUSE'); return false } catch { return true }
})())

check('unavailable() carries reason and optional detail', (() => {
  const u = unavailable(VISION_UNAVAILABLE.NO_QUAD_FOUND, 'best score 0.11')
  return u.available === false && u.reason === 'NO_QUAD_FOUND' && u.detail === 'best score 0.11'
})())

console.log('\n========================================')
console.log('  vision flags — shipped dark, one master, layered')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
