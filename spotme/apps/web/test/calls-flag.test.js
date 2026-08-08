/**
 * The call switch, pinned. ADR-004.
 *
 * DEFAULT OFF, and off now means calls are UNAVAILABLE — the peer-to-peer path
 * this used to fall back to has been deleted. So the stakes of this one boolean
 * changed: a wrong `true` no longer merely picks a different media path, it
 * offers a feature the deployment may not be able to serve.
 *
 * The value is read from localStorage, which means it can be anything a user or
 * a stale build put there. Only the exact string enables calls; everything else,
 * including a localStorage that throws, must read as off.
 *
 * WHAT WAS REMOVED FROM THIS FILE, and why: it used to also pin
 * `agreeCallMedia()`, the rule that both devices had to agree before media went
 * to the SFU. That rule existed because one side could be on peer-to-peer while
 * the other was on LiveKit. With only one media path left there is nothing to
 * disagree about, the function is gone, and a test asserting its behaviour would
 * be testing code that no longer exists.
 *
 * Node's test runner, no framework, matching the rest of web/test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Minimal localStorage over an explicit key/value map. */
function withStorage (value, group = null) {
  const map = { 'spotme.calls': value, 'spotme.calls.group': group }
  globalThis.localStorage = { getItem (k) { return map[k] ?? null } }
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

test('group is a SEPARATE flag — enabling 1:1 must not enable group', async () => {
  withStorage('livekit')                       // 1:1 on, group flag absent
  const { livekitCalls, groupCalls } = await load()

  assert.equal(livekitCalls(), true)
  assert.equal(groupCalls(), false, 'turning on 1:1 must not turn on group')
})

test('group needs BOTH flags — its own is not enough on its own', async () => {
  // Asking for group on a device where no call may be placed at all is not a
  // half-enabled state, it is a contradiction. Group extends calls.
  withStorage(null, 'on')
  const a = await load()
  assert.equal(a.groupCalls(), false)

  withStorage('livekit', 'on')
  const b = await load()
  assert.equal(b.groupCalls(), true)
})

test('only the exact string "on" enables group', async () => {
  for (const value of ['', 'true', '1', 'yes', 'ON', 'livekit', 'on ']) {
    withStorage('livekit', value)
    const { groupCalls } = await load()
    assert.equal(groupCalls(), false, `group="${value}" must not enable group`)
  }
})

test('a throwing localStorage leaves BOTH flags off', async () => {
  globalThis.localStorage = { getItem () { throw new Error('private browsing') } }
  const { livekitCalls, groupCalls } = await load()
  assert.equal(livekitCalls(), false)
  assert.equal(groupCalls(), false)
})
