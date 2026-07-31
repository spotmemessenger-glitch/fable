/**
 * Proves a TEXT message that never left the device stops claiming it was sent.
 *
 * THE BUG THIS PINS, and it is a wiring bug, not a logic one. `msgSafe` was
 * given a reporting hook so an outbound failure would "leave a trace" — it
 * logs, then calls `handlers.onSendError`. Nothing ever supplied that handler.
 * `onSendError` appeared exactly once in the whole source tree: at the place
 * that calls it. Every text send that threw ran the optional-call, hit
 * `undefined`, and changed nothing on screen.
 *
 * What the user saw instead was a tick. `buildReadRow` renders
 * `read ? 'Read' : 'Sent'`, which is a DEFAULT and not a receipt, and only
 * `sendAttachment` ever patched `failed` — so a photo that went nowhere said
 * "Not delivered" while a text that went nowhere said "Sent". Two people
 * watched messages leave one phone and never arrive at the other, with both
 * ends showing ticks, and had no way to tell a delivery failure from an empty
 * conversation.
 *
 * It matters most in exactly the case ADR-001 created, as net.js's own comment
 * says: an e2e_v2 room has NO password fallback, so a room whose key cannot be
 * agreed REFUSES to encrypt. That is correct behaviour — and it was being
 * reported to the user as a tick followed by silence.
 *
 * WHAT IS DRIVEN HERE. Only the transport is faked. `rooms.js`, `net.js`,
 * `store.js` and the real handler wiring all run, because the defect was
 * precisely that a signal was emitted and nobody was listening — a test that
 * called `onSendError` directly would have passed against the broken tree.
 *
 *   node --experimental-test-module-mocks --no-warnings test/send-failure-visible.test.js
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=sendfail' }
globalThis.window = { location: globalThis.location, addEventListener () {} }
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }
const mem = new Map()
globalThis.localStorage = {
  get length () { return mem.size },
  key: (i) => Array.from(mem.keys())[i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary')
globalThis.btoa = (bin) => Buffer.from(bin, 'binary').toString('base64')

/* ------------------------------------------------------- fake transport */
const actions = {}
function makeAction (name) {
  const action = {
    sends: [],
    failNext: false,
    send: (payload, opts) => {
      if (action.failNext) return Promise.reject(new Error('channel died'))
      action.sends.push({ payload, metadata: opts?.metadata ?? null })
      opts?.onProgress?.(1)
      return Promise.resolve()
    },
    onMessage: null,
    onReceiveProgress: null,
    request: () => Promise.resolve(null)
  }
  actions[name] = action
  return action
}

const fakeRoom = {
  makeAction,
  getPeers: () => ({}),
  addStream: () => {}, removeStream: () => {}, replaceTrack: () => {},
  onPeerJoin: null, onPeerLeave: null, onPeerStream: null, onUndecryptable: null,
  leave: () => {}
}

mock.module(`${SRC}lib/socket-transport.js`, {
  // A partial module mock is a HARD failure under ESM — a missing name is a
  // link-time SyntaxError — so this must track what the importers actually use.
  namedExports: {
    joinRoom: () => fakeRoom,
    selfId: 'self-id',
    serverMode: false,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    clearRoomCursor: () => {},
    /* Not exported by socket-transport.js on THIS branch — PR #2 adds them, and
     * `media-transfer.js` then reaches them through the module graph. A partial
     * ESM mock fails at LINK time with a SyntaxError, not at call time, so the
     * moment both branches meet this file stops loading and takes the whole
     * suite with it. Stubbed ahead of that merge because an EXTRA name is
     * harmless (verified: 10/10 with these present and unexported) while a
     * missing one is fatal. Neither PR can discover this alone. */
    sealForRoom: async (_roomId, bytes) => bytes,
    openForRoom: async (_roomId, bytes) => bytes,
    refreshRoomKey: async () => null,
    freshTokens: async () => ({ accessToken: 'test-token' })
  }
})
mock.module(`${SRC}lib/notify.js`, {
  namedExports: {
    pushNote: () => {}, alertMessage: () => {}, chime: () => {}, primeAudio: () => {}
  }
})

