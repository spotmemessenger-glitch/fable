/**
 * Slice 5 — the Discovery flag, and the parity ADR-035 §(f) #6 requires:
 * flag-off renders LEGACY, flag-on renders REACT, and the rollback path is
 * tested rather than assumed. Modeled on groups-flag-parity (slice 3).
 *
 *   node --test test/discovery-flag-parity.test.js
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(new URL(import.meta.url)))
const SRC = join(HERE, '..', 'src')
const read = (...p) => readFileSync(join(SRC, ...p), 'utf8')

function withStorage (store, fn) {
  const prev = globalThis.localStorage
  globalThis.localStorage = store
  try { return fn() } finally { globalThis.localStorage = prev }
}

test('flag OFF: reactDiscovery returns null — the caller renders legacy', async () => {
  const { reactDiscovery } = await import('../src/views/discovery-island.js')
  const result = withStorage({ getItem: () => 'off' }, () => reactDiscovery({}, {}))
  assert.equal(result, null)
})

test('hostile storage reads as OFF — legacy renders, never React', async () => {
  const { reactDiscovery } = await import('../src/views/discovery-island.js')
  const result = withStorage(
    { getItem () { throw new Error('SecurityError') } },
    () => reactDiscovery({}, {}),
  )
  assert.equal(result, null)
})

test('the flag is read in exactly one place', () => {
  const files = readdirSync(join(SRC, 'views')).filter((f) => f.endsWith('.js'))
  const readers = files.filter((f) => /uiFlag\s*\(\s*['"]discovery['"]\s*\)/.test(read('views', f)))
  assert.deepEqual(readers, ['discovery-island.js'])
  for (const f of ['main.js', 'app.js']) {
    assert.equal(/uiFlag\s*\(\s*['"]discovery['"]/.test(read(f)), false, `${f} must not read the flag`)
  }
})

test('flag ON: the legacy view branches to the island, then stops', () => {
  const src = read('views', 'discovery.js')
  assert.match(src, /reactDiscovery\s*\(\s*root,\s*ctx\s*\)/, 'discovery.js carries the flag branch')
  assert.match(src, /if\s*\(island\)\s*return island/, 'discovery.js returns before legacy rendering')
})

test('the branch is the ONLY change to the legacy view (ADR-035 §(g) tier 2)', () => {
  // Additive by construction: the legacy view gained one import and one
  // branch. The Google map, radar, filters, request sheet — all still there,
  // so flipping the flag off restores exactly the old screen.
  const src = read('views', 'discovery.js')
  for (const survivor of ['loadGoogleMaps', 'drawMarkersDrawn', 'openRequestSheet', 'sendWave',
    'drawRings', 'syncRangeSel', 'gm_authFailure']) {
    assert.match(src, new RegExp(survivor), `legacy discovery.js still has ${survivor}`)
  }
})

test('lib/discovery.js — the ADR-024 fence-covered module — is untouched by the slice', () => {
  // The React path REUSES the lobby via ports; it must never fork it. The
  // coarse() broadcast and its doc contract stay exactly as ADR-024 fixed them.
  const src = read('lib', 'discovery.js')
  assert.match(src, /pub \? pub\.lat : null/, 'announcement still publishes only coarse output')
  assert.match(src, /export function coarse /, 'coarse() still exported')
  assert.equal(/island|react|uiFlag/i.test(src), false, 'lib/discovery.js knows nothing of the migration')
})

test('the island mounts through the shared host with the discovery slice name', () => {
  const src = read('views', 'discovery-island.js')
  assert.match(src, /mountIsland\(\s*'discovery'/)
  assert.match(src, /__mountDiscoveryLive/)
  // Heavy app modules load ONLY behind the flag — dynamic, never static.
  assert.equal(/^import[^\n]*(db\.js|reach\.js|lib\/discovery\.js|translate\.js)/m.test(src), false,
    'db/lobby/reach must be dynamic imports inside the flag-on path')
})

test('no persisted shape is spelled in the React package (§(g) tier 3)', () => {
  const pkg = join(HERE, '..', '..', '..', 'packages', 'ui', 'discovery-live')
  for (const f of readdirSync(pkg)) {
    const body = readFileSync(join(pkg, f), 'utf8')
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/i.test(body), false,
      `packages/ui/discovery-live/${f} must not touch storage`)
  }
  // The only writes on the adapter path are the legacy keys, legacy shapes.
  const adapter = read('views', 'discovery-island.js')
  assert.match(adapter, /db\.setSettings\(\{ rangeM: m \}\)/)
  assert.match(adapter, /db\.setSettings\(\{ showOnMap: on \}\)/)
  assert.equal(/upsertConvo|setProfile|localStorage/.test(adapter), false,
    'the adapter writes nothing beyond the two legacy settings keys')
})
