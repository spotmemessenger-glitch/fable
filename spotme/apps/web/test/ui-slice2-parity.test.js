/**
 * Slice 2 — Contacts · Notifications · Stories behind their own dark flags.
 *
 * DoD #6 parity, pinned the way slice 1 pinned Exchange (ui-flag.test.js):
 * the React render itself is exercised in packages/ui with Testing Library;
 * here we pin the GATE — flag-off must take the legacy path, flag-on must
 * take the island path — plus the §(g) tier-3 rule that the React path
 * persists nothing the legacy code does not.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const SLICES = [
  ['contacts', '../src/views/contacts.js', 'contactsIsland', 'v-contacts|pressTimers'],
  ['notifications', '../src/views/notifications.js', 'notificationsIsland', 'v-notif'],
  ['stories', '../src/views/stories.js', 'storiesIsland', 'v-stories']
]

const load = () => import(`../src/lib/island.js?t=${Math.random()}`)

function withStorage (store, fn) {
  const prev = globalThis.localStorage
  globalThis.localStorage = store
  try { return fn() } finally { globalThis.localStorage = prev }
}

for (const [slice, viewPath, islandFn, legacyMarker] of SLICES) {
  test(`${slice}: flag defaults ON (sweep-passed), explicit non-'on' restores legacy, reads only spotme.ui.${slice}`, async () => {
    const { uiFlag } = await load()
    const seen = []
    withStorage({ getItem: (k) => { seen.push(k); return null } }, () => {
      assert.equal(uiFlag(slice), true, 'absent key renders React — the 2026-08-08 default flip')
    })
    assert.deepEqual(seen, [`spotme.ui.${slice}`])
    // The off-switch: any explicit value other than 'on' falls back to legacy.
    withStorage({ getItem: () => 'off' }, () => assert.equal(uiFlag(slice), false))
    // Hostile storage (private mode) must read as OFF — legacy renders.
    withStorage({ getItem () { throw new Error('denied') } }, () => {
      assert.equal(uiFlag(slice), false)
    })
    withStorage({ getItem: () => 'on' }, () => assert.equal(uiFlag(slice), true))
  })

  test(`${slice}: render() branches to the island on the flag, before any legacy work`, () => {
    const src = read(viewPath)
    const code = strip(src)
    // Exactly one flag read, guarding an early return into the adapter.
    const branch = new RegExp(`if \\(uiFlag\\('${slice}'\\)\\) return ${islandFn}\\(root, ctx\\)`)
    assert.match(code, branch)
    assert.equal(code.match(/uiFlag\(/g).length, 1, 'flag read in exactly one place per view')
    // The legacy body survives untouched below the branch (tier-1 rollback).
    assert.match(code, new RegExp(legacyMarker))
    const branchAt = code.search(branch)
    const legacyAt = code.search(new RegExp(legacyMarker))
    assert.ok(branchAt < legacyAt, 'flag branch precedes the legacy body')
  })
}

test('adapters persist nothing beyond the legacy notifSeenTs acknowledgement', () => {
  const code = strip(read('../src/lib/island-adapters.js'))
  assert.equal(/localStorage|sessionStorage|indexedDB/.test(code), false)
  // The only settings write is the same key/shape the legacy cleanup writes.
  const writes = code.match(/db\.setSettings\([^\n]*/g) || []
  assert.deepEqual(writes, ['db.setSettings({ notifSeenTs: Date.now() })'])
})

test('the ROUTES table itself is untouched by slice 2', () => {
  const code = strip(read('../src/main.js'))
  for (const route of ['#/contacts', '#/notifications', '#/stories']) {
    assert.match(code, new RegExp(`'${route}'`))
  }
  assert.equal(/island/.test(code), false, 'main.js gained no island wiring; the branch lives in the views')
})
