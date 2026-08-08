/**
 * Slice 4 — Profile & Settings behind spotme.ui.profile (dark, default OFF).
 *
 * Same shape as ui-slice2-parity.test.js: the React render is exercised in
 * packages/ui with Testing Library; here we pin the GATE (flag-off → legacy,
 * flag-on → island) and the §(g) tier-3 rule — the React path persists
 * nothing the legacy view does not, under exactly the same keys.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

const load = () => import(`../src/lib/island.js?t=${Math.random()}`)

function withStorage (store, fn) {
  const prev = globalThis.localStorage
  globalThis.localStorage = store
  try { return fn() } finally { globalThis.localStorage = prev }
}

test('profile: flag defaults ON (sweep-passed), explicit non-\'on\' restores legacy, reads only spotme.ui.profile', async () => {
  const { uiFlag } = await load()
  const seen = []
  withStorage({ getItem: (k) => { seen.push(k); return null } }, () => {
    assert.equal(uiFlag('profile'), true, 'absent key renders React — the 2026-08-08 default flip')
  })
  assert.deepEqual(seen, ['spotme.ui.profile'])
  withStorage({ getItem: () => 'off' }, () => assert.equal(uiFlag('profile'), false))
  withStorage({ getItem () { throw new Error('denied') } }, () => {
    assert.equal(uiFlag('profile'), false)
  })
  withStorage({ getItem: () => 'on' }, () => assert.equal(uiFlag('profile'), true))
})

test('profile: render() branches to the island on the flag, before any legacy work', () => {
  const code = strip(read('../src/views/profile.js'))
  const branch = /if \(uiFlag\('profile'\)\) return profileIsland\(root, ctx\)/
  assert.match(code, branch)
  assert.equal(code.match(/uiFlag\(/g).length, 1, 'flag read in exactly one place')
  // The legacy body survives untouched below the branch (tier-1 rollback).
  assert.match(code, /v-profile/)
  assert.ok(code.search(branch) < code.search(/v-profile/), 'flag branch precedes the legacy body')
})

test('profile adapter writes only the exact keys the legacy view writes', () => {
  const adapter = strip(read('../src/lib/island-adapters-profile.js'))
  const legacy = strip(read('../src/views/profile.js'))

  // The only raw-storage touch is the legacy danger-zone clear; nothing else.
  const rawStorage = adapter.match(/\b(localStorage|sessionStorage|indexedDB)\b[.\w]*/g) || []
  assert.deepEqual([...new Set(rawStorage)], ['localStorage.clear'])
  assert.match(legacy, /localStorage\.clear\(\)/, 'legacy performs the same clear')

  // Every setProfile / setSettings key the adapter writes is one the legacy
  // view also writes — same keys, same schema owner (§(g) tier 3).
  const keysOf = (src) => {
    const keys = new Set()
    for (const m of src.matchAll(/db\.set(?:Profile|Settings)\(\{ ?([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const key = part.split(':')[0].trim()
        if (key) keys.add(key)
      }
    }
    return keys
  }
  const legacyKeys = keysOf(legacy)
  for (const key of keysOf(adapter)) {
    assert.ok(legacyKeys.has(key), `adapter writes key "${key}" the legacy view never writes`)
  }
})

test('the ROUTES table itself is untouched by slice 4', () => {
  const code = strip(read('../src/main.js'))
  assert.match(code, /'#\/settings'/)
  assert.equal(/island/.test(code), false, 'main.js gained no island wiring; the branch lives in the view')
})
