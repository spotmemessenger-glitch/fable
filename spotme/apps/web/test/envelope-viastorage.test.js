/**
 * A STORAGE-BACKED ATTACHMENT MUST SURVIVE OFFLINE DELIVERY.
 *
 * THE BUG THIS PINS. `absorbEnvelopes` turns replayed envelopes into detached
 * history bubbles, and it destructured them like this:
 *
 *     const { seq, total, ...envelope } = metadata
 *     messages.push({ ...envelope, data: null, detached: true })
 *
 * Dropping `total` was correct while every byte lived in the RoomEvent log: the
 * lazy fetch asks the server for slices and needs neither `total` nor
 * `viaStorage`. A storage-backed attachment HAS NO SLICES. Its bytes are one
 * object in a bucket, and the receiver needs `viaStorage` to know to go there
 * and `total` to know how much to expect.
 *
 * So a receiver that lost those two fields got an envelope it could render and
 * bytes it could never retrieve: a photo bubble whose "tap to load" fails
 * forever, on every future join, with nothing in the log to say why. It is
 * silent, permanent, and only reachable through OFFLINE delivery — the sender
 * is fine, the online path is fine, and it reproduces only when the recipient
 * was away when the photo was sent.
 *
 * WHY THIS FILE EXISTS AT ALL. PR #2 found this with a two-origin browser
 * harness and fixed it inline at ONE of the three join paths, with no test. The
 * fix now lives in `absorbEnvelopes` itself, which all three paths share — so
 * the contract needs pinning where a refactor will trip over it. This suite
 * fails against the pre-fix destructure.
 *
 * It fakes exactly one thing, `socket.io-client`, and runs the real
 * `socket-transport.js` underneath: real room key, real AES-GCM, real
 * `unwrapMeta`. The envelope is sealed with the exported `sealForRoom`, so the
 * ciphertext under test is built by the same code that builds it in production.
 *
 *   node --experimental-test-module-mocks --no-warnings test/envelope-viastorage.test.js
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

/* --- browser shim ------------------------------------------------------- */
const ls = new Map()
globalThis.localStorage = {
  get length () { return ls.size },
  key: (i) => Array.from(ls.keys())[i] ?? null,
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k)
}
globalThis.location = { hostname: 'localhost', href: 'http://localhost/', origin: 'http://localhost', pathname: '/', protocol: 'http:', host: 'localhost' }
globalThis.window = { location: globalThis.location, addEventListener () {} }

/* What the server will hand back on join. Filled in before the room connects;
 * the fake socket reads it at call time. */
let pendingEnvelopes = []
const joins = []

const fakeSocket = {
  on () {},
  once (event, cb) { if (event === 'connect') setTimeout(cb, 0) },
  emit () {},
  timeout () {
    return {
      async emitWithAck (event, body) {
        if (event === 'join') {
          joins.push(body)
          const envelopes = pendingEnvelopes
          pendingEnvelopes = []          // a replay is not served twice
          return { peers: [], events: [], envelopes, lastEventId: 12 }
        }
        return { seq: 1 }
      }
    }
  }
}

mock.module('socket.io-client', { namedExports: { io: () => fakeSocket } })
/* The @trystero-p2p/torrent stub that used to sit here is gone with the
 * package (ADR-033, server-side transport only). It was defensive — it threw
 * if the P2P path was ever reached — and mock.module() must RESOLVE a
 * specifier to stub it, so once the dependency was dropped the stub itself
 * was what broke the suite. The guarantee it stood for is now structural:
 * the module does not exist, and transport.test.js fences it. */
mock.module(`${SRC}lib/api.js`, {
  namedExports: { API_BASE: 'http://localhost:9', apiUrl: (p) => `http://localhost:9/${String(p).replace(/^\//, '')}` }
})

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'aaaa1111bbbb2222' })
})

const { db } = await import(`${SRC}lib/db.js`)
db.setProfile({ id: 'aaaa1111bbbb2222', name: 'Envelope Probe' })

const transport = await import(`${SRC}lib/socket-transport.js`)

/* --- build the envelopes the server would replay -------------------------- */

