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

test('THE INVERSION: proven slices default ON; chat and moments stay OFF', async () => {
  const { uiFlag } = await load()
  withStorage({ getItem: () => null }, () => {
    for (const s of ['profile', 'inbox', 'contacts', 'notifications', 'groups', 'stories', 'discovery', 'verify', 'exchange']) {
      assert.equal(uiFlag(s), true, `${s} should default ON (functional sweep 2026-08-08)`)
    }
    // chat: the owner flips it himself. moments: its React slice has no composer.
    assert.equal(uiFlag('chat'), false)
    assert.equal(uiFlag('moments'), false)
  })
})

test("the literal 'off' opts a device back to legacy — the promised rollback", async () => {
  const { uiFlag } = await load()
  for (const [stored, expected] of [['off', false], ['on', true], ['OFF', true], ['0', true], ['', true]]) {
    withStorage({ getItem: () => stored }, () => {
      assert.equal(uiFlag('exchange'), expected, `stored=${JSON.stringify(stored)} (only the exact 'off' disables a default-on slice)`)
    })
  }
  // A default-OFF slice still needs the exact 'on'.
  for (const [stored, expected] of [['on', true], ['ON', false], ['true', false], [null, false]]) {
    withStorage({ getItem: () => stored }, () => {
      assert.equal(uiFlag('chat'), expected, `chat stored=${JSON.stringify(stored)}`)
    })
  }
})

test('it reads the namespaced key, so one grep finds every slice flag', async () => {
  const { uiFlag } = await load()
  const seen = []
  withStorage({ getItem: (k) => { seen.push(k); return null } }, () => uiFlag('exchange'))
  assert.deepEqual(seen, ['spotme.ui.exchange'])
})

test('hostile storage reads as OFF, never as ON — even for default-on slices', async () => {
  const { uiFlag } = await load()
  // Safari private mode throws on access rather than returning null. The safe
  // direction is unchanged by the inversion: a broken storage layer renders
  // legacy, it can never flip a device INTO React.
  withStorage({ getItem () { throw new Error('SecurityError: denied') } }, () => {
    assert.equal(uiFlag('exchange'), false)
    assert.equal(uiFlag('chat'), false)
  })
})

test('mountIsland refuses to mount while the flag is off', async () => {
  const { mountIsland } = await load()
  // Resolves false WITHOUT importing React or @spotme/ui — the caller's signal
  // to render legacy. Post-inversion the explicit 'off' is the off state.
  const result = await withStorage(
    { getItem: () => 'off' },
    () => mountIsland('exchange', {}, () => null),
  )
  assert.equal(result, false)
})

test('the dark fence holds: the ui package is DYNAMIC-only, behind the flag', () => {
  // A static specifier would make every dark surface reachable from the live
  // entry and would bundle React for the 100% of users who have the flag off.
  assert.equal(/^\s*import\s+[^\n]*['"]@spotme\/ui['"]/m.test(source), false)

  /* The specifier is now a LITERAL inside import(). It used to be assembled
   * (`['@spotme','ui'].join('/')`) to hide from the fence — which also hid it
   * from Rollup, so the browser received a bare specifier it could not
   * resolve and every surface fell back to legacy. Literal + dynamic is what
   * keeps BOTH properties: resolvable, and code-split. */
  assert.match(source, /import\(\s*['"]@spotme\/ui['"]\s*\)/)
  assert.equal(/@vite-ignore/.test(source), false, '@vite-ignore keeps the bundler from resolving it')

  // The flag guard must come first: flag off means the chunk is never fetched.
  assert.ok(source.indexOf('if (!uiFlag(slice)) return false') < source.search(/import\(\s*['"]@spotme\/ui['"]/))
})

test('the host writes nothing — no persisted shape to diverge on rollback', () => {
  assert.equal(/localStorage\.setItem|localStorage\.removeItem|indexedDB/.test(source), false)
})
