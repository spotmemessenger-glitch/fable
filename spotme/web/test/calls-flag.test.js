/**
 * The call-media switch, pinned. ADR-003.
 *
 * TWO THINGS ARE UNDER TEST, and both are failures that would ship quietly.
 *
 * 1. DEFAULT OFF. The whole mission is "dark": a device that has not opted in
 *    must place calls exactly the way it did before. A regression here is not
 *    a broken build — it is every user silently moved onto a new media path.
 *
 * 2. THE NEGOTIATION. Media only flows if both ends land in the same place. One
 *    side on the SFU and the other on a peer connection produces a call that
 *    connects, rings, shows "active", and carries nothing. There is no error to
 *    notice; the users just say "I couldn't hear you". `theirs` arrives off the
 *    wire, so `undefined` (an older client), a stale value and outright garbage
 *    all have to resolve to the path that works everywhere.
 *
 * Node's test runner, no framework, matching the rest of web/test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Minimal localStorage — the module reads one key and nothing else. */
function withStorage (value) {
  globalThis.localStorage = {
    _v: value,
    getItem (k) { return k === 'spotme.calls' ? this._v : null }
  }
}

const load = async () => {
  // Fresh module each time: the flag is read through a function precisely so a
  // stale capture cannot happen, and this proves that.
  const url = new URL('../src/lib/calls/select.js', import.meta.url).href
  return import(`${url}?t=${Math.random()}`)
}

test('the flag is OFF when nothing is set — the legacy path is the default', async () => {
  withStorage(null)
  const { livekitCalls } = await load()
  assert.equal(livekitCalls(), false)
})

test('only the exact string "livekit" turns it on', async () => {
  for (const value of ['', 'p2p', 'LiveKit', 'true', '1', 'livekit ']) {
    withStorage(value)
    const { livekitCalls } = await load()
    assert.equal(livekitCalls(), false, `"${value}" must not enable livekit`)
  }
  withStorage('livekit')
  const { livekitCalls } = await load()
  assert.equal(livekitCalls(), true)
})

test('a localStorage that throws reads as OFF, not as a crash', async () => {
  globalThis.localStorage = {
    getItem () { throw new Error('private browsing') }
  }
  const { livekitCalls } = await load()
  assert.equal(livekitCalls(), false)
})

test('livekit is agreed ONLY when both sides say so', async () => {
  const { agreeCallMedia } = await load()

  assert.equal(agreeCallMedia(true, 'livekit'), 'livekit')

  // Every asymmetric case must fall back, or the call is silently one-way.
  assert.equal(agreeCallMedia(false, 'livekit'), 'p2p')
  assert.equal(agreeCallMedia(true, 'p2p'), 'p2p')
  assert.equal(agreeCallMedia(false, 'p2p'), 'p2p')
})

test('a peer that never heard of this feature negotiates the legacy path', async () => {
  const { agreeCallMedia } = await load()

  // An older client omits the field entirely — the single most likely case
  // during a staged rollout, and the one that must not break.
  for (const theirs of [undefined, null, '', 0, false, {}, 'LIVEKIT', 'sfu']) {
    assert.equal(agreeCallMedia(true, theirs), 'p2p', `${JSON.stringify(theirs)} must mean p2p`)
  }
})
