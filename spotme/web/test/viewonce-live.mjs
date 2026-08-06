/**
 * View-once, end to end, with no fakes below the client module boundary.
 *
 * The unit suites either side of this one each fake the other half: the web
 * test fakes the transport, the backend test hand-writes the frames. That is
 * exactly how a view-once fix can typecheck, pass both suites, and still never
 * run — the client sealing `viewOnce` inside the encrypted metadata where the
 * server cannot read it would look green in both places. So this one is real
 * all the way down:
 *
 *   real socket-transport.js (real PBKDF2 room key, real AES-GCM, real
 *   wrapMeta) -> real Socket.IO -> real NestJS gateway -> real Postgres,
 *   with a direct SQL read of RoomEvent and ViewOnce at each step.
 *
 *   1. Alice sends a private photo        -> `once: true` must be on the wire
 *   2. Bob fetches it                     -> served, bytes intact, view claimed
 *   3. Mallory (a third socket) fetches   -> refused
 *   4. Bob opens it (seen + meta.burn)    -> the slices must be DELETED
 *   5. Anyone re-fetches                  -> gone, and invisible to a fresh join
 *
 * NOT part of `npm test`: it needs a running backend and its Postgres. Run it
 * against a backend built from the current source (the trap: delete
 * tsconfig.build.tsbuildinfo first or `nest build` emits an empty dist and
 * still exits 0), then:
 *
 *   cd spotme/backend && PORT=4100 node dist/main.js
 *   cd spotme/web && SPOTME_SERVER=http://localhost:4100 \
 *     node --experimental-test-module-mocks --no-warnings test/viewonce-live.mjs
 */
import { mock } from 'node:test'

const SERVER = process.env.SPOTME_SERVER || 'http://localhost:4000'
const SRC = new URL('../src/', import.meta.url).href

/* --- browser shim ------------------------------------------------------- */
const store = new Map()
globalThis.localStorage = {
  get length () { return store.size },
  key: (i) => Array.from(store.keys())[i] ?? null,
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
}
globalThis.location = { hostname: 'localhost', href: 'http://localhost/', origin: 'http://localhost', pathname: '/' }
globalThis.window = { location: globalThis.location, addEventListener () {} }

mock.module(`${SRC}lib/api.js`, {
  namedExports: { API_BASE: SERVER, apiUrl: (p) => `${SERVER}/${String(p).replace(/^\//, '')}` }
})
/* The @trystero-p2p/torrent stub that used to sit here is gone with the
 * package (ADR-033, server-side transport only). It was defensive — it threw
 * if the P2P path was ever reached — and mock.module() must RESOLVE a
 * specifier to stub it, so once the dependency was dropped the stub itself
 * was what broke the suite. The guarantee it stood for is now structural:
 * the module does not exist, and transport.test.js fences it. */

const { db } = await import(`${SRC}lib/db.js`)
const hex = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('')

const ROOM = 'live-vo-' + hex(8)
const SECRET = hex(16)
const PHOTO_BYTES = new Uint8Array(3000).fill(42)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: ok === true, detail })
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

/** One independent client: its own profile id, tokens and transport module. */
async function client (name) {
  store.clear()
  db.setProfile({ id: hex(8), name })
  const mod = await import(`${SRC}lib/socket-transport.js?who=${name}`)
  const room = mod.joinRoom({ appId: 'io.ysnapai.spotme', password: SECRET }, ROOM)
  const bin = room.makeAction('bin')
  const seen = room.makeAction('seen')
  const fetcher = room.makeAction('fetch', { kind: 'request', onRequest: () => null })
  await new Promise((r) => setTimeout(r, 1500))
  return { mod, room, bin, seen, fetcher, id: () => mod.selfId }
}

const { PrismaClient } = await import('../../backend/node_modules/@prisma/client/default.js')
const prisma = new PrismaClient()
const slices = () => prisma.roomEvent.count({ where: { roomId: ROOM, type: 'bin' } })

