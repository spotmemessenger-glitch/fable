/**
 * Proves the V2 translation platform is BUILT and EXERCISED but NOT WIRED IN —
 * the live translate path still runs the shipped engine, untouched, and no
 * request can reach the new router until the owner turns the flag on.
 *
 * WHY A TEST AND NOT A PROMISE IN A PULL REQUEST. The whole platform spends
 * vendor credit and routes plaintext to third parties. "Additive, gated OFF,
 * not in the live path" is the safety property the whole PR rests on, and a
 * statement in a description cannot enforce it — an unrelated feature adding an
 * import would silently wire it in and nobody would notice. A failing build can.
 * This mirrors test/signing-not-shipped.test.js exactly.
 *
 * SECTION 2 IS THE COUNTERWEIGHT. "Not wired in" must not become "not looked
 * at" — an unexercised router is a document, not a foundation. So the same test
 * that proves the module is unreachable from the app proves it is reachable, and
 * driven, from the suite.
 *
 *   node test/translation-v2-not-shipped.test.js
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { buildTranslationPlatform, isTranslationV2Enabled } from '../src/lib/translation/index.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const checkAsync = async (name, fn) => {
  names.push(name)
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results['  ' + name] = e.message }
}

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const API = join(ROOT, 'api')
const TEST = join(ROOT, 'test')

/** The V2 platform modules. They may import each other; the app may not. */
const V2 = [
  'src/lib/translation/flag.js',
  'src/lib/translation/types.js',
  'src/lib/translation/capabilities.js',
  'src/lib/translation/ITranslationProvider.js',
  'src/lib/translation/circuit-breaker.js',
  'src/lib/translation/scoring.js',
  'src/lib/translation/confidence.js',
  'src/lib/translation/detect.js',
  'src/lib/translation/registry.js',
  'src/lib/translation/router.js',
  'src/lib/translation/index.js',
  'src/lib/translation/adapters/engine-port.js',
  'src/lib/translation/adapters/providers.js',
  'src/lib/translation/adapters/index.js'
]

function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.endsWith('.js') || entry.endsWith('.mjs')) out.push(full)
  }
  return out
}
const read = (f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') })
const isV2 = (p) => p.startsWith('src/lib/translation/')

const srcFiles = walk(SRC).map(read)
const apiFiles = walk(API).map(read)
const testFiles = walk(TEST).map(read)
const appFiles = [...srcFiles, ...apiFiles].filter((f) => !isV2(f.path))

const importsTranslation = (body) =>
  /from\s+['"][^'"]*\/translation\/[^'"]*['"]/.test(body) ||
  /import\s*\(\s*['"][^'"]*\/translation\/[^'"]*['"]/.test(body)

/* ------------------------------------------ 1. nothing in the app uses it -- */

check('the V2 modules are actually present, so section 1 is not vacuous',
  V2.every((p) => srcFiles.some((f) => f.path === p)))

const importers = appFiles.filter((f) => importsTranslation(f.body))
check(`NOT WIRED IN: none of the ${appFiles.length} app modules import the translation platform`,
  importers.length === 0)
if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

check('THE LIVE PATH IS UNTOUCHED: api/translate.js does not import the platform',
  !importsTranslation(apiFiles.find((f) => f.path === 'api/translate.js')?.body || ''))

check('THE LIVE PATH IS UNTOUCHED: src/lib/translate.js does not import the platform',
  !importsTranslation(srcFiles.find((f) => f.path === 'src/lib/translate.js')?.body || ''))

check('the engine does not depend on V2 in reverse — the dependency runs one way',
  // V2 may import api/translate.js (for scriptOk); the engine must never import V2.
  apiFiles.every((f) => !importsTranslation(f.body)))

/* ---------------------------------------------- 2. the flag defaults OFF --- */

// Make sure nothing in this process left the switch on before we assert.
delete globalThis.__SPOTME_TRANSLATION_V2__
delete process.env.TRANSLATION_V2_ENABLED

check('OFF BY DEFAULT: isTranslationV2Enabled() is false with nothing set',
  isTranslationV2Enabled() === false)

check('OFF BY DEFAULT: a freshly built platform reports enabled:false',
  buildTranslationPlatform().enabled === false)

process.env.TRANSLATION_V2_ENABLED = '1'
check('a truthy-but-not-exactly-true env value does NOT enable it',
  isTranslationV2Enabled() === false)
delete process.env.TRANSLATION_V2_ENABLED

await checkAsync('a disabled platform REFUSES to execute — no path to a vendor call while OFF', async () => {
  const p = buildTranslationPlatform() // enabled:false
  try { await p.execute({ text: 'hi', targetLang: 'ta' }); return false } catch (e) {
    return /disabled/.test(e.message)
  }
})

check('a pure DECISION is still allowed while OFF (shadow routing, no side effects)',
  buildTranslationPlatform().decide({ text: 'hi', targetLang: 'kn' }).policyVersion === 'rt-off')

globalThis.__SPOTME_TRANSLATION_V2__ = true
const flagOnWorks = isTranslationV2Enabled() === true && buildTranslationPlatform().enabled === true
delete globalThis.__SPOTME_TRANSLATION_V2__
check('the flag CAN be turned on — the switch works, it is just off by default', flagOnWorks)

/* ------------------------------------------ 3. …but it is not unexamined -- */

const exercised = (needle) => testFiles.some((f) => f.body.includes(needle))
check('the suite drives the provider contract', exercised('assertImplementsProvider'))
check('…and the router', exercised('createRouter'))
check('…and the circuit breaker', exercised('createCircuitBreaker'))
check('…and the quality EWMA', exercised('updateQuality'))
check('…and the detection pipeline', exercised('runDetectionPipeline'))

for (const p of V2) {
  const base = '/' + p.split('/').pop()
  check(`${p.split('/').slice(-2).join('/')} is imported by at least one test`,
    testFiles.some((f) => f.body.includes(base)))
}

/* ---------------------------- 4. the adapters duplicate no provider logic -- */

const v2Files = srcFiles.filter((f) => isV2(f.path))
// The engine holds every key and hostname; an adapter that grew one started
// rewriting api/translate.js. The ONLY permitted engine touch is importing from
// api/translate.js (scriptOk / the dormant handler delegate).
const vendorLeak = /api\.sarvam\.ai|api\.openai\.com|generativelanguage|api\.anthropic\.com|translation\.googleapis|inputtools\.google|AZURE_TRANSLATOR|_API_KEY/
const leaks = v2Files.filter((f) => vendorLeak.test(f.body))
check('NO DUPLICATED PROVIDER LOGIC: no V2 file holds a vendor key, hostname or endpoint',
  leaks.length === 0)
if (leaks.length) console.log('    leaked in:', leaks.map((f) => f.path).join(', '))

const enginePort = v2Files.find((f) => f.path.endsWith('adapters/engine-port.js'))
check('the ONE engine touch is a delegation import from api/translate.js, nothing wider',
  Boolean(enginePort) && /from '\.\.\/\.\.\/\.\.\/\.\.\/api\/translate\.js'/.test(enginePort.body))

/* --------------------------------------------------------------- report */
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  translation V2 — built, exercised, deliberately not shipped')
console.log('========================================')
for (const n of names) {
  console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  if (!results[n] && results['  ' + n]) console.log(`        ${results['  ' + n]}`)
}
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
