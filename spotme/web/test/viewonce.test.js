/**
 * "Private photo" — what the feature has to be true about.
 *
 * The audit found it was a UI animation rather than a deletion. Four separate
 * facts, each enough on its own to defeat it:
 *
 *   1. the full-resolution photo was in the recipient's DOM and localStorage
 *      BEFORE they opened it, hidden by a CSS blur — one devtools line
 *      recovered it, silently, with the sender still shown "not opened";
 *   2. opening wrote nothing durable, so killing the app mid-view left the
 *      photo intact and openable a second time (reproduced end to end);
 *   3. the burn signal was invisible to the server, which is the only party
 *      that can delete the stored bytes, so it kept them forever;
 *   4. a view-once VIDEO skipped the whole path and became an ordinary
 *      permanent player.
 *
 * This pins all four at the layer they live in. store.js, rooms.js and db.js
 * are the REAL modules; only the transport is faked, exactly as media.test.js
 * does it, so what is asserted here is what the app actually does.
 *
 *   node --experimental-test-module-mocks --no-warnings test/viewonce.test.js
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=votest' }
globalThis.window = { location: globalThis.location }
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
function makeAction (name, store) {
  const action = {
    sends: [],
    send: (payload, opts) => {
      action.sends.push({ payload, metadata: opts?.metadata ?? null })
      opts?.onProgress?.(1)
      return Promise.resolve()
    },
    onMessage: null,
    onReceiveProgress: null,
    onRequest: null,
    request: () => Promise.resolve(null)
  }
  store[name] = action
  return action
}

const actions = {}
let livePeers = { 'bob-transport': { connectionState: 'connected' } }

const fakeRoom = {
  makeAction: (name, opts) => {
    const a = makeAction(name, actions)
    if (opts?.onRequest) a.onRequest = opts.onRequest
    return a
  },
  getPeers: () => livePeers,
  // No addStream/removeStream/replaceTrack/onPeerStream: those were the
  // peer-to-peer CALL surface and the transport no longer has them (ADR-004).
  // These suites cover attachments and view-once, which are unaffected.
  onPeerJoin: null, onPeerLeave: null,
  leave: () => {}
}

mock.module(`${SRC}lib/socket-transport.js`, {
  // Must track reach.js's imports exactly: a partial ESM module mock fails at
  // link time with a SyntaxError, not at call time. setRoomKey/freshTokens
  // arrived with e2e_v2 key agreement (ADR-001).
  namedExports: {
    joinRoom: () => fakeRoom,
    selfId: 'self-id',
    serverMode: false,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    clearRoomCursor: () => {},
    /* Phase 5: media-transfer.js imports these, and a PARTIAL ESM module mock
     * fails at LINK time with a SyntaxError, not at call time — so every export
     * the module graph reaches has to be present even when unused here. */
    sealForRoom: async (_room, bytes) => bytes,
    openForRoom: async (_room, bytes) => bytes,
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
const check = (name, value) => { results[name] = value === true }
const tick = () => new Promise((r) => setTimeout(r, 0))
/**
 * Drain the microtask/timer queue AND force the store's pending disk write.
 *
 * THE RACE THIS FIXES, which is the whole of the long-standing 17/21 on Linux.
 * `store.js` debounces its localStorage write by SAVE_DEBOUNCE_MS (250ms), and
 * `tick()` is setTimeout(0) — clamped to ~1ms — so thirty of them span roughly
 * 30ms. Every assertion below that reads `onDisk()` was therefore reading the
 * store BEFORE the write landed, and reported a leak that had not happened.
 *
 * It was environment-dependent rather than random: on a slower or more loaded
 * machine thirty macrotasks can exceed 250ms and the same test passes. That is
 * why it looked like a Linux-only product bug for four commits.
 *
 * `flush()` is the store's own public method — the same one `pagehide` and
 * `beforeunload` call — and it writes synchronously, so this is deterministic
 * rather than a longer sleep racing the same timer.
 */
const settle = async () => {
  for (let i = 0; i < 30; i++) await tick()
  try { rooms.ensure(ROOM).store.flush() } catch { /* room not created yet */ }
  for (let i = 0; i < 5; i++) await tick()
}

