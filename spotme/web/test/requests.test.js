/**
 * Direct reach — the delivery guarantee.
 *
 * Replaces the old broadcast-lobby request test (2026-07-26 redesign: the
 * shared global lobby is gone; reach.js addresses a request straight to the
 * recipient's own inbox room instead). The property that mattered before
 * still matters exactly as much now:
 *
 *   a request stays owed until the recipient's device acknowledges it.
 *
 * Every test below asserts some face of that, now against reach.js. If one
 * fails, fire-and-forget delivery has crept back in and friend requests are
 * being lost again — silently, which is what made the original bug so
 * expensive to diagnose.
 *
 * The transport is faked (no DHT, no WebRTC) so this is fast and
 * deterministic, but db.js is the REAL module — the outbox consults the
 * conversation record to decide what is still owed, and a fake db would let
 * those two drift apart without failing anything.
 *
 *   npm test        (from spotme/web)
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
/* db.js namespaces its storage key off ?id=, so the suffix picks the slot. */
globalThis.window = { location: { href: 'http://localhost/?id=test' } }
const mem = new Map()
globalThis.localStorage = {
  get length () { return mem.size },
  key: (i) => Array.from(mem.keys())[i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}

/* -------------------------------------------------- fake per-id inbox room */
/** One Trystero action: records every send so a test can assert delivery. */
function makeAction () {
  const sends = []
  return {
    send: (payload, opts) => { sends.push({ payload, target: opts?.target ?? null }); return Promise.resolve() },
    onMessage: null,
    sends
  }
}

/** reach.js joins a DIFFERENT room per id (its own inbox, each recipient's
 * inbox) — so the fake must return a distinct, addressable room per id. */
const roomsById = new Map()
let livePeersByRoomId = {}   // roomId -> {peerId: true} — empty = unmeshed

function fakeRoomFor (roomId) {
  if (!roomsById.has(roomId)) {
    const actions = {}
    roomsById.set(roomId, {
      id: roomId,
      actions,
      left: false,
      makeAction: (name) => (actions[name] = makeAction()),
      getPeers: () => livePeersByRoomId[roomId] || {},
      onPeerJoin: null,
      onPeerLeave: null,
      leave () { this.left = true }
    })
  }
  return roomsById.get(roomId)
}

mock.module('@trystero-p2p/torrent', {
  namedExports: { joinRoom: (_opts, roomId) => fakeRoomFor(roomId) }
})
/* Relay credentials resolve instantly; reach.js waits on this before joining. */
mock.module(`${SRC}net.js`, {
  namedExports: { RTC_CONFIG: {}, readyRTC: () => Promise.resolve() }
})
mock.module(`${SRC}lib/rooms.js`, {
  namedExports: { rooms: { leave: () => {}, ensure: () => {} } }
})
mock.module(`${SRC}lib/notify.js`, {
  namedExports: { pushNote: () => {} }
})

const { reach } = await import(`${SRC}lib/reach.js`)
const { db } = await import(`${SRC}lib/db.js`)

/* ------------------------------------------------------------- harness */
const results = {}
const check = (name, value) => { results[name] = value === true }
const tick = () => new Promise((r) => setTimeout(r, 0))

const BOB = { id: 'bob-id', name: 'Bob', username: 'bob', avatar: null, lang: 'en' }

let myInboxId = null   // remembered once joinInbox() runs, so bobInbox() can exclude it

/** The room reach() is currently using to reach BOB (any room besides ours
 * that already has a knock action registered). */
const bobInbox = () => [...roomsById.values()].find((r) => r.id !== myInboxId && r.actions.knock)

async function peerJoinsBobInbox (peerId) {
  const room = bobInbox()
  room.onPeerJoin(peerId)
  await tick()
}

async function main () {
  db.setProfile({ name: 'Alice', lang: 'en' })
  reach.joinInbox()
  await tick()
  myInboxId = [...roomsById.keys()][0]

  /* ------------------------------------------------------------------ 1 */
  /* An unmeshed inbox is the exact condition the old bug mistook for
   * success. The request must be RECORDED but not considered delivered. */
  const roomId = reach.reach(BOB, 'hey')
  await tick()

  const convo = db.convo(roomId)
  check('reach records a pending conversation', convo?.pending === true)
  check('reach is not marked delivered into an unmeshed inbox', !convo?.delivered)
  const knockRoom = bobInbox()
  check('nothing is sent into an unmeshed inbox', knockRoom.actions.knock.sends.length === 0)

  /* ------------------------------------------------------------------ 2 */
  /* Bob's inbox finally meshes. THIS is the moment the old bug never had. */
  await peerJoinsBobInbox('bob-transport-1')
  check('the knock is delivered when Bob\'s inbox meshes',
    knockRoom.actions.knock.sends.length === 1)
  check('delivery is targeted at the joining peer',
    knockRoom.actions.knock.sends[0]?.target === 'bob-transport-1')
  check('the delivered payload addresses the derived room',
    knockRoom.actions.knock.sends[0]?.payload?.roomId === roomId)

  /* ------------------------------------------------------------------ 3 */
  /* Still no ack: the request is still owed, so a second join re-knocks.
   * A send that merely "resolved" must never be mistaken for receipt. */
  await peerJoinsBobInbox('bob-transport-2')
  check('an unacknowledged knock is re-sent on the next join',
    knockRoom.actions.knock.sends.length === 2)
  check('conversation stays undelivered until acknowledged',
    db.convo(roomId)?.delivered !== true)

  /* ------------------------------------------------------------------ 4 */
  /* Bob's device acknowledges. Only now is the debt settled. */
  knockRoom.actions.knockAck.onMessage({ fromId: BOB.id })
  await tick()
  check('ack marks the conversation delivered', db.convo(roomId)?.delivered === true)
  check('the outbox room is left once acknowledged', knockRoom.left === true)

  /* ------------------------------------------------------------------ 5 */
  /* Closing the app must not abandon a request that never got through:
   * pending + undelivered conversations reopen their outbox on next boot. */
  const stale = 'stale-room-id'
  db.upsertConvo({
    roomId: stale,
    secret: 'secret',
    kind: 'dm',
    mode: 'nearby',
    peer: { id: 'carol-id', name: 'Carol', avatar: null, lang: 'en' },
    title: 'Carol',
    pending: true,
    delivered: false,
    last: { text: 'still owed', ts: Date.now(), fromMe: true }
  })

  reach.stop()          // app closes
  roomsById.clear()      // a real restart would drop all live room objects
  reach.joinInbox()     // app reopens — rehydration runs here
  await tick()
  myInboxId = [...roomsById.keys()][0]
  const carolRoomId = [...roomsById.keys()].find((id) => id !== myInboxId)
  const carolInbox = roomsById.get(carolRoomId)
  carolInbox.onPeerJoin('carol-transport-1')
  await tick()
  check('an undelivered request survives an app restart',
    carolInbox.actions.knock.sends.some((s) => s.payload?.roomId === stale))

  /* ------------------------------------------------------------------ 6 */
  /* The sender re-knocks until it hears back, so a DUPLICATE arriving at a
   * room we already hold must still be acked — swallowing it silently would
   * make the sender shout forever. */
  const myInboxRoom = roomsById.get(myInboxId)
  const ackCountBefore = myInboxRoom.actions.knockAck.sends.length
  myInboxRoom.actions.knock.onMessage({
    from: { id: BOB.id, name: 'Bob' },
    roomId,                       // a room we already hold (from step 4)
    secret: 'secret',
    text: 'duplicate'
  }, { peerId: 'bob-transport-9' })
  await tick()
  check('a duplicate knock is still acknowledged',
    myInboxRoom.actions.knockAck.sends.length === ackCountBefore + 1)

  /* THE REGRESSION THIS PINS. The ack must self-identify as the ACKER (us,
   * Alice), never echo the original sender's id back — a real bug that
   * shipped once already: the sender's `ack.fromId !== peer.id` check could
   * then never match, so "delivered" would never fire no matter how many
   * times the knock actually landed. This exercises the REAL send path
   * (knock.onMessage → receipt()), not a hand-crafted payload standing in
   * for it, which is exactly what let the bug through the first time. */
  const lastAck = myInboxRoom.actions.knockAck.sends.at(-1)
  check('the ack self-identifies as the acker, not the original sender',
    lastAck?.payload?.fromId === db.profile().id)

  /* ------------------------------------------------------------------ 7 */
  /* Accept must never be needed for the sender's own pending → delivered
   * transition (that is rooms.js's job once the peer actually joins), but it
   * must still turn an incoming request into a real, non-pending contact. */
  const DAVE_REQUEST = {
    fromId: 'dave-id', name: 'Dave', avatar: null, lang: 'en',
    text: 'hi', roomId: 'dave-room', secret: 'dave-secret', mode: 'meet'
  }
  reach.accept(DAVE_REQUEST)
  check('accepting creates a non-pending conversation',
    db.convo('dave-room')?.pending === false)
  check('accepting adds the sender as a contact',
    db.contacts().some((c) => c.id === 'dave-id'))

  /* -------------------------------------------------------------- report */
  console.log('========================================')
  console.log('  direct reach — delivery')
  console.log('========================================')
  let ok = true
  for (const [name, passed] of Object.entries(results)) {
    console.log(`  ${passed ? 'PASS' : 'FAIL'}  ${name}`)
    if (!passed) ok = false
  }
  const passed = Object.values(results).filter(Boolean).length
  console.log('========================================')
  console.log(`  ${passed}/${Object.keys(results).length} passed`)
  console.log('========================================')

  reach.stop()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
