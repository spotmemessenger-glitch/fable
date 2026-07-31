/**
 * Proves the knock relay does not downgrade a conversation.
 *
 * TWO BUGS LIVE HERE, and the second hid the first.
 *
 * 1. `handleStore` rebuilds an ALLOWLIST record rather than passing the knock
 *    through, and `e2eVersion`/`senderKey` were not on the list. So a knock
 *    delivered by the relay — the offline path, taken whenever the sender goes
 *    away before the recipient comes online — arrived without the public key
 *    needed to agree an e2e_v2 key, and `receiveKnock` silently opened an
 *    e2e_v1 room. Live P2P knocks were v2, relayed ones were not, and nothing
 *    anywhere said so.
 *
 * 2. `isToken` demanded pure hex, but `reach.js` builds room ids as
 *    `dm-${stableHash(...)}` and `inbox-${stableHash(...)}`. A hyphen is not a
 *    hex digit, so the relay answered 400 "invalid knock" to EVERY direct
 *    message — and `relayStore` posts through `safe()`, which swallows it. The
 *    durable offline path for DMs had therefore never worked at all, silently,
 *    since it was written.
 *
 * WHY A MOCK AND NOT THE REAL REDIS. The Upstash credentials live only on
 * Vercel. Borrowing them would write test knocks into real users' inboxes and
 * would not be reproducible on any other machine. This speaks Upstash's REST
 * dialect faithfully instead — the same commands over the same wire shape — so
 * `handleStore` and `handleGet` run unmodified, end to end, offline.
 */
import { createServer } from 'node:http'

/* ------------------------------------------------- fake Upstash REST ---- */

const store = new Map()   // key -> string
const sets = new Map()    // key -> Set

