/**
 * THE FENCE: proves the camera engine is BUILT but NOT WIRED IN, ships
 * dark, and cannot leak.
 *
 * Like signing-not-shipped.test.js, this test is the enforcement of a
 * promise a PR description cannot enforce:
 *
 *   1. nothing outside lib/camera/ imports the module (one whitelisted
 *      import surface: NOTHING yet), and no view so much as mentions it
 *   2. every flag defaults false, and the factory with defaults is INERT
 *      against a throwing clock + throwing mediaDevices
 *   3. the module can NEVER egress or persist: no fetch/XHR/WebSocket/
 *      sendBeacon/RTC, no IndexedDB/localStorage, in any lib/camera file
 *   4. no new npm dependency was added for it
 *   5. every lib/camera file honours the <500-line repo rule
 *   6. after `npm run build`, dist/ carries NO camera-module identifiers —
 *      checked when dist/ exists; SKIPPED LOUDLY when it does not, and the
 *      release gate (production-checklist.md) requires the built check.
 *
 * The counterweight (the signing-fence lesson): unexercised capability is
 * worse than none — section 7 proves every lib/camera module is imported
 * by at least one test.
 *
 *   node test/camera-fence.test.js
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { DEFAULT_FLAGS, assertShippedDark } from '../src/lib/camera/flags.js'
import { createCameraEngine } from '../src/lib/camera/engine.js'
import { CAMERA_UNAVAILABLE } from '../src/lib/camera/availability.js'
import { throwingClock } from '../src/lib/camera/clock.js'
import { throwingMediaDevices } from './helpers/fake-media.js'

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
const cameraFiles = srcFiles.filter((f) => f.path.startsWith('src/lib/camera/'))
const outsideFiles = srcFiles.filter((f) => !f.path.startsWith('src/lib/camera/'))
const testFiles = walk(TEST).map((f) => ({ path: relative(ROOT, f), body: readFileSync(f, 'utf8') }))

/* --------------------------------------- 1. nothing in the app uses it --- */

check(`the module exists (${cameraFiles.length} files) so this fence is not vacuous`,
  cameraFiles.length >= 20)

