/**
 * Attachments — the delivery guarantee, and what a big photo does to a chat.
 *
 * This pins the bug where sending one photo killed a conversation: the header
 * fell back to "Last seen", later text messages stuck at "Sent", and a photo
 * arriving the other way sat on "Photo — tap to load".
 *
 * The cause was that an attachment was handed to the transport as ONE buffer.
 * The transport writes it as ~16KB chunks, pausing when the data channel's
 * buffer fills and abandoning that pause after ten seconds — by breaking out of
 * its loop and resolving the send as if it had finished. So:
 *
 *   - the sender saw success for a transfer that stopped halfway;
 *   - the receiver held chunks that never got their terminator, so nothing
 *     appeared and nothing was ever retried;
 *   - and because every room with a peer shares ONE data channel, everything
 *     else — text, receipts, presence — queued behind the photo.
 *
 * The properties that matter are therefore:
 *
 *   1. an attachment goes out in bounded slices, never one giant write;
 *   2. "delivered" means the receiver REASSEMBLED it, not that bytes were queued;
 *   3. a transfer that stops early is reported as failed, never as sent;
 *   4. bytes arriving for an already-known envelope fill it in rather than
 *      being discarded as a duplicate.
 *
 * The transport is faked (no DHT, no WebRTC) so this is fast and deterministic,
 * but db.js and store.js are the REAL modules — the delivery state lives there.
 *
 *   node --experimental-test-module-mocks --no-warnings test/media.test.js
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=mediatest' }
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
      if (action.failNext) return Promise.reject(new Error('channel died'))
      action.sends.push({ payload, metadata: opts?.metadata ?? null })
      // Report full progress for this slice, as the real transport does once
      // its bytes are queued. Crucially this is NOT receipt.
      opts?.onProgress?.(1)
      return Promise.resolve()
    },
    onMessage: null,
    onReceiveProgress: null,
    request: () => Promise.resolve(null),
    failNext: false
  }
  store[name] = action
  return action
}

const actions = {}
let livePeers = {}

const fakeRoom = {
  makeAction: (name) => makeAction(name, actions),
  getPeers: () => livePeers,
  addStream: () => {}, removeStream: () => {}, replaceTrack: () => {},
  onPeerJoin: null, onPeerLeave: null, onPeerStream: null,
  leave: () => {}
}

/* net.js now rides the server-backed transport module; the fake below is
 * transport-agnostic (room + actions), so only the mocked path changes. */
mock.module(`${SRC}lib/socket-transport.js`, {
  // setRoomKey/freshTokens are stubbed because reach.js imports them for
  // e2e_v2 agreement (ADR-001). A partial module mock is a HARD failure under
  // ESM — a missing name is a link-time SyntaxError, not undefined at call
  // time — so this list has to track reach.js's imports exactly.
  namedExports: {
    joinRoom: () => fakeRoom,
    selfId: 'self-id',
    serverMode: false,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    freshTokens: async () => ({ accessToken: 'test-token' })
  }
})
/* Alerts are a side effect of receiving, not part of it — but they are
 * recorded so the suite can assert an incoming message actually raises one. */
const alerts = []
mock.module(`${SRC}lib/notify.js`, {
  namedExports: {
    pushNote: () => {},
    alertMessage: (a) => alerts.push(a),
    chime: () => {},
    primeAudio: () => {}
  }
})

const { rooms } = await import(`${SRC}lib/rooms.js`)
const { db } = await import(`${SRC}lib/db.js`)

/* ------------------------------------------------------------- harness */
const results = {}
const check = (name, value) => { results[name] = value === true }
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 20; i++) await tick() }

/** A data URL whose decoded payload is exactly `bytes` bytes. */
const fakePhoto = (bytes) =>
  `data:image/jpeg;base64,${Buffer.alloc(bytes, 7).toString('base64')}`

const SLICE_BYTES = 128 * 1024
const ROOM = 'media-room'

/** An RTCPeerConnection the transport would consider usable. */
const alivePeer = { connectionState: 'connected' }
const deadPeer = { connectionState: 'failed' }

const msg = (id) => rooms.get(ROOM).store.list().find((m) => m.id === id)

