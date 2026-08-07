/**
 * View-once through the React chat port (ADR-035 final slice, session 2).
 *
 * Pins the contract the mission requires a DEDICATED test for:
 *   1. the locked row the package receives NEVER carries the photo bytes —
 *      only the sender-made mask thumbnail (revealed state cannot leak
 *      because it never enters the snapshot);
 *   2. tap-to-reveal burns FIRST: rooms.viewOnceOpen (tombstone + burn
 *      signal with opening) commits BEFORE the reveal draws anything;
 *   3. after viewing, the tombstone matches legacy semantics via the SAME
 *      rooms.* calls (viewOnceOpen/viewOnceOpened, 'seen' action, store
 *      tombstone that a replay cannot resurrect);
 *   4. revealed state never persists — no byte of the photo lands in
 *      localStorage or in any later snapshot.
 *
 * Same harness as chat-characterization.test.js: real rooms/db over a mocked
 * transport, the port built by views/chat-island-port.js with a fake `ui`.
 *
 *   node --experimental-test-module-mocks --no-warnings test/chat-viewonce-react.test.js
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=vonce' }
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
    send: (payload, opts) => {
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
  namedExports: {
    joinRoom: () => fakeRoom,
    selfId: 'self-id',
    serverMode: false,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    clearRoomCursor: () => {},
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
const { buildChatPort } = await import(`${SRC}views/chat-island-port.js`)
const { fmtTime, fmtDay } = await import(`${SRC}lib/ui.js`)

/* ------------------------------------------------------------- harness */
const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 30; i++) await tick() }

const ROOM = 'dm-vonce'
db.setProfile({ id: 'me-vo', name: 'Me', lang: 'en' })
db.upsertConvo({
  roomId: ROOM, secret: 'secret-vonce', kind: 'dm',
  peer: { id: 'peer-vo', name: 'Peer', lang: 'ta' }
})
const conn = rooms.ensure(ROOM)
await settle()

const SECRET_BYTES = 'data:image/png;base64,SECRETPIXELS'
const MASK = 'data:image/png;base64,MASKONLY'

const toasts = []
const ctx = { nav: () => {}, toast: (m) => toasts.push(m) }
let revealedWith = null
let storeAtReveal = null
let seenAtReveal = null
const ui = {
  mapLink: (lat, lon) => `map:${lat},${lon}`,
  recordVoice: async () => { throw new Error('not in this test') },
  getLocation: async () => ({ lat: 0, lon: 0 }),
  pickPhoto: async () => null,
  pickFile: async () => null,
  copy: () => {},
  openPhoto: () => {},
  revealViewOnce: async (copy, secs) => {
    revealedWith = { copy, secs }
    // Snapshot the world AT the moment of reveal: the burn must already
    // have committed (tombstone in the store, `opening` signal on the wire).
    storeAtReveal = conn.store.list().map((m) => m.id)
    seenAtReveal = actions.seen.sends.map((s) => s.payload)
  }
}

const port = buildChatPort({ db, rooms, fmtTime, fmtDay }, ctx, ROOM, ui)

/* ======================== 1. the locked row carries no bytes =========== */

actions.msg.onMessage({
  id: 'vo-1', from: 'peer-vo', name: 'Peer', ts: Date.now(),
  kind: 'image', viewOnce: true, burst: 5, mask: MASK, data: SECRET_BYTES
}, { peerId: 'peer-vo' })
await settle()

const row = port.snapshot().rows.find((r) => r.id === 'vo-1')
check('an incoming private photo renders as the locked media tile',
  row?.kind === 'media' && row.media?.type === 'viewOnce')
check('the tile shows the sender-made mask and the burst chip',
  row?.media?.maskUrl === MASK && row.media.chip === '🔥 5s' &&
  row.media.label === 'Private photo · 5s — tap to open')
check('NO byte of the photo reaches the package — the snapshot never contains m.data',
  !JSON.stringify(port.snapshot()).includes('SECRETPIXELS'))
check('the reply/copy grammar stays the pinned preview label',
  row?.text === 'Private photo' && row.copyText === null)

/* ======================== 2. tap-to-reveal burns FIRST ================= */

port.openViewOnce('vo-1')
await settle()

check('the reveal received a function-scoped copy of the bytes and the timer',
  revealedWith?.copy?.data === SECRET_BYTES && revealedWith.secs === 5)
check('the burn committed BEFORE the reveal: tombstoned at reveal time',
  Array.isArray(storeAtReveal) && !storeAtReveal.includes('vo-1'))
check('…and the opening signal was already on the wire (legacy viewOnceOpen)',
  Array.isArray(seenAtReveal) &&
  seenAtReveal.some((p) => p.id === 'vo-1' && p.opening === true && p.burn === true && p.secs === 5))

/* ======================== 3. tombstone after viewing =================== */

check('after viewing, the open is reported (legacy viewOnceOpened: burn, no opening)',
  actions.seen.sends.some((s) => s.payload.id === 'vo-1' && s.payload.burn === true && !s.payload.opening))
check('the message stays tombstoned in the store and in the snapshot',
  !conn.store.list().some((m) => m.id === 'vo-1') &&
  !port.snapshot().rows.some((r) => r.id === 'vo-1'))
check('the viewer is told it burst', toasts.includes('Burst — the photo is gone'))
check('a replay of the same id cannot resurrect it', (() => {
  actions.msg.onMessage({
    id: 'vo-1', from: 'peer-vo', name: 'Peer', ts: Date.now(),
    kind: 'image', viewOnce: true, mask: MASK, data: SECRET_BYTES
  }, { peerId: 'peer-vo' })
  return !conn.store.list().some((m) => m.id === 'vo-1')
})())

/* ======================== 4. revealed state never persists ============= */

await settle()
const persisted = Array.from(mem.values()).join('\n')
check('no byte of the photo was ever persisted (localStorage clean of the data URL)',
  !persisted.includes('SECRETPIXELS'))
check('no later snapshot resurrects the bytes',
  !JSON.stringify(port.snapshot()).includes('SECRETPIXELS'))

/* -------------------------------------------------------------- report */
console.log('\n========================================')
console.log('  chat view-once (React port) — burn-before-reveal contract')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
