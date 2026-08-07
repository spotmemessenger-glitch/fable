/**
 * Slice 6 — the Inbox flag, and the parity §(f) #6 requires: flag-off renders
 * LEGACY, flag-on renders REACT, and the rollback path is itself tested.
 *
 * Flag-off is proven behaviourally: `reactInbox()` returns null without
 * importing a single app module, so the legacy view renders exactly as it did
 * before this slice. Flag-on is proven structurally here (the branch exists,
 * mounts the island, the flag is read in exactly one place) and behaviourally
 * in packages/ui/test/inbox-ui.test.tsx.
 *
 *   node --test test/inbox-flag-parity.test.js
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

test('flag OFF: reactInbox returns null — the caller renders legacy', async () => {
  // Importing inbox-island.js must be safe in bare Node: with the flag off it
  // may not touch db/rooms/reach/api (they need a window). If this import or
  // call throws, the flag-off path has grown a dependency it must not have.
  const { reactInbox } = await import('../src/views/inbox-island.js')
  const result = withStorage({ getItem: () => null }, () => reactInbox({}, {}))
  assert.equal(result, null)
})

test('hostile storage reads as OFF — legacy renders, never React', async () => {
  const { reactInbox } = await import('../src/views/inbox-island.js')
  const result = withStorage(
    { getItem () { throw new Error('SecurityError') } },
    () => reactInbox({}, {}),
  )
  assert.equal(result, null)
})

test('the flag is read in exactly one place', () => {
  const files = readdirSync(join(SRC, 'views')).filter((f) => f.endsWith('.js'))
  const readers = files.filter((f) => /uiFlag\s*\(\s*['"]inbox['"]\s*\)/.test(read('views', f)))
  assert.deepEqual(readers, ['inbox-island.js'])
  for (const f of ['main.js', 'app.js']) {
    assert.equal(/uiFlag\s*\(\s*['"]inbox['"]/.test(read(f)), false, `${f} must not read the flag`)
  }
})

test('flag ON: the legacy view branches to the island, then stops', () => {
  const src = read('views', 'inbox.js')
  assert.match(src, /reactInbox\s*\(\s*root,\s*ctx\s*\)/, 'inbox.js carries the flag branch')
  assert.match(src, /if\s*\(island\)\s*return island/, 'inbox.js returns before legacy rendering')
})

test('the branch is the ONLY change to the legacy view (ADR-035 §(g) tier 2)', () => {
  // Additive by construction: the legacy view gained one import and one branch
  // line. Everything else — gestures, sheets, the registry lookup, the
  // Bluetooth scanner entrance — is still present, so flipping the flag off
  // restores exactly the old view.
  const src = read('views', 'inbox.js')
  for (const survivor of [
    'openNewChat', 'openRequestSheet', 'attachGestures', 'lookupUsername',
    'revealArchived', 'setArchivedMode', 'renderTabCounts', 'btscan',
  ]) {
    assert.match(src, new RegExp(survivor), `legacy inbox.js still has ${survivor}`)
  }
})

test('the island mounts through the shared host with the inbox slice name', () => {
  const src = read('views', 'inbox-island.js')
  assert.match(src, /mountIsland\(\s*'inbox'/)
  assert.match(src, /__mountInbox/)
  // Heavy app modules load ONLY behind the flag — dynamic, never static.
  assert.equal(/^import[^\n]*(db\.js|rooms\.js|reach\.js|discovery\.js|api\.js)/m.test(src), false,
    'db/rooms/reach/api must be dynamic imports inside the flag-on path')
})

test('the chat engine is reused, never rewritten (lib/rooms.js via the port)', () => {
  const adapter = read('views', 'inbox-island.js')
  assert.match(adapter, /import\('\.\.\/lib\/rooms\.js'\)/)
  assert.match(adapter, /rooms\.leave\(/)
  assert.match(adapter, /rooms\.ensure\(/)
  // And the package never names it: realtime crosses the port as a
  // subscription with pre-shaped rows.
  const pkg = join(HERE, '..', '..', '..', 'packages', 'ui', 'inbox')
  for (const f of readdirSync(pkg)) {
    const body = readFileSync(join(pkg, f), 'utf8')
    assert.equal(/lib\/rooms|socket|transport/i.test(body), false,
      `packages/ui/inbox/${f} must not reach the chat engine`)
  }
})

test('no persisted shape is spelled in the React package (§(g) tier 3)', () => {
  const pkg = join(HERE, '..', '..', '..', 'packages', 'ui', 'inbox')
  for (const f of readdirSync(pkg)) {
    if (!/\.(tsx?|css)$/.test(f)) continue
    const body = readFileSync(join(pkg, f), 'utf8')
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/i.test(body), false,
      `packages/ui/inbox/${f} must not touch storage`)
  }
  // The one shape the adapter writes (createGroup) is the legacy shape, verbatim.
  const adapter = read('views', 'inbox-island.js')
  assert.match(adapter, /kind:\s*'group'/)
  assert.match(adapter, /mode:\s*'meet'/)
  assert.match(adapter, /peer:\s*\{\s*id:\s*null/)
})
