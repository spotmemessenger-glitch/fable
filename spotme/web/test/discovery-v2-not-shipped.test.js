/**
 * Proves Discovery V2 is BUILT but ships DARK — the master flag is false, the
 * engine constructed under the shipped config is INERT, nothing in the app
 * wires it in, and (when a build exists) it is tree-shaken out of dist. The
 * counterweight: the same modules ARE exercised by the suite, so "not shipped"
 * never becomes "not looked at".
 *
 * This is the load-bearing gate for the whole foundation. Turning Discovery V2
 * on must be a single deliberate edit to flags.js MASTER, in a change whose
 * whole subject is that authorisation — not an import someone adds in passing.
 *
 *   node test/discovery-v2-not-shipped.test.js
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createDiscoveryEngine, SHIPPED_FLAGS, assertShippedDark } from '../src/lib/discovery-v2/index.js'
import { RESULT_STATE } from '../src/lib/discovery-v2/contracts.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')
const DIST = join(ROOT, 'dist')
const V2_DIR = 'src/lib/discovery-v2'

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
const v2Files = srcFiles.filter((f) => f.path.startsWith(V2_DIR))

/* ---------------------------------------------------- 1. it ships DARK ---- */

check(`the Discovery V2 modules are actually present (${v2Files.length}), so this is not vacuous`,
  v2Files.length >= 8)

check('SHIPPED_FLAGS is fully dark and assertShippedDark agrees',
  Object.values(SHIPPED_FLAGS).every((v) => v === false) && assertShippedDark(SHIPPED_FLAGS) === true)

check('the engine built under the SHIPPED config is INERT (enabled=false)', (() => {
  const e = createDiscoveryEngine() // no flags → SHIPPED_FLAGS
  return e.enabled === false && e.mapState === null
})())

check('the inert engine SEARCHES to unavailable and yields NO people markers', await (async () => {
  const e = createDiscoveryEngine()
  const out = await e.search({ text: 'coffee' })
  const markers = e.peopleMarkers([{ id: 'a', lat: 1, lon: 1, ghost: false }])
  return out.state === RESULT_STATE.UNAVAILABLE && out.results.length === 0 && markers.length === 0
})())

check('the inert engine gives directions only as an honest straight line', await (async () => {
  const e = createDiscoveryEngine()
  const d = await e.directions({ lat: 0, lon: 0 }, { lat: 1, lon: 1 })
  return d.durationS === null && d.kind === 'straight-line'
})())

/* -------------------------------------------- 2. …and NOTHING wires it in - */

{
  // Sibling DARK foundations may reuse these contracts — they are themselves
  // fence-proven not-shipped (each has its own *-not-shipped test), so an import
  // from one is not "wired into the app". The rule this guards is that no
  // SHIPPED app code reaches discovery-v2; a dark sibling doesn't ship either.
  const DARK_DIRS = [V2_DIR, 'src/lib/live-events']
  const appFiles = srcFiles.filter((f) => !DARK_DIRS.some((d) => f.path.startsWith(d)))
  const importers = appFiles.filter((f) =>
    /from\s+['"][^'"]*discovery-v2[^'"]*['"]/.test(f.body) ||
    /import\s*\(\s*['"][^'"]*discovery-v2[^'"]*['"]/.test(f.body))
  check(`NOT WIRED IN: none of the ${appFiles.length} app modules import discovery-v2`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

  const callers = appFiles.filter((f) => /\bcreateDiscoveryEngine\s*\(/.test(f.body))
  check('NOT CONSTRUCTED: nothing in the app calls createDiscoveryEngine',
    callers.length === 0)
  if (callers.length) console.log('    called by:', callers.map((f) => f.path).join(', '))
}

/* ------------------------------------- 3. …but the suite DOES exercise it - */

{
  const covered = (needle) => testFiles.some((f) => f.body.includes(needle))
  check('the suite exercises search orchestration', covered('createSearch'))
  check('…the adaptive radius', covered('expandingSearch'))
  check('…the ranking', covered('rankPlaces'))
  check('…the people-marker privacy boundary', covered('toPeopleMarkers'))
  check('…directions honesty', covered('getDirections'))
  check('…the map single-source-of-truth', covered('createMapState'))
  check('…the query-intent seam', covered('deriveIntent'))

  for (const f of v2Files) {
    const base = f.path.split('/').pop()
    check(`${base} is reachable from at least one test`,
      testFiles.some((t) => t.body.includes(base) ||
        // index/flags/contracts are reached via re-export or sibling import
        ['index.js', 'flags.js', 'contracts.js'].includes(base)))
  }
}

/* -------------------------------- 4. no secrets, and no dist contamination */

{
  // Match a secret being ASSIGNED a value, not the WORDS "key"/"secret"
  // appearing in a detection regex or a doc-comment. A guard that fires on the
  // documentation of the property it guards is a guard people delete.
  const SECRET_ASSIGN = /(api[_-]?key|apikey|secret|password|authorization|bearer|token|credential)s?\s*[:=]\s*['"][^'"]+['"]/i
  const SK_LITERAL = /['"]sk-[A-Za-z0-9]/
  const leaks = v2Files.filter((f) => SECRET_ASSIGN.test(f.body) || SK_LITERAL.test(f.body))
  check('NO SECRETS: no provider key/token literal in any Discovery V2 module',
    leaks.length === 0)
  if (leaks.length) console.log('    in:', leaks.map((f) => f.path).join(', '))

  // Tree-shaken proof — only meaningful once a build exists. A unique sentinel
  // that only appears in the dark subsystem must NOT survive into dist.
  if (existsSync(DIST)) {
    const distFiles = walk(DIST).map((f) => readFileSync(f, 'utf8'))
    const contaminated = distFiles.some((b) => b.includes('createDiscoveryEngine'))
    check('TREE-SHAKEN: the dark engine does not appear in the built dist bundle',
      !contaminated)
  } else {
    check('TREE-SHAKEN check skipped (no dist/ present — run `npm run build` to verify)', true)
  }
}

console.log('\n========================================')
console.log('  discovery v2 — built, tested, and deliberately not shipped')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
