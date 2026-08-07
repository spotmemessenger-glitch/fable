/**
 * Verify (final slice, session 4) — the flag, and the parity §(f) #6
 * requires: flag-off renders LEGACY, flag-on renders REACT, and the rollback
 * path is itself tested. Plus the crypto fences this screen carries: the
 * adapter REUSES the legacy safety-number/identity modules (never rewrites
 * them), and ADR-008 §12 stays untouched — nothing signing-shaped appears.
 *
 *   node --test test/verify-flag-parity.test.js
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

test('flag OFF: reactVerify returns null — the caller renders legacy', async () => {
  const { reactVerify } = await import('../src/views/verify-island.js')
  const result = withStorage({ getItem: () => null }, () => reactVerify({}, {}, 'r1'))
  assert.equal(result, null)
})

test('hostile storage reads as OFF — legacy renders, never React', async () => {
  const { reactVerify } = await import('../src/views/verify-island.js')
  const result = withStorage(
    { getItem () { throw new Error('SecurityError') } },
    () => reactVerify({}, {}, 'r1'),
  )
  assert.equal(result, null)
})

test('the flag is read in exactly one place', () => {
  const files = readdirSync(join(SRC, 'views')).filter((f) => f.endsWith('.js'))
  const readers = files.filter((f) => /uiFlag\s*\(\s*['"]verify['"]\s*\)/.test(read('views', f)))
  assert.deepEqual(readers, ['verify-island.js'])
  for (const f of ['main.js', 'app.js']) {
    assert.equal(/uiFlag\s*\(\s*['"]verify['"]/.test(read(f)), false, `${f} must not read the flag`)
  }
})

test('flag ON: the legacy view branches to the island, then stops', () => {
  const src = read('views', 'verify.js')
  assert.match(src, /reactVerify\s*\(\s*root,\s*ctx,\s*roomId\s*\)/, 'verify.js carries the flag branch')
  assert.match(src, /if\s*\(island\)\s*return island/, 'verify.js returns before legacy rendering')
})

test('the branch is the ONLY change to the legacy view (ADR-035 §(g) tier 2)', () => {
  const src = read('views', 'verify.js')
  for (const survivor of [
    'safetyNumber', 'formatSafetyNumber', 'encodeVerificationPayload',
    'verifyScannedPayload', 'recordVerification', 'applyToRecord',
    'trustLine', 'scanFailureText', 'QR_REFRESH_MS', 'isEnforcing',
  ]) {
    assert.match(src, new RegExp(survivor), `legacy verify.js still has ${survivor}`)
  }
})

test('the island mounts through the shared host with the verify slice name', () => {
  const src = read('views', 'verify-island.js')
  assert.match(src, /mountIsland\(\s*'verify'/)
  assert.match(src, /__mountVerify/)
})

test('the adapter REUSES the legacy crypto modules — same calls, no rewrites', () => {
  const src = read('views', 'verify-island.js')
  for (const call of [
    'loadIdentity', 'exportPublicKeyB64', 'safetyNumber(', 'formatSafetyNumber',
    'readRecord', 'applyToRecord', 'recordVerification', 'setRoomTrust',
    'isEnforcing', 'encodeVerificationPayload', 'verifyScannedPayload',
  ]) {
    assert.ok(src.includes(call), `verify-island.js drives the legacy engine call ${call}`)
  }
  // The derivation math lives ONLY in lib/crypto — no SHA loops here.
  assert.equal(/subtle\.digest|createHash|sha[-_ ]?512/i.test(src), false,
    'the adapter must not re-implement the derivation')
})

test('ADR-008 §12: the verify slice touches no signing surface', () => {
  for (const f of ['verify-island.js', 'chat-island-crypto.js']) {
    const src = read('views', f)
    for (const forbidden of ['signing-identity', 'signing-key-store', 'signing-key-publication',
      'x3dh', 'ratchet', 'generateKey', 'prekey']) {
      assert.equal(src.toLowerCase().includes(forbidden), false, `${f} must not touch ${forbidden}`)
    }
  }
})

test('crypto values cross the port as display strings — the package side stays crypto-free', () => {
  // The React package files for this slice import nothing from lib/crypto
  // (the packages/ui fence also enforces this structurally).
  const PKG = join(HERE, '..', '..', '..', 'packages', 'ui', 'verify')
  for (const f of readdirSync(PKG).filter((x) => /\.(ts|tsx)$/.test(x))) {
    const src = readFileSync(join(PKG, f), 'utf8')
    assert.equal(src.includes('crypto'.concat('/')), false, `packages/ui/verify/${f} must not import crypto modules`)
    assert.equal(/dangerouslySetInnerHTML/.test(src), false, `packages/ui/verify/${f} must not inject markup`)
  }
})
