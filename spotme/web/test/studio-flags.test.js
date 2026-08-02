/**
 * Creative Studio flags — the shipped-dark contract, executable.
 *
 * The studio ships with every flag false and a parent tree that makes a
 * child meaningless without its ancestors. These tests pin: the defaults ARE
 * all false (assertShippedDark), the layering algebra (a lit child under a
 * dark parent resolves dark), and the boundary strictness (unknown names and
 * non-boolean values throw — a typo'd override must fail loudly, because a
 * typo is exactly how a dark feature goes live).
 *
 *   node test/studio-flags.test.js
 */
import { DEFAULT_FLAGS, FLAG_PARENT, resolveFlags, assertShippedDark } from '../src/lib/studio/flags.js'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const throws = (fn, re) => {
  try { fn(); return false } catch (e) { return re ? re.test(String(e.message)) : true }
}

check('every default flag is false — assertShippedDark passes on the shipped set', () =>
  assertShippedDark() === true && Object.values(DEFAULT_FLAGS).every((v) => v === false))

check('assertShippedDark names the lit flag when one is on', () =>
  throws(() => assertShippedDark({ CREATIVE_STUDIO_ENABLED: true }), /CREATIVE_STUDIO_ENABLED/))

check('every child in FLAG_PARENT exists in DEFAULT_FLAGS, and so does its parent', () =>
  Object.entries(FLAG_PARENT).every(([child, parent]) =>
    child in DEFAULT_FLAGS && parent in DEFAULT_FLAGS))

check('every flag except the master has a parent — nothing floats outside the tree', () =>
  Object.keys(DEFAULT_FLAGS)
    .filter((k) => k !== 'CREATIVE_STUDIO_ENABLED')
    .every((k) => FLAG_PARENT[k] === 'CREATIVE_STUDIO_ENABLED'))

check('THE LAYERING: a lit child under the dark master resolves to OFF', () => {
  const f = resolveFlags({ STUDIO_LOOKS_ENABLED: true })
  return f.STUDIO_LOOKS_ENABLED === false && f.CREATIVE_STUDIO_ENABLED === false
})

check('master on alone does not light any child', () => {
  const f = resolveFlags({ CREATIVE_STUDIO_ENABLED: true })
  return f.CREATIVE_STUDIO_ENABLED === true &&
    Object.entries(f).every(([k, v]) => k === 'CREATIVE_STUDIO_ENABLED' ? v : v === false)
})

check('master + child on resolves the child on', () => {
  const f = resolveFlags({ CREATIVE_STUDIO_ENABLED: true, STUDIO_DRAFTS_ENABLED: true })
  return f.STUDIO_DRAFTS_ENABLED === true && f.STUDIO_CLOUD_AI_ENABLED === false
})

check('an unknown flag name throws rather than being dropped', () =>
  throws(() => resolveFlags({ STUDIO_TYPO_ENABLED: true }), /unknown studio flag/))

check('a non-boolean value throws', () =>
  throws(() => resolveFlags({ STUDIO_LOOKS_ENABLED: 1 }), /must be boolean/))

check('a non-object override bag throws', () =>
  throws(() => resolveFlags('on'), /plain object/))

check('the resolved set is frozen — runtime mutation cannot re-light a flag', () => {
  const f = resolveFlags({})
  try { f.CREATIVE_STUDIO_ENABLED = true } catch { /* strict mode throws; fine */ }
  return f.CREATIVE_STUDIO_ENABLED === false
})

check('DEFAULT_FLAGS itself is frozen', () => {
  try { DEFAULT_FLAGS.CREATIVE_STUDIO_ENABLED = true } catch { /* ok */ }
  return DEFAULT_FLAGS.CREATIVE_STUDIO_ENABLED === false
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  studio flags — shipped dark, layered')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
