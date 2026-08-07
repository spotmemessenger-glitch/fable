/**
 * Direct-to-storage media: what goes up is ciphertext, what comes back is the file.
 *
 * Phase 5 moves attachment bytes off the socket and into object storage. That
 * relocates the single most sensitive payload in the app, so the question this
 * suite answers is not "does it round-trip" — it is "does anything readable
 * leave the device on the new path". Same standard as media-leakage.test.js,
 * applied to the pipeline that replaces it.
 *
 * The crypto is REAL: socket-transport.js is loaded unmocked, so `sealForRoom`
 * runs actual AES-GCM with an actual PBKDF2 room key. Only `fetch` is stubbed,
 * which is exactly the boundary under test — every request the client would
 * have made is captured and inspected.
 */
import { mock } from 'node:test'

const SRC = new URL('../src/', import.meta.url).href

globalThis.window = { addEventListener () {}, location: { origin: 'http://localhost', href: 'http://localhost/', hostname: 'localhost', pathname: '/', protocol: 'http:', host: 'localhost' } }
globalThis.location = globalThis.window.location
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }
const ls = new Map()
globalThis.localStorage = {
  get length () { return ls.size },
  key: (i) => [...ls.keys()][i] ?? null,
  getItem: (k) => (ls.has(k) ? ls.get(k) : null),
  setItem: (k, v) => ls.set(k, String(v)),
  removeItem: (k) => ls.delete(k)
}

mock.module(`${SRC}lib/api.js`, {
  namedExports: { API_BASE: 'http://api.test', apiUrl: (p) => `http://api.test/${String(p).replace(/^\//, '')}` }
})
/* The @trystero-p2p/torrent stub that used to sit here is gone with the
 * package (ADR-033, server-side transport only). It was defensive — it threw
 * if the P2P path was ever reached — and mock.module() must RESOLVE a
 * specifier to stub it, so once the dependency was dropped the stub itself
 * was what broke the suite. The guarantee it stood for is now structural:
 * the module does not exist, and transport.test.js fences it. */
mock.module('socket.io-client', {
  namedExports: { io: () => ({ on () {}, once () {}, emit () {}, timeout: () => ({ emitWithAck: async () => ({}) }) }) }
})

/** Every request the client made, and the fake bucket's contents. */
const requests = []
const bucket = new Map()

globalThis.fetch = async (url, init = {}) => {
  const u = String(url)
  requests.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body })

  if (u.endsWith('/api/auth/guest')) {
    return { ok: true, status: 200, json: async () => ({ accessToken: 'tok', userId: 'aaaa1111bbbb2222' }) }
  }
  if (u.endsWith('/api/v2/media/presign')) {
    const { roomId, attachId, seq } = JSON.parse(init.body)
    const objectKey = `rooms/${roomId}/${attachId}/${seq}`
    return { ok: true, status: 200, json: async () => ({ objectKey, uploadUrl: `/put?key=${encodeURIComponent(objectKey)}`, expiresIn: 300 }) }
  }
  if (u.includes('/put?key=')) {
    bucket.set(decodeURIComponent(u.split('key=')[1]), new Uint8Array(init.body))
    return { ok: true, status: 200, json: async () => ({ stored: init.body.byteLength }) }
  }
  if (u.includes('/api/v2/media/download-url/')) {
    const key = decodeURIComponent(u.split('/download-url/')[1])
    if (key.includes('burned')) return { ok: false, status: 404, json: async () => ({ message: 'that private photo has been opened and destroyed' }) }
    if (!bucket.has(key)) return { ok: false, status: 403, json: async () => ({ message: 'unknown object' }) }
    return { ok: true, status: 200, json: async () => ({ downloadUrl: `/get?key=${encodeURIComponent(key)}` }) }
  }
  if (u.includes('/get?key=')) {
    const key = decodeURIComponent(u.split('key=')[1])
    const bytes = bucket.get(key)
    if (!bytes) return { ok: false, status: 404 }
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
  }
  return { ok: false, status: 500, json: async () => ({}) }
}

const { db } = await import(`${SRC}lib/db.js`)
db.setProfile({ id: 'aaaa1111bbbb2222', name: 'Transfer Probe' })
const { uploadAttachment, downloadAttachment, objectStorageEnabled, objectKeyFor } =
  await import(`${SRC}lib/media-transfer.js`)