const ROOM = 'viastorage-probe-room-01'
const PASSWORD = 'room-secret-xyz'
const enc = new TextEncoder()
const b64 = (b) => Buffer.from(b).toString('base64')

/** Exactly what `wrapMeta` puts on the wire, built with the real seal. */
async function envelopeFor (metadata, seq) {
  const cm = b64(await transport.sealForRoom(ROOM, enc.encode(JSON.stringify(metadata)), PASSWORD))
  return {
    seq,
    from: 'bbbb2222cccc3333',
    attachId: metadata.id,
    meta: { id: metadata.id, seq: metadata.seq, total: metadata.total, cm }
  }
}

const STORAGE_ATTACH = {
  id: 'att-storage-01', seq: 0, total: 262144, viaStorage: true,
  kind: 'image', mime: 'image/jpeg', name: 'holiday.jpg', w: 1280, h: 720
}
const SLICED_ATTACH = {
  id: 'att-sliced-01', seq: 0, total: 3,
  kind: 'image', mime: 'image/jpeg', name: 'legacy.jpg', w: 640, h: 480
}

pendingEnvelopes = [
  await envelopeFor(STORAGE_ATTACH, 11),
  await envelopeFor(SLICED_ATTACH, 12)
]

/* --- drive the real join -------------------------------------------------- */

const room = transport.joinRoom({ appId: 'io.ysnapai.spotme', password: PASSWORD }, ROOM)

const delivered = []
const history = room.makeAction('history')
history.onMessage = (payload) => { for (const m of payload?.messages || []) delivered.push(m) }

/* Sending is what makes the room connect, and the join ack carries the
 * envelopes. Awaiting the send is not enough — absorbEnvelopes runs after the
 * ack resolves — so wait for the handler to actually fire. */
await room.makeAction('msg').send({ id: 'm1', text: 'hello', ts: 1 })
for (let i = 0; i < 60 && delivered.length < 2; i++) await new Promise((r) => setTimeout(r, 10))

const storage = delivered.find((m) => m.id === 'att-storage-01')
const sliced = delivered.find((m) => m.id === 'att-sliced-01')

/* --- assertions ----------------------------------------------------------- */

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[`${name} (threw: ${e.message})`] = false }
}

check('the join actually happened — a silent no-op would pass every check below', () =>
  joins.length >= 1)

check('both replayed envelopes reached the history handler', () =>
  delivered.length === 2 && !!storage && !!sliced)

/* THE ASSERTION THAT CATCHES THE BUG. Reverting `absorbEnvelopes` to the plain
 * `{ ...envelope, data: null, detached: true }` push fails this one and only
 * this one — measured, not assumed. */
check('…and KEEPS total, which is the byte count it must expect', () =>
  storage.total === 262144)

/* This one documents the contract rather than guarding it: `viaStorage` is
 * never at risk, because the destructure only pulls out `seq` and `total` and
 * everything else rides the rest spread. Stated so nobody reads the pair as
 * equally fragile — but kept, because a future destructure that DID pull it out
 * would break the bucket lookup just as silently. */
check('a storage-backed envelope carries viaStorage, or the receiver never looks in the bucket', () =>
  storage.viaStorage === true)

check('…and is still detached with no bytes attached', () =>
  storage.data === null && storage.detached === true)

check('…and carries the fields the bubble renders', () =>
  storage.kind === 'image' && storage.mime === 'image/jpeg' && storage.name === 'holiday.jpg')

check('…and never leaks the internal replay seq into the message', () =>
  storage.seq === undefined)

/* The other half of the contract. `total` is meaningless for a sliced
 * attachment — the lazy fetch counts slices from the server — and putting it
 * back would change what the renderer sees on the legacy path. */
check('a SLICED envelope still has total stripped, so the old path is unchanged', () =>
  sliced.total === undefined)

check('…and has no viaStorage flag at all', () =>
  sliced.viaStorage === undefined)

check('…and is detached like any other replayed attachment', () =>
  sliced.data === null && sliced.detached === true)

/* --- report --------------------------------------------------------------- */

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  envelopes — a bucket-backed attachment survives replay')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
