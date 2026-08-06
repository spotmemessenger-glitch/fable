/**
 * Proves the AI Gateway is BUILT and TESTED but NOT WIRED IN.
 *
 * Same discipline as the crypto fences: the gateway is provider-neutral
 * infrastructure with deterministic baselines only. Wiring it into the app —
 * and, later, activating a model-backed adapter — must be a deliberate change
 * that is the whole subject of its own PR, never an import added in passing.
 * Section 2 is the counterweight: "not wired in" must not decay into "not
 * exercised".
 *
 *   node test/ai-gateway-not-shipped.test.js
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')

/** The AI Gateway modules. They may import each other; nothing under src/
 *  outside this folder may import them until wire-in. */
const AI = [
  'src/lib/ai/ports.js',
  'src/lib/ai/baseline.js',
  'src/lib/ai/gateway.js',
  'src/lib/ai/index.js',
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
  check('the AI Gateway modules are present, so section 1 is not vacuous',
    AI.every((p) => srcFiles.some((f) => f.path === p)))

  const appFiles = srcFiles.filter((f) => !AI.includes(f.path))
  const importers = appFiles.filter((f) =>
    /from\s+['"][^'"]*\/lib\/ai\//.test(f.body) ||
    /from\s+['"][^'"]*\/lib\/ai['"]/.test(f.body) ||
    /import\s*\(\s*['"][^'"]*\/lib\/ai[/'"]/.test(f.body))

  check(`NOT WIRED IN: none of the ${appFiles.length} other app modules import the AI Gateway`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))
}

/* ------------------------------------------ 2. …but it is exercised --------- */
{
  const exercised = (needle) => testFiles.some((f) => f.body.includes(needle))
  check('the suite exercises the intent baseline', exercised('intentBaseline'))
  check('the suite exercises the summary baseline', exercised('summaryBaseline'))
  check('the suite exercises the voice baseline', exercised('voiceBaseline'))
  check('the suite constructs the gateway', exercised('createAiGateway'))
  for (const p of AI) {
    const name = p.split('/').pop()
    check(`${name} is imported by at least one module or test`,
      testFiles.some((f) => f.body.includes(`/ai/${name}`)) ||
      srcFiles.some((f) => AI.includes(f.path) && f.body.includes(`/${name}`)))
  }
}

/* ---------------------------- 3. no keys, no network in the baselines ------- */
{
  const mods = srcFiles.filter((f) => AI.includes(f.path))
  const leaks = mods.filter((f) =>
    /\bfetch\s*\(/.test(f.body) ||
    /api[_-]?key/i.test(f.body.replace(/no api keys/i, '')) ||
    /XMLHttpRequest|WebSocket/.test(f.body))
  check('NO NETWORK / NO KEYS: the baselines make no fetch and reference no key',
    leaks.length === 0)
  if (leaks.length) console.log('    in:', leaks.map((f) => f.path).join(', '))
}

console.log('\n========================================')
console.log('  AI Gateway — built, tested, and deliberately not shipped')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
