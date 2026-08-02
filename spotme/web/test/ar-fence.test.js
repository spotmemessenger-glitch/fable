/**
 * THE AR FENCE: proves mission CAM-3 is BUILT but NOT WIRED IN, ships dark,
 * and cannot leak — the sibling of camera-fence / vision-fence, over lib/ar/.
 *
 *   1. nothing outside lib/ar/ imports the module, and no view mentions it
 *   2. every flag defaults false, and createArBeauty with defaults is INERT
 *      against an env whose every property throws when read
 *   3. no lib/ar file can egress or persist: no fetch/XHR/WebSocket/RTC call
 *      shapes, no IndexedDB/localStorage/caches, no crypto
 *   4. lib/ar imports ONLY its own relative modules and the platform sibling
 *      ../camera/ — no npm dependency at all, and package.json is unchanged
 *   5. every lib/ar file honours the <500-line repo rule
 *   6. after `npm run build`, dist/ carries NO ar identifiers — checked when
 *      dist/ exists, SKIPPED LOUDLY otherwise (the release gate builds)
 *   7. every lib/ar module (except index.js) is imported by a test
 *
 *   node test/ar-fence.test.js
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { AR_DEFAULT_FLAGS, assertArShippedDark } from '../src/lib/ar/flags.js'
import { createArBeauty } from '../src/lib/ar/engine.js'
import { AR_UNAVAILABLE } from '../src/lib/ar/availability.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const ROOT = new URL('..', import.meta.url).pathname
const SRC = join(ROOT, 'src')
const TEST = join(ROOT, 'test')

function walk (dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|mjs)$/.test(entry)) out.push(full)
  }
  return out
}

const srcFiles = walk(SRC).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))
const arFiles = srcFiles.filter((f) => f.path.startsWith('src/lib/ar/'))
const outsideFiles = srcFiles.filter((f) => !f.path.startsWith('src/lib/ar/'))
const testFiles = walk(TEST).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))

/* --------------------------------------- 1. nothing in the app uses it --- */

check(`the module exists (${arFiles.length} files) so this fence is not vacuous`,
  arFiles.length >= 7)

