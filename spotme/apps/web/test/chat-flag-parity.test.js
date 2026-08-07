/**
 * Chat (final slice, session 1) — the flag, and the parity §(f) #6 requires:
 * flag-off renders LEGACY, flag-on renders REACT, and the rollback path is
 * itself tested.
 *
 * Flag-off is proven behaviourally: `reactChat()` returns null without
 * importing a single app module, so the legacy view renders exactly as it
 * did before this slice. Flag-on is proven structurally here (the branch
 * exists, the flag is read in exactly one place, the branch is the only
 * legacy change) and behaviourally in packages/ui/test/chat-ui.test.tsx.
 *
 *   node --test test/chat-flag-parity.test.js
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

test('flag OFF: reactChat returns null — the caller renders legacy', async () => {
  // Importing chat-island.js must be safe in bare Node: with the flag off it
  // may not touch db/rooms/ui (they need a window).
  const { reactChat } = await import('../src/views/chat-island.js')
  const result = withStorage({ getItem: () => null }, () => reactChat({}, {}, 'r1'))
  assert.equal(result, null)
})

test('hostile storage reads as OFF — legacy renders, never React', async () => {
  const { reactChat } = await import('../src/views/chat-island.js')
  const result = withStorage(
    { getItem () { throw new Error('SecurityError') } },
    () => reactChat({}, {}, 'r1'),
  )
  assert.equal(result, null)
})

test('the flag is read in exactly one place', () => {
  const files = readdirSync(join(SRC, 'views')).filter((f) => f.endsWith('.js'))
  const readers = files.filter((f) => /uiFlag\s*\(\s*['"]chat['"]\s*\)/.test(read('views', f)))
  assert.deepEqual(readers, ['chat-island.js'])
  for (const f of ['main.js', 'app.js']) {
    assert.equal(/uiFlag\s*\(\s*['"]chat['"]/.test(read(f)), false, `${f} must not read the flag`)
  }
})

test('flag ON: the legacy view branches to the island, then stops', () => {
  const src = read('views', 'chat.js')
  assert.match(src, /reactChat\s*\(\s*root,\s*ctx,\s*roomId\s*\)/, 'chat.js carries the flag branch')
  assert.match(src, /if\s*\(island\)\s*return island/, 'chat.js returns before legacy rendering')
})

test('the branch is the ONLY change to the legacy view (ADR-035 §(g) tier 2)', () => {
  // Additive by construction: chat.js gained one import and one branch.
  // Everything else — the crypto banner, view-once, voice notes, calls,
  // translation, gestures — is still present, so flipping the flag off
  // restores exactly the old view.
  const src = read('views', 'chat.js')
  for (const survivor of [
    'buildReadRow', 'sendText', 'buildQuote', 'roomUndecryptable',
    'viewOncePick', 'attachPress', 'retrySend', 'dispatchSend',
  ]) {
    assert.match(src, new RegExp(survivor), `legacy chat.js still has ${survivor}`)
  }
})

test('the island mounts through the shared host with the chat slice name', () => {
  const src = read('views', 'chat-island.js')
  assert.match(src, /mountIsland\(\s*'chat'/)
  assert.match(src, /__mountChat/)
})

test('the adapter reuses the engine — rooms.* only, no store/transport/crypto imports', () => {
  // Session 2 split the adapter: chat-island.js (flag + mount),
  // chat-island-port.js (the ChatPort over rooms/db), chat-island-media.js
  // (raw browser APIs). The engine calls live in the port file; the fences
  // hold across all three.
  const ADAPTER_FILES = ['chat-island.js', 'chat-island-port.js', 'chat-island-media.js']
  const port = read('views', 'chat-island-port.js')
  assert.match(port, /rooms\.sendMessage/, 'send goes through the same engine call the legacy view uses')
  assert.match(port, /rooms\.retryMessage/)
  assert.match(port, /rooms\.markRead/)
  // Session 2 mutations — same engine calls the legacy sheet makes.
  assert.match(port, /rooms\.react/)
  assert.match(port, /rooms\.editMessage/)
  assert.match(port, /rooms\.deleteMessage/)
  assert.match(port, /rooms\.sendAttachment/)
  // View-once: burn committed before reveal, then the open is reported.
  assert.ok(port.indexOf('rooms.viewOnceOpen(') < port.indexOf('ui.revealViewOnce('),
    'the burn (viewOnceOpen) must commit before the reveal')
  assert.match(port, /rooms\.viewOnceOpened/)
  for (const f of ADAPTER_FILES) {
    const src = read('views', f)
    for (const forbidden of ['socket-transport', 'store.js', 'crypto/', 'localStorage.setItem']) {
      assert.equal(src.includes(forbidden), false, `${f} must not touch ${forbidden}`)
    }
  }
})

test('session 2: the flag still has exactly one reader among the adapter files', () => {
  for (const f of ['chat-island-port.js', 'chat-island-media.js']) {
    assert.equal(/uiFlag/.test(read('views', f)), false, `${f} must not read any flag`)
  }
})
