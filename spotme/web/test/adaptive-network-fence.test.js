/**
 * THE FENCE — the adaptive network is BUILT and NOT WIRED, and the app is
 * byte-identical while it stays that way.
 *
 * Four fences, each executable:
 *
 *   1. NOTHING in src/ outside transport-supervisor/ imports the supervisor
 *      — checked by scanning the actual source tree, so a wiring line
 *      anywhere (a view, rooms.js, reach.js) fails THIS test before any
 *      reviewer has to notice. The single sanctioned exception is db.js's
 *      wipe registration, which is a STRING (a database name), not an
 *      import — asserted separately.
 *   2. Every flag ships false (both the scaffold's and flags.js's).
 *   3. The SEAL-LIFT IS STILL DEFERRED AND THROWING — the same assertion the
 *      scaffold made, re-pinned here so this PR provably did not implement
 *      it (ADR-008 §12).
 *   4. The barrel imports clean with zero timers armed (construction is
 *      side-effect-free), and the default factory is inert.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

/* ============ 1. nothing outside the module imports the module ============ */

check('NOT WIRED: no src file outside transport-supervisor/ imports the supervisor', () => {
  const offenders = []
  for (const file of walk(SRC)) {
    if (file.includes(`${join('lib', 'transport-supervisor')}`)) continue
    const text = readFileSync(file, 'utf8')
    // An IMPORT of the supervisor is wiring. (String mentions — e.g. the wipe
    // list's database NAME in db.js — are not imports and are checked below.)
    if (/import[^;]*['"][^'"]*transport-supervisor[^'"]*['"]/.test(text)) offenders.push(file)
  }
  if (offenders.length) throw new Error(`wired into: ${offenders.join(', ')}`)
  return true
})

check('…and no view or live-path file even mentions the supervisor directory', () => {
  const allowedMentions = new Set([join(SRC, 'lib', 'db.js')])   // the wipe NAME, sanctioned
  const offenders = []
  for (const file of walk(SRC)) {
    if (file.includes(`${join('lib', 'transport-supervisor')}`)) continue
    if (allowedMentions.has(file)) continue
    const text = readFileSync(file, 'utf8')
    if (/transport-supervisor|adaptive-outbox|createAdaptiveNetwork/.test(text)) offenders.push(file)
  }
  if (offenders.length) throw new Error(`mentioned in: ${offenders.join(', ')}`)
  return true
})

check('db.js touches ONLY the wipe list: a database NAME, no import, no construction', () => {
  const text = readFileSync(join(SRC, 'lib', 'db.js'), 'utf8')
  const mentionsName = text.includes("dropDatabase('spotme-adaptive-outbox')")
  const importsModule = /import[^;]*transport-supervisor/.test(text)
  const constructsAnything = /createDurableOutbox|createAdaptiveNetwork|createSupervisor/.test(text)
  return mentionsName && !importsModule && !constructsAnything
})

check('no UI surface offers a transport choice: views never import transport selection or the supervisor', () => {
  const offenders = []
  for (const file of walk(join(SRC, 'views'))) {
    const text = readFileSync(file, 'utf8')
    if (/transport-supervisor/.test(text)) offenders.push(`${file}: supervisor`)
    if (/setTransport|selectedTransport/.test(text)) offenders.push(`${file}: transport picker`)
  }
  if (offenders.length) throw new Error(offenders.join(', '))
  return true
})

/* ======================= 2 + 3 + 4: the live checks ======================= */

await checkAsync('every flag ships FALSE; the barrel loads pure; the seal-lift STILL THROWS', async () => {
  const SUP = await import('../src/lib/transport-supervisor/index.js')
  // 2. dark
  if (SUP.ADAPTIVE_TRANSPORT_ENABLED !== false) return false
  if (SUP.isAdaptiveTransportEnabled() !== false) return false
  SUP.assertShippedDark()
  if (SUP.isMasterEnabled() !== false) return false
  // 3. the seal-lift is deferred, throwing, and asserted by the same check
  //    the scaffold shipped — this PR did not move any crypto.
  if (SUP.SEAL_LIFT_STATUS.implemented !== false) return false
  SUP.assertSealLiftNotImplemented(SUP.createDeferredSealer())
  return true
})

await checkAsync('the default factory is INERT and the import armed no timers', async () => {
  const { createAdaptiveNetwork } = await import('../src/lib/transport-supervisor/network.js')
  const boobyTrappedClock = new Proxy({}, {
    get () { throw new Error('a timer was constructed with every flag off') }
  })
  const net = createAdaptiveNetwork({ clock: boobyTrappedClock })
  return net.enabled === false && net.supervisor === null && net.mesh === null && net.drainer === null
})

check('the adapters barrel is separate: the main barrel does not re-export adapter factories', () => {
  // Keeps the pure barrel free of even lazily-importing adapter modules, so
  // its "no reach toward the live path" property is structural.
  const text = readFileSync(join(SRC, 'lib', 'transport-supervisor', 'index.js'), 'utf8')
  return !/adapters\//.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))
})

check('adapter modules reach the live path ONLY through lazy dynamic import', () => {
  // A STATIC import of socket-transport.js / transport/*.js from an adapter
  // would drag the live message path into the supervisor graph. The two
  // sanctioned static imports are the CONTRACT modules (ITransportAdapter
  // re-exported via adapter-kit) which are pure constants.
  const dir = join(SRC, 'lib', 'transport-supervisor', 'adapters')
  const offenders = []
  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf8')
    const statics = [...text.matchAll(/^import[^;]*from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const spec of statics) {
      if (/socket-transport|transport\/(socketio|centrifugo)-adapter|transport\/room|transport\/select|transport\/index/.test(spec)) {
        offenders.push(`${file} -> ${spec}`)
      }
    }
  }
  if (offenders.length) throw new Error(offenders.join(', '))
  return true
})

/* ------------------------------------------------------------- report --- */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  adaptive network fence — built, dark, not wired')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================')
if (passed !== names.length) process.exit(1)