{
  const importers = outsideFiles.filter((f) =>
    /from\s+['"][^'"]*lib\/ar\//.test(f.body) ||
    /import\s*\(\s*['"][^'"]*lib\/ar\//.test(f.body) ||
    /require\s*\(\s*['"][^'"]*lib\/ar\//.test(f.body))
  check(`NOT WIRED IN: none of the ${outsideFiles.length} app modules outside lib/ar/ imports it`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

  const viewFiles = outsideFiles.filter((f) => f.path.startsWith('src/views/'))
  const mentioners = viewFiles.filter((f) => /createArBeauty|lib\/ar\//i.test(f.body))
  check(`NO VIEW SURFACE: none of the ${viewFiles.length} views mentions the ar engine`,
    mentioners.length === 0)
  if (mentioners.length) console.log('    mentioned by:', mentioners.map((f) => f.path).join(', '))
}

/* ----------------------------------------------------- 2. shipped dark --- */

check('every flag defaults FALSE and assertArShippedDark agrees',
  Object.values(AR_DEFAULT_FLAGS).every((v) => v === false) && assertArShippedDark() === true)

{
  let inert = false
  let reason = null
  try {
    const ar = createArBeauty({
      flags: {},
      env: new Proxy({}, { get () { throw new Error('fence: env must never be read while dark') } }),
    })
    const a = ar.faceTracking.availability()
    const b = ar.beauty.stages({})
    inert = ar.enabled === false &&
      a.available === false && a.reason === AR_UNAVAILABLE.FLAG_DISABLED &&
      b.available === false && b.reason === AR_UNAVAILABLE.FLAG_DISABLED
  } catch (e) { reason = e.message }
  check('the DEFAULT factory is INERT against an env whose every read throws', inert)
  if (reason) console.log('    threw:', reason)
}

/* --------------------------------- 3. zero egress, zero persistence ------ */

{
  const egress = arFiles.filter((f) =>
    /\bfetch\s*\(/.test(f.body) || /globalThis\.fetch\s*\(/.test(f.body) ||
    /XMLHttpRequest/.test(f.body) || /new\s+WebSocket/.test(f.body) ||
    /sendBeacon/.test(f.body) || /RTCPeerConnection/.test(f.body) ||
    /\bEventSource\b/.test(f.body) || /\bio\s*\(/.test(f.body) || /socket\.io/.test(f.body))
  check('ZERO EGRESS: no lib/ar file can open a network path', egress.length === 0)
  if (egress.length) console.log('    egress in:', egress.map((f) => f.path).join(', '))

  const persistence = arFiles.filter((f) =>
    /\bindexedDB\s*[.[]/i.test(f.body) || /\blocalStorage\s*[.[]/.test(f.body) ||
    /\bsessionStorage\s*[.[]/.test(f.body) || /caches\.open\s*\(/.test(f.body) ||
    /navigator\.storage\b/.test(f.body))
  check('ZERO PERSISTENCE: no lib/ar file touches IndexedDB/localStorage/caches',
    persistence.length === 0)
  if (persistence.length) console.log('    persistence in:', persistence.map((f) => f.path).join(', '))

  const cryptoUse = arFiles.filter((f) => /crypto\.subtle|from\s+['"].*\/crypto\//.test(f.body))
  check('NO CRYPTO: the ar module neither implements nor imports crypto', cryptoUse.length === 0)
}

/* ------------------------------------------------- 4. no new dependency -- */

{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const before = ['@capacitor/push-notifications', '@trystero-p2p/torrent', 'jsqr',
    'qrcode-generator', 'socket.io-client', 'spotme-core', 'trystero']
  const deps = Object.keys(pkg.dependencies || {}).sort()
  check('ZERO NEW DEPENDENCIES: dependencies are exactly the pre-mission seven',
    deps.join(',') === before.sort().join(','))

  /* lib/ar may import its own relative modules and the platform sibling
   * ../camera/ (shared clock + image math). Anything else breaks the fence. */
  const ALLOW = (s) => s.startsWith('./') || s.startsWith('../camera/')
  const stray = arFiles.filter((f) => {
    const imports = [
      ...[...f.body.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...f.body.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ]
    return imports.some((s) => !ALLOW(s))
  })
  check('lib/ar imports ONLY its own modules and ../camera/ — no packages',
    stray.length === 0)
  if (stray.length) console.log('    stray imports in:', stray.map((f) => f.path).join(', '))
}

/* ----------------------------------------------------- 5. repo rules ----- */

{
  const oversized = arFiles.filter((f) => f.body.split('\n').length > 500)
  check('every lib/ar file is under 500 lines', oversized.length === 0)
  if (oversized.length) {
    console.log('    oversized:', oversized.map((f) => `${f.path} (${f.body.split('\n').length})`).join(', '))
  }
}

/* ------------------------------------------------ 6. the built bundle ---- */

{
  const dist = join(ROOT, 'dist')
  const needles = ['createArBeauty', 'AR_BEAUTY_ENABLED', 'NO_LANDMARK_ENGINE', 'BEAUTY_LIMITS', 'skinToneMask']
  if (existsSync(dist)) {
    const bundleFiles = walk(dist).filter((f) => /\.(js|mjs|css|html|map)$/.test(f))
    const hits = []
    for (const file of bundleFiles) {
      const body = readFileSync(file, 'utf8')
      for (const needle of needles) if (body.includes(needle)) hits.push(`${relative(ROOT, file)}: ${needle}`)
    }
    check(`TREE-SHAKEN OUT: dist/ (${bundleFiles.length} files) contains none of ${needles.length} ar identifiers`,
      hits.length === 0)
    if (hits.length) console.log('    found:', hits.join('; '))
  } else {
    console.log('  SKIP  bundle fence: no dist/ — run `npm run build` first; the release gate requires the built check')
  }
}

/* ------------------------------------- 7. …but nothing is unexamined ----- */

{
  const untested = arFiles.filter((f) => {
    const name = f.path.split('/').pop()
    if (name === 'index.js') return false     // index is re-exports only
    return !testFiles.some((t) => t.body.includes(`ar/${name}`))
  })
  check('every lib/ar module (except index) is imported by at least one test',
    untested.length === 0)
  if (untested.length) console.log('    untested:', untested.map((f) => f.path).join(', '))
}

console.log('\n========================================')
console.log('  ar fence — built, tested, dark, fenced, leak-free')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
