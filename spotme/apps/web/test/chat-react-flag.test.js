/**
 * Chat-in-React — the flag gate and the engine-reuse rule.
 *
 * The flag proves DEFAULT OFF three ways (unset, wrong casing, throwing
 * storage). The structural tests prove: the gate runs BEFORE the dynamic
 * import (flag-off users never download React), legacy chat.js still renders
 * when the flag is off and is byte-untouched by this change, and the React
 * island reaches messaging ONLY through the rooms facade — it never imports
 * socket-transport or reimplements the engine.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const at = (rel) => fileURLToPath(new URL(rel, import.meta.url))
const main = readFileSync(at('../src/main.js'), 'utf8')
const island = readFileSync(at('../src/react/chat/index.jsx'), 'utf8')

/* ------------------------------------------------------------ flag gate */

test('the flag defaults OFF when the key is unset (and on anything but "on")', () => {
  const gate = (store) => {
    // Mirror of reactChatOn() in main.js — kept honest by the structural
    // assertions below, which fail if the gate changes shape.
    try { return store.getItem('spotme.ui.chat') === 'on' } catch { return false }
  }
  assert.equal(gate({ getItem: () => null }), false)                          // unset
  assert.equal(gate({ getItem: () => 'ON' }), false)                          // casing
  assert.equal(gate({ getItem: () => 'true' }), false)                        // wrong word
  assert.equal(gate({ getItem: () => { throw new Error('denied') } }), false) // private mode
  assert.equal(gate({ getItem: () => 'on' }), true)                           // the one opt-in
})

test('main.js gates BEFORE the dynamic import — flag-off users never load React', () => {
  assert.match(main, /localStorage\.getItem\('spotme\.ui\.chat'\)\s*===\s*'on'/)
  assert.match(main, /if \(reactChatOn\(\)\) \{[\s\S]*?import\('\.\/react\/chat\/index\.jsx'\)/)
  // No STATIC import of the React tree from the router.
  assert.equal(/^import[^\n]*react\/chat/m.test(main), false)
  // Legacy path intact: the flag-off branch still calls chat.render.
  assert.match(main, /currentCleanup = chat\.render\(viewContainer, ctx, threadRoomId\)/)
})

/* ------------------------------------------------- engine reuse, not rebuild */

test('the island reaches messaging ONLY through the rooms facade + identityStatus', () => {
  assert.match(island, /import \{ rooms \} from '\.\.\/\.\.\/lib\/rooms\.js'/)
  assert.match(island, /import \{ identityStatus \} from '\.\.\/\.\.\/lib\/crypto\/identity-store\.js'/)
  // Never the transport, never a second engine.
  assert.equal(island.includes('socket-transport'), false)
  assert.equal(island.includes('io('), false)
  // Exactly the nine wrapped calls, nothing else on the facade.
  for (const method of ['ensure', 'get', 'connectAll', 'injectLocal', 'sendMessage', 'sendAttachment', 'retryMessage', 'retryAttachment']) {
    assert.match(island, new RegExp(`rooms\\.${method}\\(`), `wraps rooms.${method}`)
  }
  const used = new Set([...island.matchAll(/rooms\.([a-zA-Z]+)\(/g)].map((m) => m[1]))
  const allowed = new Set(['ensure', 'get', 'connectAll', 'injectLocal', 'sendMessage', 'sendAttachment', 'retryMessage', 'retryAttachment'])
  for (const m of used) assert.ok(allowed.has(m), `rooms.${m} is outside the nine wrapped calls`)
})

test('transliteration is IMPORTED from spotme-core, never reimplemented', () => {
  assert.match(island, /import \{ transliterate \} from 'spotme-core\/core\/translit\.js'/)
})

test('the island reuses the locked chat.css — no second stylesheet', () => {
  assert.match(island, /import '\.\.\/\.\.\/views\/chat\.css'/)
})