{
  const importers = outsideFiles.filter((f) =>
    /from\s+['"][^'"]*lib\/camera\//.test(f.body) ||
    /import\s*\(\s*['"][^'"]*lib\/camera\//.test(f.body) ||
    /require\s*\(\s*['"][^'"]*lib\/camera\//.test(f.body))
  check(`NOT WIRED IN: none of the ${outsideFiles.length} app modules outside lib/camera/ imports it`,
    importers.length === 0)
  if (importers.length) console.log('    imported by:', importers.map((f) => f.path).join(', '))

  const viewFiles = outsideFiles.filter((f) => f.path.startsWith('src/views/'))
  const mentioners = viewFiles.filter((f) => /camera[-/]?engine|createCameraEngine|lib\/camera/i.test(f.body))
  check(`NO VIEW SURFACE: none of the ${viewFiles.length} views mentions the camera engine`,
    mentioners.length === 0)
  if (mentioners.length) console.log('    mentioned by:', mentioners.map((f) => f.path).join(', '))
}

/* ----------------------------------------------------- 2. shipped dark --- */

check('every flag defaults FALSE and assertShippedDark agrees',
  Object.values(DEFAULT_FLAGS).every((v) => v === false) && assertShippedDark() === true)

{
  let inert = false
  let reason = null
  try {
    const engine = createCameraEngine({
      env: {
        navigator: { mediaDevices: throwingMediaDevices('fence') },
        get document () { throw new Error('fence: document must never be read') },
      },
      clock: throwingClock('fence'),
    })
    const opened = await engine.openSession({ facing: 'back' })
    inert = engine.enabled === false && opened.available === false &&
      opened.reason === CAMERA_UNAVAILABLE.FLAG_DISABLED
  } catch (e) { reason = e.message }
  check('the DEFAULT factory is INERT against a throwing clock + throwing mediaDevices', inert)
  if (reason) console.log('    threw:', reason)
}

/* --------------------------------- 3. zero egress, zero persistence ------ */

{
  /* Call shapes, not bare words — the availability header may SAY
   * "no fetch" without failing this. */
  const egress = cameraFiles.filter((f) =>
    /\bfetch\s*\(/.test(f.body) || /XMLHttpRequest/.test(f.body) ||
    /new\s+WebSocket/.test(f.body) || /sendBeacon/.test(f.body) ||
    /RTCPeerConnection/.test(f.body) || /\bEventSource\b/.test(f.body) ||
    /\bio\s*\(/.test(f.body) || /socket\.io/.test(f.body))
  check('ZERO EGRESS: no lib/camera file can open a network path', egress.length === 0)
  if (egress.length) console.log('    egress in:', egress.map((f) => f.path).join(', '))

  /* Call shapes again: flags.js's header PROMISES "no localStorage read",
   * and a fence that fails on the promise's wording gets deleted. */
  const persistence = cameraFiles.filter((f) =>
    /\bindexedDB\s*[.[]/i.test(f.body) || /\blocalStorage\s*[.[]/.test(f.body) ||
    /\bsessionStorage\s*[.[]/.test(f.body) || /caches\.open\s*\(/.test(f.body) ||
    /navigator\.storage\b/.test(f.body))
  check('ZERO PERSISTENCE: no lib/camera file touches IndexedDB/localStorage/caches',
    persistence.length === 0)
  if (persistence.length) console.log('    persistence in:', persistence.map((f) => f.path).join(', '))

  const cryptoUse = cameraFiles.filter((f) => /crypto\.subtle|from\s+['"].*\/crypto\//.test(f.body))
  check('NO CRYPTO: the camera module neither implements nor imports crypto', cryptoUse.length === 0)
}

/* ------------------------------------------------- 4. no new dependency -- */

{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const before = ['@capacitor/push-notifications', '@trystero-p2p/torrent', 'jsqr',
    'qrcode-generator', 'socket.io-client', 'spotme-core', 'trystero']
  const deps = Object.keys(pkg.dependencies || {}).sort()
  check('ZERO NEW DEPENDENCIES: dependencies are exactly the pre-mission seven',
    deps.join(',') === before.sort().join(','))
  const cameraImportsOutside = cameraFiles.filter((f) => {
    // Import STATEMENTS, not the word `from "…"` in prose (clock.js's
    // header legitimately says: tell "slow" from "broken").
    const imports = [
      ...[...f.body.matchAll(/(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...f.body.matchAll(/import\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ]
    return imports.some((s) => !s.startsWith('./') && !s.startsWith('../'))
  })
  check('…and lib/camera imports ONLY its own relative modules — no packages at all',
    cameraImportsOutside.length === 0)
  if (cameraImportsOutside.length) console.log('    package imports in:', cameraImportsOutside.map((f) => f.path).join(', '))
}

/* ----------------------------------------------------- 5. repo rules ----- */

{
  const oversized = cameraFiles.filter((f) => f.body.split('\n').length > 500)
  check('every lib/camera file is under 500 lines', oversized.length === 0)
  if (oversized.length) {
    console.log('    oversized:', oversized.map((f) => `${f.path} (${f.body.split('\n').length})`).join(', '))
  }
}

/* ------------------------------------------------ 6. the built bundle ---- */

{
  const dist = join(ROOT, 'dist')
  const needles = ['createCameraEngine', 'CAMERA_ENGINE_ENABLED', 'NO_SEGMENTER_REGISTERED', 'spotme-camera']
  if (existsSync(dist)) {
    const bundleFiles = walk(dist).filter((f) => /\.(js|mjs|css|html)$/.test(f))
    const hits = []
    for (const file of bundleFiles) {
      const body = readFileSync(file, 'utf8')
      for (const needle of needles) if (body.includes(needle)) hits.push(`${relative(ROOT, file)}: ${needle}`)
    }
    check(`TREE-SHAKEN OUT: dist/ (${bundleFiles.length} files) contains none of ${needles.length} camera identifiers`,
      hits.length === 0)
    if (hits.length) console.log('    found:', hits.join('; '))
  } else {
    console.log('  SKIP  bundle fence: no dist/ — run `npm run build` first; the release gate requires the built check')
  }
}

/* ------------------------------------- 7. …but nothing is unexamined ----- */

{
  const untested = cameraFiles.filter((f) => {
    const name = f.path.split('/').pop()
    if (name === 'index.js' || name === 'pipeline-gl.js') return false     // index is re-exports; GL needs a browser
    return !testFiles.some((t) => t.body.includes(`camera/${name}`))
  })
  check('every lib/camera module (except index/GL) is imported by at least one test',
    untested.length === 0)
  if (untested.length) console.log('    untested:', untested.map((f) => f.path).join(', '))

  check('the two CI-unprovable files are exactly index.js (re-exports) and pipeline-gl.js (needs a GPU)',
    cameraFiles.some((f) => f.path.endsWith('index.js')) &&
    cameraFiles.some((f) => f.path.endsWith('pipeline-gl.js')))
}

console.log('\n========================================')
console.log('  camera fence — built, tested, dark, fenced, leak-free')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