function runCommand (cmd) {
  const [op, key, ...rest] = cmd.map(String)
  switch (op.toUpperCase()) {
    case 'SET': store.set(key, rest[0]); return 'OK'
    case 'GET': return store.has(key) ? store.get(key) : null
    case 'SADD': {
      if (!sets.has(key)) sets.set(key, new Set())
      const before = sets.get(key).size
      rest.forEach((m) => sets.get(key).add(m))
      return sets.get(key).size - before
    }
    case 'SMEMBERS': return [...(sets.get(key) ?? [])]
    case 'SREM': {
      const s = sets.get(key)
      if (!s) return 0
      let n = 0
      rest.forEach((m) => { if (s.delete(m)) n++ })
      return n
    }
    case 'SCARD': return (sets.get(key) ?? new Set()).size
    case 'DEL': { store.delete(key); sets.delete(key); return 1 }
    default: return null
  }
}

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    let parsed
    try { parsed = JSON.parse(raw) } catch { parsed = null }
    res.setHeader('content-type', 'application/json')
    if (req.url === '/pipeline') {
      // Upstash pipeline: array of commands -> array of {result}
      const out = (parsed || []).map((cmd) => ({ result: runCommand(cmd) }))
      res.end(JSON.stringify(out))
    } else {
      res.end(JSON.stringify({ result: runCommand(parsed || []) }))
    }
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${port}`
process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token'

// Imported AFTER the env is set — the module reads it per call, but this also
// documents the ordering requirement for anyone editing this file.
const { default: handler } = await import('../api/knock.js')

/* ------------------------------------------------------------ harness --- */

const results = {}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) {
    results[name] = false
    results[`${name} (threw: ${e.message})`] = false
  }
}

function fakeRes () {
  const r = { code: 0, body: null, ended: false }
  r.status = (n) => { r.code = n; return r }
  r.json = (b) => { r.body = b; return r }
  r.end = () => { r.ended = true; return r }
  r.setHeader = () => r
  return r
}

const post = async (body) => {
  const res = fakeRes()
  await handler({ method: 'POST', headers: {}, body }, res)
  return res
}
const get = async (userId) => {
  const res = fakeRes()
  await handler({ method: 'GET', headers: {}, query: { userId } }, res)
  return res
}

const ALICE = 'aaaa1111aaaa1111'
const BOB = 'bbbb2222bbbb2222'
const KEY32 = 'NlKlTbj1/MwbDnDhuDWb9lLRiuvgG0JmbyPpQCyC0hU='   // 32 raw bytes, base64

const knockFor = (roomId, extra = {}) => ({
  action: 'store',
  toId: BOB,
  knock: {
    from: { id: ALICE, name: 'Alice', lang: 'en' },
    roomId,
    secret: 'deadbeefcafe1234deadbeefcafe5678',
    text: 'hi',
    mode: 'meet',
    ...extra
  }
})

/* ============ the shape reach.js actually produces must be ACCEPTED ======= */

await checkAsync('a real dm-<hash> roomId is accepted (it used to 400 — always)', async () => {
  const r = await post(knockFor('dm-1a2b3c4d5e6f7a8b'))
  return r.code === 200 && r.body?.ok === true
})

await checkAsync('an inbox-<hash> roomId is accepted', async () => {
  const r = await post(knockFor('inbox-9f8e7d6c5b4a3210'))
  return r.code === 200
})

await checkAsync('a bare hex roomId (group rooms) still works', async () => {
  const r = await post(knockFor('1a2b3c4d5e6f7a8b'))
  return r.code === 200
})

await checkAsync('path traversal is still refused', async () => {
  const r = await post(knockFor('../../etc/passwd'))
  return r.code === 400
})

await checkAsync('an over-long prefix is still refused', async () => {
  const r = await post(knockFor('waaaaaaaaaytoolongprefix-1a2b3c4d'))
  return r.code === 400
})

/* ================= THE POINT: the round trip preserves v2 ================ */

await checkAsync('ROUND TRIP: e2eVersion and senderKey survive store -> Redis -> fetch', async () => {
  const roomId = 'dm-aaaabbbbccccdddd'
  const stored = await post(knockFor(roomId, { e2eVersion: 'e2e_v2', senderKey: KEY32 }))
  if (stored.code !== 200) return false

  const fetched = await get(BOB)
  const k = (fetched.body?.knocks || []).find((x) => x.roomId === roomId)
  return Boolean(k) && k.e2eVersion === 'e2e_v2' && k.senderKey === KEY32
})

await checkAsync('ROUND TRIP: the rest of the knock is unharmed', async () => {
  const roomId = 'dm-1111222233334444'
  await post(knockFor(roomId, { e2eVersion: 'e2e_v2', senderKey: KEY32 }))
  const k = ((await get(BOB)).body?.knocks || []).find((x) => x.roomId === roomId)
  return k?.from?.id === ALICE && k?.text === 'hi' && k?.mode === 'meet' &&
         k?.secret === 'deadbeefcafe1234deadbeefcafe5678'
})

/* ===================== downgrade must be EXPLICIT ======================== */

await checkAsync('a knock with NO version defaults to e2e_v1, never to v2', async () => {
  const roomId = 'dm-5555666677778888'
  await post(knockFor(roomId))
  const k = ((await get(BOB)).body?.knocks || []).find((x) => x.roomId === roomId)
  return k?.e2eVersion === 'e2e_v1' && k?.senderKey === null
})

await checkAsync('an unknown version string is not honoured as v2', async () => {
  const roomId = 'dm-9999aaaabbbbcccc'
  await post(knockFor(roomId, { e2eVersion: 'e2e_v99', senderKey: KEY32 }))
  const k = ((await get(BOB)).body?.knocks || []).find((x) => x.roomId === roomId)
  return k?.e2eVersion === 'e2e_v1'
})

/* ================== the key lands in a PUBLIC inbox ====================== */

await checkAsync('a senderKey with illegal characters is nulled, not stored', async () => {
  const roomId = 'dm-dddd0000eeee1111'
  await post(knockFor(roomId, { e2eVersion: 'e2e_v2', senderKey: '<script>alert(1)</script>' }))
  const k = ((await get(BOB)).body?.knocks || []).find((x) => x.roomId === roomId)
  return k?.senderKey === null
})

await checkAsync('an absurdly long senderKey is nulled, not stored', async () => {
  const roomId = 'dm-2222333344445555'
  await post(knockFor(roomId, { e2eVersion: 'e2e_v2', senderKey: 'A'.repeat(5000) }))
  const k = ((await get(BOB)).body?.knocks || []).find((x) => x.roomId === roomId)
  return k?.senderKey === null
})

await checkAsync('a non-string senderKey cannot crash the handler', async () => {
  const roomId = 'dm-6666777788889999'
  const r = await post(knockFor(roomId, { e2eVersion: 'e2e_v2', senderKey: { evil: true } }))
  if (r.code !== 200) return false
  const k = ((await get(BOB)).body?.knocks || []).find((x) => x.roomId === roomId)
  return k?.senderKey === null
})

/* ------------------------------------------------------------- report --- */
server.close()
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  knock relay — no silent v2 downgrade')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
