/**
 * Chat requests — the delivery guarantee.
 *
 * This pins the bug that was reported twice and took an adversarial hunt to
 * find (87ee26b): `deliverRequest` retried only while the `req` action did not
 * exist, but `req` is created at boot — so every real request fired exactly
 * once, into whatever peers happened to be connected at that instant. Trystero
 * resolves a send against an EMPTY room successfully, so a request sent before
 * the lobby had meshed left the device as zero bytes while the UI said "sent".
 *
 * The property that matters is therefore not "send was called". It is:
 *
 *   a request stays owed until the recipient's device acknowledges it.
 *
 * Every test below asserts some face of that. If one fails, someone has
 * reintroduced fire-and-forget delivery and friend requests are being lost
 * again — silently, which is what made it so expensive to diagnose.
 *
 * The lobby transport is faked (no DHT, no WebRTC) so this is fast and
 * deterministic, but db.js is the REAL module: the outbox consults the
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

/* ------------------------------------------------------ fake lobby room */
/** One Trystero action: records every send so a test can assert delivery. */
function makeAction () {
  const sends = []
  return {
    send: (payload, opts) => { sends.push({ payload, target: opts?.target ?? null }); return Promise.resolve() },
    onMessage: null,
    sends
  }
}

const actions = {}
/** Peers the transport currently reports as connected. Empty = unmeshed. */
let livePeers = {}

const fakeRoom = {
  makeAction: (name) => (actions[name] = makeAction()),
  getPeers: () => livePeers,
  onPeerJoin: null,
  onPeerLeave: null,
  leave: () => {}
}

mock.module('@trystero-p2p/torrent', {
  namedExports: { joinRoom: () => fakeRoom }
})
/* Relay credentials resolve instantly; the lobby waits on this before joining. */
mock.module(`${SRC}net.js`, {
  namedExports: { RTC_CONFIG: {}, readyRTC: () => Promise.resolve() }
})
mock.module(`${SRC}lib/rooms.js`, {
  namedExports: { rooms: { leave: () => {} } }
})
mock.module(`${SRC}lib/notify.js`, {
  namedExports: { pushNote: () => {} }
})

const { lobby } = await import(`${SRC}lib/discovery.js`)
const { db } = await import(`${SRC}lib/db.js`)

/* ------------------------------------------------------------- harness */
const results = {}
const check = (name, value) => { results[name] = value === true }
const tick = () => new Promise((r) => setTimeout(r, 0))

/** Simulate a peer appearing in the lobby — the outbox's main flush trigger. */
async function peerJoins (peerId) {
  fakeRoom.onPeerJoin(peerId)
  await tick()
}

const BOB = { id: 'bob-id', name: 'Bob', username: 'bob', avatar: null, lang: 'en' }

async function main () {
  db.setProfile({ name: 'Alice', lang: 'en' })
  lobby.start()
  await tick()

  /* ------------------------------------------------------------------ 1 */
  /* An empty lobby is the exact condition the old code mistook for success.
   * The request must be RECORDED but not considered delivered. */
  livePeers = {}
  const roomId = lobby.request(BOB, 'hey')
  await tick()

  const convo = db.convo(roomId)
  check('request records a pending conversation', convo?.pending === true)
  check('request is not marked delivered into an empty lobby', !convo?.delivered)
  check('payload is kept for later redelivery', Boolean(convo?.reqPayload))
  check('nothing is sent into an empty lobby', actions.req.sends.length === 0)

  /* ------------------------------------------------------------------ 2 */
  /* The peer finally shows up. THIS is the moment the old code never had. */
  await peerJoins('bob-transport-1')
  check('request is delivered when a peer joins', actions.req.sends.length === 1)
  check('delivery is targeted at the joining peer',
    actions.req.sends[0]?.target === 'bob-transport-1')
  check('the delivered payload is the original request',
    actions.req.sends[0]?.payload?.roomId === roomId)

  /* ------------------------------------------------------------------ 3 */
  /* Still no ack: the request is still owed, so a second join re-sends.
   * A send that merely "resolved" must never be mistaken for receipt. */
  await peerJoins('bob-transport-2')
  check('an unacknowledged request is re-sent on the next join',
    actions.req.sends.length === 2)
  check('conversation stays undelivered until acknowledged',
    db.convo(roomId)?.delivered !== true)

  /* ------------------------------------------------------------------ 4 */
  /* The recipient's device acknowledges. Only now is the debt settled. */
  actions.ack.onMessage({ roomId })
  await tick()
  check('ack marks the conversation delivered', db.convo(roomId)?.delivered === true)

  const afterAck = actions.req.sends.length
  await peerJoins('bob-transport-3')
  check('an acknowledged request is never re-sent', actions.req.sends.length === afterAck)

  /* ------------------------------------------------------------------ 5 */
  /* Closing the app must not abandon a request that never got through:
   * pending + undelivered conversations are reloaded into the outbox. */
  const stale = 'stale-room-id'
  db.upsertConvo({
    roomId: stale,
    secret: 'secret',
    kind: 'dm',
    mode: 'nearby',
    peer: { id: BOB.id, name: BOB.name, avatar: null, lang: 'en' },
    title: BOB.name,
    pending: true,
    delivered: false,
    reqPayload: {
      to: BOB.id,
      toUsername: 'bob',
      from: { id: db.profile().id, name: 'Alice' },
      roomId: stale,
      secret: 'secret',
      text: 'still owed'
    }
  })

  lobby.stop()          // app closes
  lobby.start()         // app reopens — rehydration runs here
  await tick()
  const beforeRehydrate = actions.req.sends.length
  await peerJoins('bob-transport-4')
  const resent = actions.req.sends.slice(beforeRehydrate)
  check('an undelivered request survives an app restart',
    resent.some((s) => s.payload?.roomId === stale))

  /* ------------------------------------------------------------------ 6 */
  /* The sender re-sends until it hears back, so a DUPLICATE arriving at a
   * room we already hold must still be acked — swallowing it silently would
   * make the sender shout forever. */
  const ackCountBefore = actions.ack.sends.length
  actions.req.onMessage({
    to: db.profile().id,
    from: { id: BOB.id, name: 'Bob' },
    roomId,                       // a room we already hold
    secret: 'secret',
    text: 'duplicate'
  }, { peerId: 'bob-transport-5' })
  await tick()
  check('a duplicate request is still acknowledged',
    actions.ack.sends.length === ackCountBefore + 1)

  /* -------------------------------------------------------------- report */
  console.log('========================================')
  console.log('  chat request delivery')
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

  lobby.stop()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