async function main () {
  db.setProfile({ name: 'Alice', lang: 'en' })
  db.upsertConvo({
    roomId: ROOM, secret: 'secret', kind: 'dm', mode: 'nearby',
    peer: { id: 'bob-id', name: 'Bob', lang: 'en', avatar: null }
  })
  livePeers = { 'bob-transport': alivePeer }
  rooms.ensure(ROOM)
  await tick()

  /* ------------------------------------------------------------------ 1 */
  /* A photo larger than one slice must leave as SEVERAL bounded writes.
   * One giant write is the condition the transport silently truncates. */
  const PHOTO_BYTES = SLICE_BYTES * 2 + 1000
  const progress = []
  const sent = rooms.sendAttachment(
    ROOM,
    { kind: 'image', data: fakePhoto(PHOTO_BYTES) },
    (p) => progress.push(p)
  )
  await settle()

  const slices = actions.bin.sends
  check('a large photo is sliced, not sent as one write', slices.length === 3)
  check('no single write exceeds the slice bound',
    slices.every((s) => s.payload.byteLength <= SLICE_BYTES))
  check('the slices carry the whole photo',
    slices.reduce((n, s) => n + s.payload.byteLength, 0) === PHOTO_BYTES)
  check('every slice is numbered so a short transfer is detectable',
    slices.every((s, i) => s.metadata.seq === i && s.metadata.total === 3))
  check('the envelope rides on the first slice only',
    slices[0].metadata.kind === 'image' && slices[1].metadata.kind === undefined)
  check('the envelope carries no bytes', slices[0].metadata.data === null)

  /* ------------------------------------------------------------------ 2 */
  /* THE HEART OF IT. Every slice is queued and every send resolved, exactly
   * as it did for a transfer that died halfway. Until the receiver confirms,
   * this is NOT delivered and must never show as complete. */
  check('queued bytes alone never report completion', progress.every((p) => p < 1))
  check('a queued attachment is not yet marked delivered', msg(sent.id)?.delivered !== true)

  /* ------------------------------------------------------------------ 3 */
  /* The receiver confirms reassembly. Only now is it delivered. */
  actions.binack.onMessage({ id: sent.id }, { peerId: 'bob-transport' })
  await settle()
  check('receipt completes the send', progress.at(-1) === 1)
  check('receipt marks the message delivered', msg(sent.id)?.delivered === true)

  /* ------------------------------------------------------------------ 4 */
  /* A transfer that dies mid-flight must surface as failed. Reporting it as
   * sent is what left photos stuck at "Sent" with nothing on the other end. */
  actions.bin.sends.length = 0
  actions.bin.failNext = true
  const failProgress = []
  const doomed = rooms.sendAttachment(
    ROOM,
    { kind: 'image', data: fakePhoto(1000) },
    (p) => failProgress.push(p)
  )
  await settle()
  actions.bin.failNext = false
  check('a transfer that dies is reported as failed', failProgress.at(-1) === -1)
  check('a failed transfer is not marked delivered', msg(doomed.id)?.delivered !== true)
  check('a failed transfer is marked failed', msg(doomed.id)?.failed === true)

  /* ----------------------------------------------------------------- 4b */
  /* "Not delivered" used to be terminal. A socket blip 150ms into a 37-slice
   * voice note set failed:true at 221ms, and from there the only remedy the
   * app offered was to record the whole thing again — while the bytes sat
   * untouched in the local store the entire time. Retry pushes them again. */
  actions.bin.sends.length = 0
  const retryProgress = []
  const accepted = rooms.retryAttachment(ROOM, doomed.id, (p) => retryProgress.push(p))
  check('a failed attachment can be retried', accepted === true)
  check('retrying clears the failure while it is back in flight',
    msg(doomed.id)?.failed === false)
  await settle()
  check('the retry actually puts the bytes back on the wire', actions.bin.sends.length === 1)
  check('the retried slice carries the original message id',
    actions.bin.sends[0]?.metadata?.id === doomed.id)
  check('a retry in flight is still not delivered', msg(doomed.id)?.delivered !== true)

  actions.binack.onMessage({ id: doomed.id }, { peerId: 'bob-transport' })
  await settle()
  check('a retry that lands is delivered', msg(doomed.id)?.delivered === true)
  check('a retry that lands leaves nothing marked failed', msg(doomed.id)?.failed === false)
  check('the retry reports completion to its caller', retryProgress.at(-1) === 1)
  check('there is nothing to retry for a message this device does not hold',
    rooms.retryAttachment(ROOM, 'no-such-message') === false)

  /* ------------------------------------------------------------------ 5 */
  /* Incoming: slices arriving out of order still reassemble, the sender is
   * acknowledged, and the photo lands byte-exact. */
  actions.binack.sends.length = 0
  const incomingId = 'incoming-1'
  const body = Buffer.alloc(200, 3)
  const half = 100
  actions.bin.onMessage(new Uint8Array(body.subarray(half)), {
    peerId: 'bob-transport', metadata: { id: incomingId, seq: 1, total: 2 }
  })
  await settle()
  check('a partial attachment shows nothing yet', !msg(incomingId))
  check('a partial attachment is not acknowledged', actions.binack.sends.length === 0)

  actions.bin.onMessage(new Uint8Array(body.subarray(0, half)), {
    peerId: 'bob-transport',
    metadata: {
      id: incomingId, from: 'bob-id', name: 'Bob', lang: 'en', ts: Date.now(),
      kind: 'image', text: '', data: null, mime: 'image/jpeg', seq: 0, total: 2
    }
  })
  await settle()
  check('out-of-order slices reassemble', Boolean(msg(incomingId)?.data))
  check('the reassembled photo is byte-exact',
    msg(incomingId)?.data === `data:image/jpeg;base64,${body.toString('base64')}`)
  check('the sender is acknowledged once it is whole',
    actions.binack.sends[0]?.payload?.id === incomingId)

  /* An arriving message must raise an alert — with the sender's name and the
   * conversation to open, so tapping the notification lands in the right chat.
   * A partial transfer raised none, which is the point of alerting on the
   * assembled message rather than on the first slice. */
  const alert = alerts.at(-1)
  check('a received attachment raises exactly one alert', alerts.length === 1)
  check('the alert names the sender', alert?.title === 'Bob')
  check('the alert says what arrived', alert?.body === 'Photo')
  check('the alert carries the room to open', alert?.roomId === ROOM)

  /* ------------------------------------------------------------------ 6 */
  /* The "tap to load" case. History delivers the envelope without bytes; when
   * the bytes then arrive, the known id must be FILLED IN. Treating it as a
   * duplicate is what left a fully-arrived photo stuck as "tap to load". */
  const detachedId = 'detached-1'
  actions.history.onMessage({
    messages: [{
      id: detachedId, from: 'bob-id', name: 'Bob', lang: 'en', ts: Date.now(),
      kind: 'image', text: '', data: null, detached: true, mime: 'image/jpeg'
    }]
  }, { peerId: 'bob-transport' })
  await settle()
  check('history delivers the envelope as detached', msg(detachedId)?.detached === true)

  actions.bin.onMessage(new Uint8Array(body), {
    peerId: 'bob-transport',
    metadata: {
      id: detachedId, from: 'bob-id', name: 'Bob', lang: 'en', ts: Date.now(),
      kind: 'image', text: '', data: null, mime: 'image/jpeg', seq: 0, total: 1
    }
  })
  await settle()
  check('bytes for a known envelope fill it in', Boolean(msg(detachedId)?.data))
  check('the filled-in message is no longer detached', msg(detachedId)?.detached === false)

  /* ------------------------------------------------------------------ 7 */
  /* A connection whose peers have all failed is dead, however many the
   * transport still lists. Handing that back is why a chat never recovered. */
  const before = rooms.get(ROOM)
  const storeBefore = before.store
  const messagesBefore = before.store.list().length
  let sawPeersEvent = false
  before.on((ev) => { if (ev.type === 'peers') sawPeersEvent = true })
  before.openedAt = Date.now() - 120_000
  const netBefore = before.net
  livePeers = { 'bob-transport': deadPeer }
  const rebuilt = rooms.ensure(ROOM)
  check('a connection with only failed peers rejoins', rebuilt.net !== netBefore)

  /* But the object itself must SURVIVE. An open chat takes its connection once
   * and subscribes to it; handing out a replacement leaves the visible chat
   * listening to an emitter that will never fire again. */
  check('rejoining keeps the same connection object', rebuilt === before)
  check('rejoining keeps the same store', rebuilt.store === storeBefore)
  check('rejoining keeps the message history', rebuilt.store.list().length === messagesBefore)
  check('an open chat still hears the rejoined connection', sawPeersEvent)

  livePeers = { 'bob-transport': alivePeer }
  const healthy = rooms.ensure(ROOM)
  check('a healthy connection is reused', rooms.ensure(ROOM) === healthy)

  /* ------------------------------------------------------------------ 8 */
  /* Lazy fetch must never hang. With no reachable peer it fails immediately
   * rather than leaving the button on "Loading…" forever. */
  livePeers = { 'bob-transport': deadPeer }
  let fetchError = null
  try { await rooms.fetchAttachment(ROOM, detachedId) } catch (e) { fetchError = e }
  check('fetching with no reachable peer fails rather than hanging',
    /offline/.test(fetchError?.message || ''))
}

await main()

/* ------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  attachment delivery')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
