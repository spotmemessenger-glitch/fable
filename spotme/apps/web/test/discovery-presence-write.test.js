/**
 * A2 — the server presence write finally happens, and honestly.
 *
 * Before this, `discoveryApi.setVisibility` had ZERO callers: the visibility
 * PUT — which is also the presence write — never fired, so the server-side
 * presence table stayed empty for every account and any server-backed nearby
 * lookup found nobody. This pins the wiring:
 *
 *   1. the app calls setVisibility WITH THE CURRENT position, rounded to
 *      3 decimals BEFORE leaving the device (the policy refuses 4+ decimals
 *      as a precise fix — the refusal is the privacy feature);
 *   2. the write repeats INSIDE the row's TTL (10-minute rewrite against the
 *      30-minute default), so presence cannot silently expire while the app
 *      is open;
 *   3. ghost (showOnMap=false) writes enabled:false — the removal — and a
 *      flip writes immediately rather than waiting out the interval;
 *   4. a presence failure never breaks the lobby.
 */

import { test, mock } from 'node:test'
import assert from 'node:assert/strict'

// Precise on purpose: 5 decimals must NOT survive to the wire.
const FIX = { coords: { latitude: 12.97161, longitude: 77.59457 } }

globalThis.window = { addEventListener () {}, __lobby: null }
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }
Object.defineProperty(globalThis, 'navigator', { value: {
  geolocation: {
    getCurrentPosition (ok) { ok(FIX) },
    watchPosition () { return 1 },
    clearWatch () {}
  }
}, configurable: true })

const SRC = new URL('../src/', import.meta.url).href

const settings = { showOnMap: true, lastSeen: 'everyone' }
mock.module(`${SRC}lib/db.js`, {
  namedExports: {
    db: {
      ready: () => true,
      profile: () => ({ id: 'presence-test-id', name: 'P', username: null, avatar: null, lang: 'en' }),
      settings: () => settings,
      isBlocked: () => false,
      convos: () => []
    }
  }
})
mock.module(`${SRC}net.js`, { namedExports: { RTC_CONFIG: {}, readyRTC: async () => {} } })
mock.module(`${SRC}lib/notify.js`, { namedExports: { pushNote: () => {} } })
mock.module(`${SRC}lib/transport/room.js`, {
  namedExports: {
    joinRoom: () => ({
      makeAction: () => ({ send: () => Promise.resolve() }),
      leave () {}
    })
  }
})

/** Capture every visibility PUT; `failNext` makes one call reject. */
const puts = []
let failNext = false
mock.module(`${SRC}lib/discovery-api.js`, {
  namedExports: {
    discoveryApi: {
      setVisibility (pref) {
        puts.push(pref)
        if (failNext) { failNext = false; return Promise.reject(new Error('presence down')) }
        return Promise.resolve({ state: 'ok' })
      }
    }
  }
})

const { lobby } = await import(`${SRC}lib/discovery.js`)

lobby.start()
await new Promise((resolve) => setImmediate(resolve))

test('the app now calls setVisibility, with the CURRENT cell, coarsened to 3 decimals', () => {
  assert.ok(puts.length >= 1, 'the visibility PUT fired at least once')
  const p = puts[0]
  assert.equal(p.enabled, true)
  assert.equal(p.origin.lat, 12.972)   // round3(12.97161) — never the 5-decimal fix
  assert.equal(p.origin.lon, 77.595)   // round3(77.59457)
  assert.notEqual(p.origin.lat, FIX.coords.latitude)
})

test('heartbeats inside the rewrite window do NOT re-PUT (presence is not chatty)', () => {
  const before = puts.length
  lobby.refreshPosition()
  assert.equal(puts.length, before)
})

test('flipping ghost writes enabled:false IMMEDIATELY — the removal, not a wait', async () => {
  const before = puts.length
  settings.showOnMap = false
  lobby.announce()                 // exactly what the ghost button calls
  await new Promise((r) => setImmediate(r))
  assert.equal(puts.length, before + 1)
  assert.deepEqual(puts[puts.length - 1], { enabled: false })
})

test('coming back from ghost re-enables with a fresh coarse origin', async () => {
  settings.showOnMap = true
  lobby.announce()
  await new Promise((r) => setImmediate(r))
  const p = puts[puts.length - 1]
  assert.equal(p.enabled, true)
  assert.equal(p.origin.lat, 12.972)
})

test('a failing presence PUT never breaks the lobby', async () => {
  failNext = true
  settings.showOnMap = false       // force a write; it will reject
  lobby.announce()
  await new Promise((r) => setImmediate(r))
  // Still alive: another flip still announces and still tries to write.
  settings.showOnMap = true
  lobby.announce()
  await new Promise((r) => setImmediate(r))
  assert.equal(puts[puts.length - 1].enabled, true)
})

// The heartbeat interval keeps node alive; release it once the tests queue up.
test('teardown', () => { lobby.stop() })