const alice = await client('Alice')
const bob = await client('Bob')
const mallory = await client('Mallory')
console.log(`\nroom ${ROOM}  alice=${alice.id()} bob=${bob.id()} mallory=${mallory.id()}\n`)

const attachId = hex(8)

/* 1. Alice sends a view-once attachment through the REAL transport. */
await alice.bin.send(PHOTO_BYTES, {
  metadata: { id: attachId, seq: 0, total: 1, kind: 'image', viewOnce: true, burst: 10, from: alice.id() }
})
await new Promise((r) => setTimeout(r, 600))

const row = await prisma.roomEvent.findFirst({ where: { roomId: ROOM, attachId, type: 'bin' } })
check('the stored slice is marked view-once in CLEARTEXT meta', row?.meta?.once === true,
  JSON.stringify({ meta: { ...row?.meta, cm: `<${String(row?.meta?.cm).length} chars sealed>` } }))
check('nothing else escaped the sealed envelope',
  row?.meta?.kind === undefined && row?.meta?.burst === undefined && row?.meta?.from === undefined)
check('the payload on disk is ciphertext, not the photo',
  !Buffer.from(row.payload).includes(Buffer.from(PHOTO_BYTES.slice(0, 32))))

/* 2. The recipient opens it first and claims the single view (in a DM there
 *    is only one other party; in a group it is whoever opens it first). */
const got = await bob.fetcher.request({ id: attachId }, { target: 'server' })
check('the recipient gets the real bytes back',
  got?.byteLength === PHOTO_BYTES.byteLength && Buffer.from(got).equals(Buffer.from(PHOTO_BYTES)),
  `${got?.byteLength} bytes`)
check('the slices are still on the server before the open', (await slices()) === 1)

const claim = await prisma.viewOnce.findUnique({ where: { attachId } })
check('a claim row records WHO the single view belongs to', claim?.viewerId === bob.id(),
  JSON.stringify({ viewerId: claim?.viewerId, senderId: claim?.senderId }))

/* 3. A third party in the room is now refused, even before the burn. */
let malloryErr = null
try { await mallory.fetcher.request({ id: attachId }, { target: 'server' }) } catch (e) { malloryErr = e }
check('a third socket in the room is REFUSED the private photo',
  /not sent to you/.test(malloryErr?.message || ''), malloryErr?.message || 'NO ERROR — it was served!')

/* 4. Bob opens it. This is exactly what rooms.viewOnceOpen emits. */
await bob.seen.send({ id: attachId, opening: true, secs: 10, burn: true },
  { metadata: { id: attachId, burn: attachId } })
await new Promise((r) => setTimeout(r, 800))

check('THE BURN: every stored slice is deleted the moment it is opened', (await slices()) === 0)
const burned = await prisma.viewOnce.findUnique({ where: { attachId } })
check('the burn is recorded', Boolean(burned?.burnedAt), String(burned?.burnedAt))

/* 5. The documented attack: re-fetch after the burst animation. */
let after = 'served!'
try {
  const again = await bob.fetcher.request({ id: attachId }, { target: 'server' })
  after = again ? `SERVED ${again.byteLength} BYTES` : 'null'
} catch (e) { after = e.message }
check('the recipient cannot re-download it after the burn', after === 'null' || /not available|no longer/.test(after), after)

/* 6. And a device joining fresh is never told the message existed. */
const late = await client('Late')
const hist = []
late.room.makeAction('history').onMessage = (p) => hist.push(p)
await new Promise((r) => setTimeout(r, 1500))
check('a fresh join does not even see the envelope',
  !JSON.stringify(hist).includes(attachId), JSON.stringify(hist).slice(0, 120))

await prisma.$disconnect()
const passed = results.filter((r) => r.ok).length
console.log(`\n  ${passed}/${results.length} passed\n`)
process.exit(passed === results.length ? 0 : 1)
