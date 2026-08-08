/**
 * Slice 1 — the island host's flag, and the rollback that depends on it.
 *
 * ADR-035 §(f) requires a dark flag defaulting OFF and §(g) tier 1 requires
 * that flipping it off restores legacy on the next render. Both reduce to one
 * property: `uiFlag()` returns false unless a human explicitly opted in, and
 * it returns false rather than throwing when storage is hostile.
 *
 * The mount path itself is exercised in packages/ui; this pins the gate.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// fileURLToPath, not URL.pathname: on Windows the latter yields /C:/... and
// every read fails. Same trap the web suite hit before.
const SRC = fileURLToPath(new URL('../src/lib/island.js', import.meta.url))
const source = readFileSync(SRC, 'utf8')

/** Minimal localStorage stand-in; a throwing getItem models private mode. */
function withStorage (store, fn) {
  const prev = globalThis.localStorage
  globalThis.localStorage = store
  try { return fn() } finally { globalThis.localStorage = prev }
}

const load = () => import(`../src/lib/island.js?t=${Math.random()}`)

test('the flag is OFF when nothing is stored', async () => {
  const { uiFlag } = await load()
  withStorage({ getItem: () => null }, () => {
    assert.equal(uiFlag('exchange'), false)
  })
})

test('the flag is ON only for the exact string "on"', async () => {
  const { uiFlag } = await load()
  for (const [stored, expected] of [['on', true], ['ON', false], ['true', false], ['1', false], ['', false]]) {
    withStorage({ getItem: () => stored }, () => {
      assert.equal(uiFlag('exchange'), expected, `stored=${JSON.stringify(stored)}`)
    })
  }
})

test('it reads the namespaced key, so one grep finds every slice flag', async () => {
  const { uiFlag } = await load()
  const seen = []
  withStorage({ getItem: (k) => { seen.push(k); return null } }, () => uiFlag('exchange'))
  assert.deepEqual(seen, ['spotme.ui.exchange'])
})

test('hostile storage reads as OFF, never as ON', async () => {
  const { uiFlag } = await load()
  // Safari private mode throws on access rather than returning null. The
  // failure mode must be "legacy renders", never "React renders unexpectedly".
  withStorage({ getItem () { throw new Error('SecurityError: denied') } }, () => {
    assert.equal(uiFlag('exchange'), false)
  })
})

test('mountIsland refuses to mount while the flag is off', async () => {
  const { mountIsland } = await load()
  // Resolves false WITHOUT importing React or @spotme/ui — the caller's signal
  // to render legacy. If the dynamic import ran early this would reject.
  const result = await withStorage(
    { getItem: () => null },
    () => mountIsland('exchange', {}, () => null),
  )
  assert.equal(result, false)
})

test('the dark fence holds: no STATIC import of the ui package', () => {
  // A static specifier would make every dark surface reachable from the live
  // entry and would bundle React for the 100% of users who have the flag off.
  assert.equal(/^\s*import\s+[^\n]*['"]@spotme\/ui['"]/m.test(source), false)
  assert.match(source, /\['@spotme', 'ui'\]\.join\('\/'\)/)
})

test('the host writes nothing — no persisted shape to diverge on rollback', () => {
  assert.equal(/localStorage\.setItem|localStorage\.removeItem|indexedDB/.test(source), false)
})
