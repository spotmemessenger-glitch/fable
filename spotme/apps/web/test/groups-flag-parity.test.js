/**
 * Slice 3 — the Groups flag, and the parity §(f) #6 requires: flag-off
 * renders LEGACY, flag-on renders REACT, and the rollback path is tested
 * rather than assumed.
 *
 * Flag-off is proven behaviourally: `reactGroups()` returns null without
 * importing a single app module, so the legacy view renders exactly as it
 * did before this slice. Flag-on is proven structurally here (the branch
 * exists, mounts the island, and the flag is read in exactly one place) and
 * behaviourally in packages/ui/test/groups-ui.test.tsx, where the React
 * surface renders against the real permission rules.
 *
 *   node --test test/groups-flag-parity.test.js
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

test('flag OFF: reactGroups returns null — the caller renders legacy', async () => {
  // Importing groups-island.js must be safe in bare Node: with the flag off
  // it may not touch db/rooms/api (they need a window). If this import or
  // call throws, the flag-off path has grown a dependency it must not have.
  const { reactGroups } = await import('../src/views/groups-island.js')
  const result = withStorage({ getItem: () => null }, () => reactGroups({}, {}, 'list'))
  assert.equal(result, null)
})

test('hostile storage reads as OFF — legacy renders, never React', async () => {
  const { reactGroups } = await import('../src/views/groups-island.js')
  const result = withStorage(
    { getItem () { throw new Error('SecurityError') } },
    () => reactGroups({}, {}, 'manage', 'g1'),
  )
  assert.equal(result, null)
})

test('the flag is read in exactly one place', () => {
  // uiFlag('groups') appears ONLY in views/groups-island.js. The legacy views
  // call reactGroups() and never read the flag themselves.
  const files = readdirSync(join(SRC, 'views')).filter((f) => f.endsWith('.js'))
  const readers = files.filter((f) => /uiFlag\s*\(\s*['"]groups['"]\s*\)/.test(read('views', f)))
  assert.deepEqual(readers, ['groups-island.js'])
  for (const f of ['main.js', 'app.js']) {
    assert.equal(/uiFlag\s*\(\s*['"]groups['"]/.test(read(f)), false, `${f} must not read the flag`)
  }
})

test('flag ON: both legacy views branch to the island, then stop', () => {
  for (const [file, args] of [
    ['groups.js', /reactGroups\s*\(\s*root,\s*ctx,\s*'list'\s*\)/],
    ['group-manage.js', /reactGroups\s*\(\s*root,\s*ctx,\s*'manage',\s*groupId\s*\)/],
  ]) {
    const src = read('views', file)
    assert.match(src, args, `${file} carries the flag branch`)
    assert.match(src, /if\s*\(island\)\s*return island/, `${file} returns before legacy rendering`)
  }
})

test('the branch is the ONLY change to the legacy views (ADR-035 §(g) tier 2)', () => {
  // Additive by construction: each legacy view gained one import and one
  // branch line. Everything else — el() calls, the wizard, the action sheets —
  // is still present, so flipping the flag off restores exactly the old view.
  const list = read('views', 'groups.js')
  const manage = read('views', 'group-manage.js')
  for (const survivor of ['openGroupWizard', 'joinByHandle', 'actionSheet', 'loadServer']) {
    assert.match(list, new RegExp(survivor), `legacy groups.js still has ${survivor}`)
  }
  for (const survivor of ['memberMenu', 'drawMembers', 'Transfer ownership', 'groupsApi.setBan']) {
    assert.match(manage, new RegExp(survivor), `legacy group-manage.js still has ${survivor}`)
  }
  // group-new.js is reached only through legacy groups.js and stays untouched.
  assert.equal(/reactGroups|uiFlag|island/.test(read('views', 'group-new.js')), false)
})

test('the island mounts through the shared host with the groups slice name', () => {
  const src = read('views', 'groups-island.js')
  assert.match(src, /mountIsland\(\s*'groups'/)
  assert.match(src, /__mountGroups/)
  // Heavy app modules load ONLY behind the flag — dynamic, never static.
  assert.equal(/^import[^\n]*(db\.js|rooms\.js|groups-api\.js|api\.js)/m.test(src), false,
    'db/rooms/api must be dynamic imports inside the flag-on path')
})

test('no persisted shape is spelled in the React package (§(g) tier 3)', () => {
  // The convo shape lives app-side in groups-island.js; the package writes
  // only through the injected port and never names a storage API.
  const pkg = join(HERE, '..', '..', '..', 'packages', 'ui', 'groups')
  for (const f of readdirSync(pkg)) {
    if (!/\.(tsx?|css)$/.test(f)) continue
    const body = readFileSync(join(pkg, f), 'utf8')
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/i.test(body), false,
      `packages/ui/groups/${f} must not touch storage`)
  }
  // And the shape the adapter writes is the legacy shape, verbatim.
  const adapter = read('views', 'groups-island.js')
  assert.match(adapter, /kind:\s*'group'/)
  assert.match(adapter, /mode:\s*'meet'/)
  assert.match(adapter, /peer:\s*\{\s*id:\s*null/)
})