const ROOM = 'vo-room'
const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(4000, 9).toString('base64')}`
const MASK = `data:image/jpeg;base64,${Buffer.alloc(48, 3).toString('base64')}`

/** Whatever is actually on this device's disk for the room. */
const onDisk = () => {
  const raw = localStorage.getItem(`spotme:room:votest:${ROOM}`)
  return raw ? JSON.parse(raw) : { messages: [], tombstones: [] }
}
const diskMessage = (id) => onDisk().messages.find((m) => m.id === id) || null

/** Deliver an attachment from the peer, as the transport would. */
function receiveAttachment (envelope, dataURL) {
  const bytes = Buffer.from(dataURL.slice(dataURL.indexOf(',') + 1), 'base64')
  actions.bin.onMessage(new Uint8Array(bytes), {
    peerId: 'bob-transport',
    metadata: { ...envelope, mime: 'image/jpeg', seq: 0, total: 1 }
  })
}

async function main () {
  db.setProfile({ name: 'Alice', lang: 'en' })
  db.upsertConvo({
    roomId: ROOM, secret: 'secret', kind: 'dm', mode: 'nearby',
    peer: { id: 'bob-id', name: 'Bob', lang: 'en', avatar: null }
  })
  const conn = rooms.ensure(ROOM)
  await tick()

  /* ------------------------------------------------------------------ 1 */
  /* THE PRE-OPEN LEAK. A private photo arrives. Its bytes may live in memory
   * for the one view, but nothing that survives the tab may hold them. */
  receiveAttachment(
    { id: 'vo1', from: 'bob-id', ts: Date.now(), kind: 'image', viewOnce: true, burst: 10, mask: MASK },
    PHOTO
  )
  await settle()
  const inMemory = conn.store.list().find((m) => m.id === 'vo1')
  check('an unopened private photo is readable in memory for its one view',
    typeof inMemory?.data === 'string' && inMemory.data.length > 1000)
  check('THE LEAK: its bytes are NOT written to localStorage',
    diskMessage('vo1') !== null && diskMessage('vo1').data === null)
  check('the whole persisted room contains no copy of the photo',
    !JSON.stringify(onDisk()).includes(PHOTO.slice(30, 120)))
  check('the mask travels instead, and is a fraction of the size',
    inMemory.mask === MASK && MASK.length * 20 < PHOTO.length)
  check('an ordinary photo is still persisted in full', (() => {
    receiveAttachment({ id: 'plain1', from: 'bob-id', ts: Date.now(), kind: 'image' }, PHOTO)
    return true
  })())
  await settle()
  check('…proving the exemption is view-once and not "no photo is saved"',
    diskMessage('plain1')?.data === PHOTO)

  /* ------------------------------------------------------------------ 2 */
  /* THE OPEN. Everything durable happens here, before a pixel is drawn —
   * not when the countdown ends 10 to 60 seconds later. */
  actions.seen.sends.length = 0
  rooms.viewOnceOpen(ROOM, 'vo1', 10)
  await settle()

  const openFrame = actions.seen.sends.at(-1)
  check('opening tells the sender their countdown has started',
    openFrame?.payload?.opening === true && openFrame.payload.secs === 10)
  check('opening asks the SERVER to delete the bytes, in cleartext routing meta',
    openFrame?.metadata?.burn === 'vo1' && openFrame.metadata.id === 'vo1')
  check('THE APP-KILL BYPASS: the photo is gone from the store at open',
    conn.store.list().every((m) => m.id !== 'vo1'))
  check('…and gone from the disk, so a relaunch cannot show it again',
    diskMessage('vo1') === null)
  check('…tombstoned, so it cannot be resurrected by a re-send',
    onDisk().tombstones.includes('vo1'))

  /* A history backlog from the sender is exactly how it came back before. */
  conn.store.mergeHistory([
    { id: 'vo1', from: 'bob-id', ts: Date.now(), kind: 'image', text: '', viewOnce: true, data: PHOTO }
  ])
  check('a peer replaying its backlog cannot bring it back',
    conn.store.list().every((m) => m.id !== 'vo1'))

  /* ------------------------------------------------------------------ 3 */
  /* Serving bytes to a peer. The gate used to open only once the countdown
   * ENDED, so for the whole viewing window a second request was answered. */
  receiveAttachment(
    { id: 'vo2', from: 'bob-id', ts: Date.now(), kind: 'image', viewOnce: true, burst: 60 },
    PHOTO
  )
  await settle()
  const fetchAction = actions.fetch
  check('bytes we hold are served for an ordinary attachment',
    fetchAction.onRequest({ id: 'plain1' }) !== null)
  check('bytes are served for a private photo nobody has opened yet',
    fetchAction.onRequest({ id: 'vo2' }) !== null)

  conn.openingByPeer.set('vo2', { secs: 60, at: Date.now() })
  check('THE VIEWING WINDOW: once it is being opened, no peer is served it',
    fetchAction.onRequest({ id: 'vo2' }) === null)

  /* ------------------------------------------------------------------ 4 */
  /* A peer-supplied countdown is a claim about the other person's screen.
   * Unbounded, secs=86400 pinned the sender's bubble in "Viewing now" for a
   * day; the wheel's longest burst is three minutes. */
  const seenHandler = actions.seen.onMessage
  seenHandler({ id: 'vo3', opening: true, secs: 86400 }, { peerId: 'bob-transport' })
  check('an absurd countdown from a peer is clamped to what the app can mean',
    conn.openingByPeer.get('vo3')?.secs === 180)
  seenHandler({ id: 'vo4', opening: true, secs: 0 }, { peerId: 'bob-transport' })
  check('…and a zero or missing one still counts down', conn.openingByPeer.get('vo4')?.secs === 10)

  /* ------------------------------------------------------------------ 5 */
  /* View-once VIDEO. The renderer gated on kind === 'image' twice, so a
   * private clip became a permanent replayable player in the thread and in
   * the media gallery. Nothing below the store may care what kind it is. */
  receiveAttachment(
    { id: 'vid1', from: 'bob-id', ts: Date.now(), kind: 'video', viewOnce: true, burst: 10 },
    PHOTO
  )
  await settle()
  check('a private VIDEO keeps its bytes off the disk too',
    diskMessage('vid1') !== null && diskMessage('vid1').data === null)
  actions.seen.sends.length = 0
  rooms.viewOnceOpen(ROOM, 'vid1', 10)
  await settle()
  check('a private VIDEO burns on open like a photo',
    conn.store.list().every((m) => m.id !== 'vid1') &&
    actions.seen.sends.at(-1)?.metadata?.burn === 'vid1')

  /* ------------------------------------------------------------------ 6 */
  /* The countdown finishing repeats the burn rather than replacing it: if
   * the `opening` frame was lost, this is the second chance to delete. */
  actions.seen.sends.length = 0
  rooms.viewOnceOpened(ROOM, 'vo2')
  await settle()
  check('the end of the countdown asks the server to delete it again',
    actions.seen.sends.at(-1)?.metadata?.burn === 'vo2')
  check('…and that frame is the plain "it is over" signal, not another opening',
    actions.seen.sends.at(-1)?.payload?.opening === undefined)
}

await main()

/* ------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  view-once — deletion, not animation')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
