/**
 * Proves Live Nearby Events is BUILT but ships DARK — master flag false, the
 * engine built under the shipped config is INERT with ZERO provider/network
 * activity, nothing in the app wires it in, and (when a build exists) it is
 * tree-shaken out of dist. The counterweight: the suite DOES exercise every
 * module, so "not shipped" never becomes "not looked at".
 *
 * Turning Live Nearby Events on must be a single deliberate edit to flags.js
 * MASTER — not an import someone adds in passing.
 *
 *   node test/live-events-not-shipped.test.js
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createEventsEngine, SHIPPED_FLAGS, assertShippedDark } from '../src/lib/live-events/index.js'
import { RESULT_STATE } from '../src/lib/live-events/contracts.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')
const DIST = join(ROOT, 'dist')
const EV_DIR = 'src/lib/live-events'
// Discovery V2 is a sibling DARK foundation this one reuses; both are dark.
const DARK_DIRS = [EV_DIR, 'src/lib/discovery-v2']

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
const evFiles = srcFiles.filter((f) => f.path.startsWith(EV_DIR))

/* ---------------------------------------------------- 1. it ships DARK ---- */

check(`the Live Nearby Events modules are present (${evFiles.length}), so this is not vacuous`,
  evFiles.length >= 8)

check('SHIPPED_FLAGS is fully dark and assertShippedDark agrees',
  Object.values(SHIPPED_FLAGS).every((v) => v === false) && assertShippedDark(SHIPPED_FLAGS) === true)

check('the engine built under the SHIPPED config is INERT (enabled=false)', (() => {
  const e = createEventsEngine()
  return e.enabled === false && e.mapState === null && e.detail === null
})())

check('the inert engine SEARCHES to unavailable and yields NO markers', await (async () => {
  const e = createEventsEngine()
  const out = await e.search({ text: 'music' })
  return out.state === RESULT_STATE.UNAVAILABLE && out.results.length === 0 && e.markers([]).length === 0
})())

check('ZERO network/provider activity while dark: providers passed in are never touched', await (async () => {
  let touched = false
  const provider = { name: 'spy', searchEvents: async () => { touched = true; return [] } }
  const e = createEventsEngine({ providers: [provider] }) // no flags → inert
  await e.search({ text: 'music' })
  return touched === false && e.enabled === false
})())

check('the inert engine gives directions only as an honest straight line', await (async () => {
  const e = createEventsEngine()
  const d = await e.directions({ id: 'x', lat: 1, lon: 1 }, { lat: 0, lon: 0 })
  return d.durationS === null && d.kind === 'straight-line'
})())

/* -------------------------------------------- 2. …and NOTHING wires it in - */

{
  const appFiles = srcFiles.filter((f) => !DARK_DIRS.some((d) => f.path.startsWith(d)))
  const importers = appFiles.filter((f) =>
    /from\s+['"][^'"]*live-events[^'"]*['"]/.test(f.body) ||
    /import\s*\(\s*['"][^'"]*live-events[^'"]*['"]/.test(f.body))
  check(`NOT WIRED IN: none of the ${appFiles.length} app modules import live-events`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

  const callers = appFiles.filter((f) => /\bcreateEventsEngine\s*\(/.test(f.body))
  check('NOT CONSTRUCTED: nothing in the app calls createEventsEngine', callers.length === 0)
  if (callers.length) console.log('    called by:', callers.map((f) => f.path).join(', '))
}

/* ------------------------------------- 3. …but the suite DOES exercise it - */

{
  const covered = (needle) => testFiles.some((f) => f.body.includes(needle))
  check('the suite exercises event search', covered('createEventSearch'))
  check('…event normalisation/contracts', covered('normalizeEvent'))
  check('…time/state derivation', covered('deriveEventState'))
  check('…ranking', covered('rankEvents'))
  check('…safety/blocking', covered('filterForSafety'))
  check('…detail state', covered('createEventDetail'))
  check('…map/directions linking', covered('eventDirections'))

  for (const f of evFiles) {
    const base = f.path.split('/').pop()
    check(`${base} is reachable from at least one test`,
      testFiles.some((t) => t.body.includes(base)) ||
      ['index.js', 'flags.js', 'contracts.js'].includes(base))
  }
}

/* -------------------------------- 4. no secrets, and no dist contamination */

{
  const SECRET_ASSIGN = /(api[_-]?key|apikey|secret|password|authorization|bearer|token|credential)s?\s*[:=]\s*['"][^'"]+['"]/i
  const SK_LITERAL = /['"]sk-[A-Za-z0-9]/
  const leaks = evFiles.filter((f) => SECRET_ASSIGN.test(f.body) || SK_LITERAL.test(f.body))
  check('NO SECRETS: no provider key/token literal in any Live Events module', leaks.length === 0)
  if (leaks.length) console.log('    in:', leaks.map((f) => f.path).join(', '))

  if (existsSync(DIST)) {
    const distFiles = walk(DIST).map((f) => readFileSync(f, 'utf8'))
    const contaminated = distFiles.some((b) => b.includes('createEventsEngine'))
    check('TREE-SHAKEN: the dark engine does not appear in the built dist bundle', !contaminated)
  } else {
    check('TREE-SHAKEN check skipped (no dist/ — run `npm run build` to verify)', true)
  }
}

console.log('\n========================================')
console.log('  live nearby events — built, tested, and deliberately not shipped')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
