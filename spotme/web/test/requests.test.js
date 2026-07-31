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
 * Steps 8-10 cover the later addition: api/knock.js, a server relay so a
 * knock survives the SENDER going offline, not just the recipient being
 * briefly unreachable. reach() must persist to it on send; checkRelay()
 * (wired into resume()) must pick up anything left there and clear it.
 *
 * The transport is faked (no DHT, no WebRTC, no real HTTP) so this is fast
 * and deterministic, but db.js and push.js are the REAL modules — only the
 * network boundary (fetch) is faked, backed by an in-memory store standing
 * in for api/knock.js's Redis-backed one. Faking db.js or the relay's own
 * logic would let them drift apart from what ships without failing anything.
 *
 *   npm test        (from spotme/web)
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
/* db.js namespaces its storage key off ?id=, so the suffix picks the slot. */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=test' }
globalThis.window = { location: globalThis.location }
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

/* reach.js now rides the server-backed transport module; the fake below is
 * transport-agnostic (rooms + actions), so only the mocked path changes. */
mock.module(`${SRC}lib/socket-transport.js`, {
  // Must track reach.js's imports exactly: a partial ESM module mock fails at
  // link time with a SyntaxError, not at call time. setRoomKey/freshTokens
  // arrived with e2e_v2 key agreement (ADR-001).
  namedExports: {
    joinRoom: (_opts, roomId) => fakeRoomFor(roomId),
    selfId: 'test-self',
    serverMode: false,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    clearRoomCursor: () => {},
    freshTokens: async () => ({ accessToken: 'test-token' })
  }
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

/* --------------------------------------------------- fake knock/push relay */
/* Real reach.js, real push.js (pokePeer) — only the network boundary (fetch)
 * is faked, backed by an in-memory store standing in for api/knock.js's
 * Upstash-backed one. Same reasoning as the db.js note above: faking the
 * server logic itself would let this drift from what api/knock.js actually
 * does without failing anything. */
const relayData = new Map()   // roomId -> { toId, knock }
const pushPokes = []          // toUserId values pokePeer() asked the server to notify

globalThis.fetch = async (url, opts = {}) => {
  // API calls are same-origin (relative) now — give URL a base to parse them.
  const { pathname, searchParams } = new URL(url, 'http://localhost')
  const body = opts.body ? JSON.parse(opts.body) : null

  if (pathname === '/api/knock') {
    if (!opts.method || opts.method === 'GET') {
      const userId = searchParams.get('userId')
      const knocks = [...relayData.values()].filter((e) => e.toId === userId).map((e) => e.knock)
      return { ok: true, json: async () => ({ knocks }) }
    }
    if (body?.action === 'store') {
      relayData.set(body.knock.roomId, { toId: body.toId, knock: body.knock })
      return { ok: true, json: async () => ({ ok: true }) }
    }
    if (body?.action === 'ack') {
      for (const roomId of body.roomIds) relayData.delete(roomId)
      return { ok: true, json: async () => ({ ok: true }) }
    }
  }
  if (pathname === '/api/push') {
    if (body?.action === 'notify') pushPokes.push(body.toUserId)
    return { ok: true, json: async () => ({ ok: true }) }
  }
  return { ok: true, json: async () => ({}) }
}

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
  /* No accept gate: the conversation opens on OUR side the instant reach()
   * is called, contact and all — delivery to Bob is a separate concern from
   * whether we can already see the chat. An unmeshed inbox is the exact
   * condition the old bug mistook for success, so the knock itself must not
   * be considered delivered yet even though the convo already exists. */
  const roomId = reach.reach(BOB, 'hey')
  await tick()

  const convo = db.convo(roomId)
  check('reach opens the conversation immediately, not as a pending request', convo?.kind === 'dm' && convo?.pending === undefined)
  check('reach adds the peer as a contact immediately', db.contacts().some((c) => c.id === BOB.id))
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
  /* Closing the app must not abandon a hello that never got through:
   * initiated + undelivered conversations reopen their outbox on next boot. */
  const stale = 'stale-room-id'
  db.upsertConvo({
    roomId: stale,
    secret: 'secret',
    kind: 'dm',
    mode: 'nearby',
    peer: { id: 'carol-id', name: 'Carol', avatar: null, lang: 'en' },
    title: 'Carol',
    initiated: true,
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
  /* There is no separate accept step: a first-time knock from someone new
   * must open a live conversation and file them as a contact on receipt,
   * with no action required from us. */
  myInboxRoom.actions.knock.onMessage({
    from: { id: 'dave-id', name: 'Dave' },
    roomId: 'dave-room',
    secret: 'dave-secret',
    text: 'hi',
    mode: 'meet'
  }, { peerId: 'dave-transport-1' })
  await tick()
  check('an incoming knock opens the conversation with no accept step',
    db.convo('dave-room')?.kind === 'dm')
  check('an incoming knock adds the sender as a contact',
    db.contacts().some((c) => c.id === 'dave-id'))

  /* ------------------------------------------------------------------ 8 */
  /* reach() must ALSO persist to the server relay and poke the recipient's
   * push subscription — not only attempt P2P — so the knock survives us
   * going offline before the recipient ever comes online. */
  const ERIN = { id: 'erin-id', name: 'Erin', username: 'erin', avatar: null, lang: 'en' }
  const erinRoomId = reach.reach(ERIN, 'hey erin')
  await tick()
  const relayed = relayData.get(erinRoomId)
  check('reach() persists the knock to the relay', relayed?.toId === ERIN.id)
  check('the relayed knock names us as the sender', relayed?.knock?.from?.id === db.profile().id)
  check('the relayed knock carries our message', relayed?.knock?.text === 'hey erin')
  check('reach() pokes the recipient to wake their device', pushPokes.includes(ERIN.id))

  /* ------------------------------------------------------------------ 9 */
  /* The other half: a knock someone left in the relay while WE were offline
   * must be picked up — same as a live P2P knock — the next time we check
   * (boot, or here, regaining foreground), then cleared from the relay. */
  relayData.set('frank-room', {
    toId: db.profile().id,
    knock: {
      from: { id: 'frank-id', name: 'Frank', avatar: null, lang: 'en' },
      roomId: 'frank-room', secret: 'frank-secret', text: 'left this while you were away', mode: 'meet'
    }
  })
  reach.resume()
  await tick()
  check('a knock left in the relay opens the conversation on resume()',
    db.convo('frank-room')?.peer?.id === 'frank-id')
  check('a relay-delivered knock adds the sender as a contact',
    db.contacts().some((c) => c.id === 'frank-id'))
  check('a relay-delivered knock is acked (removed from the relay)',
    !relayData.has('frank-room'))

  /* ------------------------------------------------------------------ 10 */
  /* Checking again must not blow up or duplicate — the relay is empty now,
   * and receiveKnock()'s own dedupe covers the case where it is not. */
  reach.resume()
  await tick()
  check('checking an empty relay again is a no-op, not an error',
    db.convo('frank-room')?.peer?.id === 'frank-id')

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