const results = {}
const check = (n, fn) => { try { results[n] = fn() === true } catch (e) { results[n] = false; results[`${n} (threw: ${e.message})`] = false } }
const checkAsync = async (n, fn) => { try { results[n] = (await fn()) === true } catch (e) { results[n] = false; results[`${n} (threw: ${e.message})`] = false } }

const ROOM = 'dm-transfer-probe'
const SECRET = 'room-secret-abc'
const MARKER = 'PLAINTEXT-PHOTO-MARKER-7C4E'
/* 300 KB, so it is genuinely multi-slice at 128 KB and a per-slice bug shows. */
const photo = new TextEncoder().encode(
  Array.from({ length: 11000 }, (_, i) => `${MARKER}-${i}-`).join('').slice(0, 300_000)
)

/* ------------------------------------------------------------- upload --- */

let uploaded
await checkAsync('upload slices the file and stores every slice', async () => {
  uploaded = await uploadAttachment(ROOM, 'att-probe', photo, { password: SECRET })
  return uploaded.total === 3 && bucket.size === 3
})

check('the presign request carries routing only — never the bytes', () => {
  const presigns = requests.filter((r) => r.url.endsWith('/presign'))
  if (presigns.length !== 3) return false
  return presigns.every((r) => {
    const body = JSON.parse(r.body)
    return Object.keys(body).sort().join() === 'attachId,contentType,roomId,seq' &&
      !r.body.includes(MARKER)
  })
})

check('NOTHING readable was uploaded — every stored object is ciphertext', () => {
  for (const bytes of bucket.values()) {
    if (new TextDecoder().decode(bytes).includes(MARKER)) return false
  }
  return true
})

check('…nor is any of it merely base64 of the plaintext', () => {
  const b64 = Buffer.from(MARKER, 'utf8').toString('base64').replace(/=+$/, '')
  for (const bytes of bucket.values()) {
    if (Buffer.from(bytes).toString('base64').includes(b64)) return false
  }
  return true
})

check('every slice carries its own AES-GCM nonce', () => {
  const ivs = [...bucket.values()].map((b) => Buffer.from(b.subarray(0, 12)).toString('hex'))
  return ivs.length === 3 && new Set(ivs).size === 3
})

check('the room secret never appears in any request', () =>
  !JSON.stringify(requests).includes(SECRET))

check('object keys are derived, not chosen by the client', () => {
  // The client asks with {roomId, attachId, seq}; the SERVER names the object.
  const body = JSON.parse(requests.find((r) => r.url.endsWith('/presign')).body)
  return body.objectKey === undefined &&
    objectKeyFor(ROOM, 'att-probe', 0) === 'rooms/dm-transfer-probe/att-probe/0'
})

/* ----------------------------------------------------------- download --- */

await checkAsync('download reassembles the original file byte for byte', async () => {
  const got = await downloadAttachment(ROOM, 'att-probe', uploaded.total, { password: SECRET })
  return got.byteLength === photo.byteLength && Buffer.from(got).equals(Buffer.from(photo))
})

await checkAsync('progress is reported for every slice', async () => {
  const seen = []
  await downloadAttachment(ROOM, 'att-probe', uploaded.total, { password: SECRET, onProgress: (p) => seen.push(p) })
  return seen.length === 3 && seen[seen.length - 1] === 1
})

await checkAsync('a burned photo is reported as destroyed, not as a network error', async () => {
  try {
    await downloadAttachment(ROOM, 'burned-att', 1, { password: SECRET })
    return false
  } catch (e) {
    return /opened and destroyed/i.test(e.message)
  }
})

await checkAsync('a MISSING slice is refused — never returned as a shorter file', async () => {
  // The exact truncation hazard the RoomEvent path had to fix: the bytes that
  // are present decode perfectly, and a short file is indistinguishable from a
  // complete one unless the declared total is enforced.
  bucket.delete(objectKeyFor(ROOM, 'att-probe', 2))
  try {
    await downloadAttachment(ROOM, 'att-probe', 3, { password: SECRET })
    return false
  } catch (e) {
    return /unknown object|HTTP 403|incomplete/i.test(e.message)
  }
})

/* -------------------------------------------------------------- flag ---- */

check('object storage is OFF unless this device opted in', () => {
  localStorage.removeItem('spotme.media')
  if (objectStorageEnabled() !== false) return false
  localStorage.setItem('spotme.media', 'object')
  const on = objectStorageEnabled()
  localStorage.removeItem('spotme.media')
  return on === true
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  media-transfer — ciphertext to storage')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
