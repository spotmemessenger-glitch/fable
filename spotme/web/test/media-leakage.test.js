/**
 * ZERO PLAINTEXT LEAVES THIS CLIENT — proved against the real crypto.
 *
 * Phase 3 objective 4 was "verify no unencrypted media, thumbnail or metadata
 * touches the proxies". That was asserted in prose and never executed. The
 * view-once suite is close but fakes the transport, which is precisely the hole
 * Phase 1 fell into: two green halves each faking the half they did not own.
 *
 * So this suite fakes exactly ONE thing — `socket.io-client` — and lets the
 * real `socket-transport.js` run underneath it: real PBKDF2 room key, real
 * AES-GCM `seal`, real `wrapMeta`, real base64 framing. Every frame the client
 * would have put on the wire is captured and searched for the plaintext that
 * went in. No backend required, so it runs in `npm test` rather than being a
 * manual step nobody performs.
 *
 * WHAT IT WOULD CATCH. Someone "optimising" wrapMeta to leave the filename
 * cleartext for server-side search; a thumbnail generated before sealing; a
 * caption promoted to routing meta so the server can index it; a payload sent
 * unsealed on a retry path. Each of those ships an app that looks identical and
 * is no longer end-to-end encrypted.
 *
 * The chunk loop itself lives in rooms.js (`deliverAttachment`, SLICE_BYTES =
 * 128KB) and is not re-implemented here; this drives several slices with the
 * metadata shape that loop produces, because every slice goes through the same
 * `sendAction` and the question under test is what crosses the boundary.
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

/* Every frame the client tried to send, captured at the socket boundary. */
const wire = []

const fakeSocket = {
  on () {},
  once (event, cb) { if (event === 'connect') setTimeout(cb, 0) },
  emit () {},
  timeout () {
    return {
      async emitWithAck (event, body) {
        wire.push({ event, body })
        if (event === 'join') return { peers: [], events: [], envelopes: [], lastEventId: 0 }
        return { seq: wire.length }
      }
    }
  }
}

mock.module('socket.io-client', { namedExports: { io: () => fakeSocket } })
mock.module('@trystero-p2p/torrent', {
  namedExports: { selfId: 'unused', joinRoom: () => { throw new Error('p2p not used in this test') } }
})
mock.module(`${SRC}lib/api.js`, {
  namedExports: { API_BASE: 'http://localhost:9', apiUrl: (p) => `http://localhost:9/${String(p).replace(/^\//, '')}` }
})

/* guestAuth() is the only fetch socket-transport makes before connecting. */
globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ accessToken: 'test-access', refreshToken: 'test-refresh', userId: 'aaaa1111bbbb2222' })
})

const { db } = await import(`${SRC}lib/db.js`)
db.setProfile({ id: 'aaaa1111bbbb2222', name: 'Leak Probe' })

const transport = await import(`${SRC}lib/socket-transport.js`)

/* --- the secrets that must never appear on the wire ---------------------- */

const SECRET_CAPTION = 'MEET-ME-BEHIND-THE-STATION-AT-MIDNIGHT'
const SECRET_FILENAME = 'passport-scan-DO-NOT-SHARE.jpg'
/* A recognisable marker repeated through the bytes, so a partial or offset leak
 * is found rather than only a whole-buffer one. */
const MARKER = 'PLAINTEXT-MARKER-9F3A'
const photo = new TextEncoder().encode(
  Array.from({ length: 400 }, (_, i) => `${MARKER}-${i}-`).join('')
)

const ROOM = 'leak-probe-room-0001'
const room = transport.joinRoom({ appId: 'io.ysnapai.spotme', password: 'room-secret-xyz' }, ROOM)
const bin = room.makeAction('bin')
const msg = room.makeAction('msg')

/* Three slices with the metadata shape rooms.js's chunk loop emits: the full
 * envelope on seq 0, routing only afterwards. */
const ATTACH_ID = 'att-leak-0001'
const SLICES = 3
const per = Math.ceil(photo.length / SLICES)
for (let seq = 0; seq < SLICES; seq++) {
  const slice = photo.slice(seq * per, (seq + 1) * per)
  const metadata = seq === 0
    ? { id: ATTACH_ID, seq, total: SLICES, kind: 'image', mime: 'image/jpeg',
        name: SECRET_FILENAME, caption: SECRET_CAPTION, w: 1280, h: 720 }
    : { id: ATTACH_ID, seq, total: SLICES }
  await bin.send(slice, { metadata })
}
await msg.send({ id: 'm1', text: SECRET_CAPTION, ts: 1 })

/* --- assertions ---------------------------------------------------------- */

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const actions = wire.filter((w) => w.event === 'action')
/** Everything the client emitted, as one searchable string. */
const everything = JSON.stringify(wire)

check('the transport actually sent something — a silent no-op would pass every leak test', () =>
  actions.length === SLICES + 1)

check('the raw media bytes never appear on the wire', () =>
  !everything.includes(MARKER))

check('…nor does the caption', () =>
  !everything.includes(SECRET_CAPTION))

check('…nor the filename', () =>
  !everything.includes(SECRET_FILENAME))

check('…nor any of it base64-encoded, which is not encryption', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '')
  return !everything.includes(b64(MARKER)) &&
    !everything.includes(b64(SECRET_CAPTION)) &&
    !everything.includes(b64(SECRET_FILENAME))
})

check('a plain text message body is sealed too, not just attachments', () => {
  const m = actions.find((a) => a.body.type === 'msg')
  return !!m && !JSON.stringify(m.body).includes(SECRET_CAPTION)
})

check('cleartext meta carries ROUTING ONLY — id, seq, total, cm, and nothing else', () => {
  const allowed = new Set(['id', 'seq', 'total', 'cm', 'once', 'burn'])
  return actions.filter((a) => a.body.type === 'bin')
    .every((a) => Object.keys(a.body.meta || {}).every((k) => allowed.has(k)))
})

check('the envelope survives — sealed into meta.cm, not dropped', () => {
  const first = actions.find((a) => a.body.type === 'bin' && a.body.meta?.seq === 0)
  return typeof first?.body?.meta?.cm === 'string' && first.body.meta.cm.length > 0
})

check('every slice carries its own ciphertext, none reused', () => {
  const payloads = actions.filter((a) => a.body.type === 'bin').map((a) => a.body.payload)
  return payloads.length === SLICES && new Set(payloads).size === SLICES
})

check('payloads are base64 TEXT, never Buffers — the framing bug that killed sockets', () =>
  actions.every((a) => typeof a.body.payload === 'string'))

check('each slice has a distinct AES-GCM nonce — a reused IV breaks the cipher', () => {
  const ivs = actions.filter((a) => a.body.type === 'bin')
    .map((a) => Buffer.from(a.body.payload, 'base64').subarray(0, 12).toString('hex'))
  return ivs.length === SLICES && new Set(ivs).size === SLICES
})

check('ciphertext is longer than plaintext by exactly the IV and GCM tag', () => {
  const a = actions.find((x) => x.body.type === 'bin' && x.body.meta?.seq === 0)
  const sliceLen = photo.slice(0, per).length
  return Buffer.from(a.body.payload, 'base64').length === sliceLen + 12 + 16
})

check('the room password itself never crosses the wire', () =>
  !everything.includes('room-secret-xyz'))

/* --- report -------------------------------------------------------------- */

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  media — nothing readable leaves the client')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