const { rooms } = await import(`${SRC}lib/rooms.js`)
const { db } = await import(`${SRC}lib/db.js`)

/* ------------------------------------------------------------- harness */
const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 30; i++) await tick() }

const ROOM = 'dm-sendfail'
db.setProfile({ id: 'me-sendfail', name: 'Me', lang: 'en' })
db.upsertConvo({
  roomId: ROOM, secret: 'secret-sendfail', kind: 'dm',
  e2eVersion: 'e2e_v2', peer: { id: 'peer-sendfail', name: 'Peer' }
})

const conn = rooms.ensure(ROOM)
await settle()

const stored = (id) => conn.store.list().find((m) => m.id === id)

/* ================================================================ checks */

const ok = rooms.sendMessage(ROOM, { text: 'this one goes out fine' })
await settle()

check('a send that SUCCEEDS is not marked failed', stored(ok.id)?.failed !== true)
check('…and it really did reach the transport', actions.msg?.sends?.length === 1)

/* THE BUG. The room refuses to encrypt — an e2e_v2 room with no agreeable key
 * is the real-world shape of this — and the send rejects. */
actions.msg.failNext = true
const dead = rooms.sendMessage(ROOM, { text: 'this one never leaves' })
await settle()

check('THE BUG: a text send that THREW is marked failed, not left reading "Sent"',
  stored(dead.id)?.failed === true)
check('…and is marked undelivered, so a reload cannot resurrect the tick',
  stored(dead.id)?.delivered === false)
check('…while the message that succeeded is untouched',
  stored(ok.id)?.failed !== true)

/* The false positive that would make this noise. Typing indicators, read
 * receipts and presence fail constantly on a flaky link and mean nothing to a
 * user; marking a bubble undelivered because a typing ping died would be
 * misinformation dressed as diagnostics. */
actions.msg.failNext = false
const survivor = rooms.sendMessage(ROOM, { text: 'still fine' })
await settle()
actions.typing.failNext = true
rooms.typing(ROOM, true)
actions.read.failNext = true
rooms.markRead(ROOM)
await settle()

check('a TYPING failure marks no message undelivered', stored(survivor.id)?.failed !== true)
check('a READ-RECEIPT failure marks no message undelivered', stored(dead.id) && stored(ok.id)?.failed !== true)

/* ---- the undecryptable report has to SURVIVE the trip through rooms.js ----
 *
 * `room-broken-alert.test.js` asserts that the transport RAISES this, and it
 * does — but it stops at the transport boundary, so it could not see that
 * rooms.js then emitted `{type:'undecryptable', ...info}` with `info` carrying
 * the FRAME's type. Spread-last won, the event went out as `{type:'msg'}`, the
 * `case 'undecryptable'` in chat.js never matched, and the whole banner was
 * dead code. Two green tests, one broken feature, because nothing checked the
 * seam between them. This is that check. */
const events = []
conn.on((e) => events.push(e))
fakeRoom.onUndecryptable?.({ roomId: ROOM, type: 'msg', from: 'peer-sendfail', isReplay: false, reason: 'wrong-key' })
await settle()

const alert = events.find((e) => e.type === 'undecryptable')
check('THE SEAM: the event reaches a listener as type "undecryptable", not the frame type',
  Boolean(alert))
check('…carrying the reason, so the view can tell a wrong key from no key at all',
  alert?.reason === 'wrong-key')
check('…and the frame type is not mistaken for an event type',
  !events.some((e) => e.type === 'msg' && e.reason === 'wrong-key'))

/* -------------------------------------------------------------- report */
console.log('\n========================================')
console.log('  send failure — a text that went nowhere says so')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
