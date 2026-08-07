/**
 * Chat crypto lines through the React port (ADR-035 final slice, session 4).
 *
 * Pins two things:
 *   1. chat-island-crypto.js produces EXACTLY the legacy sentences (chat.js
 *      sysLine / keyWarning) — the copy is characterization, not invention —
 *      and only ever display strings: no key material, no identity objects.
 *   2. the port's undecryptable state machine matches legacy chat.js:
 *      'wrong-key' may upgrade 'no-key' (never the reverse), and the first
 *      incoming frame that opens clears it.
 *
 *   node --test test/chat-crypto-react.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildChatPort } from '../src/views/chat-island-port.js'

const HERE = dirname(fileURLToPath(new URL(import.meta.url)))
const legacy = readFileSync(join(HERE, '..', 'src', 'views', 'chat.js'), 'utf8')
const cryptoAdapter = readFileSync(join(HERE, '..', 'src', 'views', 'chat-island-crypto.js'), 'utf8')

/* A pure stand-in for buildSecurityView so this test needs no browser storage:
 * same signature, distinguishable outputs. The REAL sentence parity is
 * asserted textually below against chat.js. */
const fakeSecurity = ({ e2eVersion, undecryptableReason, peerName }) => ({
  sysText: e2eVersion === 'e2e_v2' ? 'v2-claim' : 'v1-claim',
  canVerify: e2eVersion === 'e2e_v2',
  warnText: undecryptableReason ? `${undecryptableReason}:${peerName || ''}` : null
})

function makeHarness ({ e2eVersion = 'e2e_v2' } = {}) {
  const handlers = new Set()
  const conn = {
    readUpTo: 0,
    peerCount: 0,
    typing: null,
    store: { list: () => [] },
    on (fn) { handlers.add(fn); return () => handlers.delete(fn) }
  }
  const db = {
    convo: () => ({ roomId: 'r1', e2eVersion, peer: { id: 'p1', name: 'Asha' } }),
    profile: () => ({ id: 'me' }),
    subscribe: () => () => {},
    convos: () => []
  }
  const rooms = { ensure: () => conn, markRead: () => {}, typing: () => {} }
  const port = buildChatPort(
    { db, rooms, fmtTime: () => '10:00', fmtDay: () => 'Mon', security: fakeSecurity },
    { nav: () => {}, toast: () => {} },
    'r1',
    { mapLink: () => '' }
  )
  port.subscribe(() => {})
  return { port, emit: (ev) => { for (const fn of handlers) fn(ev) } }
}

test('a v2 room carries the claim + Verify; a v1 room neither warns nor verifies', () => {
  const v2 = makeHarness().port.snapshot().security
  assert.deepEqual(v2, { sysText: 'v2-claim', canVerify: true, warnText: null })
  const v1 = makeHarness({ e2eVersion: 'e2e_v1' }).port.snapshot().security
  assert.equal(v1.canVerify, false)
  assert.equal(v1.warnText, null)
})

test("undecryptable machine: 'wrong-key' upgrades 'no-key', never the reverse", () => {
  const { port, emit } = makeHarness()
  emit({ type: 'undecryptable', reason: 'no-key' })
  assert.equal(port.snapshot().security.warnText, 'no-key:Asha')
  emit({ type: 'undecryptable', reason: 'wrong-key' })
  assert.equal(port.snapshot().security.warnText, 'wrong-key:Asha', 'wrong-key upgrades')
  emit({ type: 'undecryptable', reason: 'no-key' })
  assert.equal(port.snapshot().security.warnText, 'wrong-key:Asha', 'no-key never downgrades')
})

test('the first incoming frame that opens clears the warning', () => {
  const { port, emit } = makeHarness()
  emit({ type: 'undecryptable', reason: 'wrong-key' })
  assert.ok(port.snapshot().security.warnText)
  emit({ type: 'message', message: { id: 'm1', text: 'hi' } })
  assert.equal(port.snapshot().security.warnText, null)
})

test('openVerify routes to the same verify hash the legacy sysLine link takes', () => {
  let navved = null
  const handlers = new Set()
  const conn = { readUpTo: 0, peerCount: 0, typing: null, store: { list: () => [] }, on (fn) { handlers.add(fn); return () => {} } }
  const port = buildChatPort(
    {
      db: { convo: () => ({ roomId: 'r9', e2eVersion: 'e2e_v2', peer: {} }), profile: () => ({ id: 'me' }), subscribe: () => () => {}, convos: () => [] },
      rooms: { ensure: () => conn },
      fmtTime: () => '', fmtDay: () => ''
    },
    { nav: (p) => { navved = p }, toast: () => {} },
    'r9',
    { mapLink: () => '' }
  )
  port.openVerify()
  assert.equal(navved, '#/verify/r9')
  assert.match(legacy, /#\/verify\/\$\{roomId\}/, 'the legacy link still exists (tier 2)')
})

test('the adapter sentences ARE the legacy sentences (characterization, not invention)', () => {
  for (const sentence of [
    'Messages are encrypted with keys made on your devices. Translation runs on-device when possible.',
    'Older chat — its key came from both account IDs, so the server could read it.',
    'Messages are arriving but this device can’t unlock them yet. ',
    '’s security key changed — ',
    'This device can’t save its encryption key, so the other person can’t read what you send here. Reloading won’t fix it.',
    'This device can’t store encryption keys at all — private browsing is the usual cause. Open Spot Me in a normal window.'
  ]) {
    assert.ok(cryptoAdapter.includes(sentence), `adapter carries: ${sentence.slice(0, 40)}…`)
    assert.ok(legacy.includes(sentence), `legacy still carries: ${sentence.slice(0, 40)}…`)
  }
})

test('display strings only: the crypto adapter reads status, never key material', () => {
  // The one crypto import is identity-store's status word; nothing key-shaped.
  assert.match(cryptoAdapter, /import \{ identityStatus \} from '\.\.\/lib\/crypto\/identity-store\.js'/)
  for (const forbidden of ['loadIdentity', 'exportPublicKey', 'privateKey', 'publicKeyB64', 'generateKey']) {
    assert.equal(cryptoAdapter.includes(forbidden), false, `chat-island-crypto.js must not touch ${forbidden}`)
  }
})
