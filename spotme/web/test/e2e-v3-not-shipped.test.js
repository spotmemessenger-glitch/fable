/**
 * Proves the e2e_v3 crypto is BUILT and TESTED but NOT WIRED IN.
 *
 * Same discipline, same reason as `signing-not-shipped.test.js`: e2e_v3 rides
 * behind the `spotme.e2e3` rollout flag (004a §12), absent by default, and
 * activation is a deliberate decision — it must land before v3 sessions can
 * form, not arrive as an import someone added in passing to an unrelated
 * feature. A promise in a PR cannot enforce that; a failing build can.
 *
 * As with the signing fence this is meant to be edited DELIBERATELY when the
 * owner activates v3 — the point is that flipping it on is the whole subject of
 * the change that does it, never a side effect. Section 2 is the counterweight:
 * "not wired in" must not decay into "not exercised", so the same test proves
 * the modules are reachable from the suite.
 *
 *   node test/e2e-v3-not-shipped.test.js
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')

/** The e2e_v3 modules. They may import each other and the crypto foundation;
 *  nothing under src/ outside this set may import them until activation. */
const V3 = [
  'src/lib/crypto/x3dh.js',
  'src/lib/crypto/ratchet.js',
]

function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full)
  }
  return out
}

const srcFiles = walk(SRC).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))
const testFiles = walk(TEST).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))

/* ------------------------------------------ 1. nothing in the app uses it -- */

{
  check('the e2e_v3 modules are present, so section 1 is not vacuous',
    V3.every((p) => srcFiles.some((f) => f.path === p)))

  const appFiles = srcFiles.filter((f) => !V3.includes(f.path))
  const importers = appFiles.filter((f) =>
    /from\s+['"][^'"]*\/(x3dh|ratchet)\.js['"]/.test(f.body) ||
    /import\s*\(\s*['"][^'"]*\/(x3dh|ratchet)\.js['"]/.test(f.body))

  check(`NOT WIRED IN: none of the ${appFiles.length} other app modules import the e2e_v3 crypto`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

  // The rollout flag must not be read anywhere yet — the day it is, that is the
  // activation change, and it is supposed to be visible as one.
  const flagReaders = appFiles.filter((f) => /spotme\.e2e3|e2e_v3|E2E_V3/.test(f.body))
  check('NO ACTIVATION: nothing reads the spotme.e2e3 rollout flag yet',
    flagReaders.length === 0)
  if (flagReaders.length) console.log('    reads flag:', flagReaders.map((f) => f.path).join(', '))
}

/* ------------------------------------------ 2. …but it is exercised --------- */

{
  const exercised = (needle) => testFiles.some((f) => f.body.includes(needle))
  check('the suite runs the full X3DH handshake', exercised('x3dhInitiator') && exercised('x3dhResponder'))
  check('…and verifies signed prekeys', exercised('verifyBundleSpk'))
  check('…and drives the Double Ratchet through encrypt/decrypt', exercised('initInitiator') && exercised('initResponder'))
  for (const p of V3) {
    const name = p.split('/').pop()
    check(`${name} is imported by at least one test`,
      testFiles.some((f) => f.body.includes(`/${name}`)))
  }
}

/* ---------------------------- 3. the private half has no way out ------------ */

{
  const mods = srcFiles.filter((f) => V3.includes(f.path))
  const leaks = mods.filter((f) =>
    /exportKey\s*\(\s*['"](pkcs8|jwk)['"]/.test(f.body) || /subtle\.wrapKey\s*\(/.test(f.body))
  check('NO EXPORT PATH: the e2e_v3 modules cannot serialise a private key',
    leaks.length === 0)
  if (leaks.length) console.log('    in:', leaks.map((f) => f.path).join(', '))
}

console.log('\n========================================')
console.log('  e2e_v3 — built, tested, and deliberately not shipped')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
