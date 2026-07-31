/**
 * How many times does ONE send actually hit the wire?
 *
 * The two-origin harness showed 2, then 8, identical `bin` attempts for a
 * single attachment right after a reload. Exactly one RoomEvent row and one
 * stored object resulted each time, so nothing was duplicated server-side —
 * but "probably the documented rejoin retry" is not a fact, and a send path
 * that can fire eight times is worth knowing about either way: each attempt
 * re-seals the payload, and on the object-storage path each one is a round
 * trip.
 *
 * `sendAction` retries AT MOST ONCE, and only on "not joined":
 *
 *     try { ack = await emitAck(...) }
 *     catch (e) { if (!/not joined/.test(e.message)) throw; await rejoin(); ack = await emitAck(...) }
 *
 * So N attempts for one logical send means N/2 invocations — 8 attempts cannot
 * come from a single call. This pins the contract so that arithmetic is
 * trustworthy, and so a future change that adds a second retry (making the
 * ceiling 3, or unbounded) fails here instead of in production.
 *
 * Real socket-transport, real crypto; only the socket is faked, because the
 * socket is exactly what is being counted.
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

/** Every emitWithAck the transport made. THE thing under test. */
const attempts = []
/** Scripted replies, consumed in order; anything past the end succeeds. */
let script = []
/** Alternative model: fail the FIRST attempt for a given attachment id only. */
let firstAttemptFails = null

const socket = {
  on () {},
  once (event, cb) { if (event === 'connect') setTimeout(cb, 0) },
  emit () {},
  timeout () {
    return {
      async emitWithAck (event, body) {
        attempts.push({ event, type: body?.type, metaId: body?.meta?.id })
        if (event === 'join') return { peers: [], events: [], envelopes: [], lastEventId: 0 }
        if (firstAttemptFails && firstAttemptFails(body?.meta?.id)) return { error: 'not joined' }
        const next = script.shift()
        if (next === 'not-joined') return { error: 'not joined' }
        if (next === 'other-error') return { error: 'members cannot send media here' }
        return { seq: attempts.length }
      }
    }
  }
}

mock.module('socket.io-client', { namedExports: { io: () => socket } })
mock.module('@trystero-p2p/torrent', { namedExports: { selfId: 'x', joinRoom: () => { throw new Error('unused') } } })
mock.module(`${SRC}lib/api.js`, { namedExports: { API_BASE: 'http://localhost:9', apiUrl: (p) => `http://localhost:9/${p}` } })
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ accessToken: 't', userId: 'aaaa1111bbbb2222' }) })

const { db } = await import(`${SRC}lib/db.js`)
db.setProfile({ id: 'aaaa1111bbbb2222', name: 'Retry Probe' })
const transport = await import(`${SRC}lib/socket-transport.js`)

const results = {}
const checkAsync = async (n, fn) => {
  try { results[n] = (await fn()) === true } catch (e) { results[n] = false; results[`${n} (threw: ${e.message})`] = false }
}

const room = transport.joinRoom({ appId: 'io.ysnapai.spotme', password: 'p' }, 'retry-room-1')
const bin = room.makeAction('bin')
const actionsOnly = () => attempts.filter((a) => a.event === 'action')

await checkAsync('a clean send hits the wire EXACTLY once', async () => {
  attempts.length = 0; script = []
  await bin.send(new Uint8Array(8), { metadata: { id: 'att-clean', seq: 0, total: 1 } })
  return actionsOnly().length === 1
})

await checkAsync('"not joined" costs exactly one retry — two attempts, never more', async () => {
  attempts.length = 0; script = ['not-joined']
  await bin.send(new Uint8Array(8), { metadata: { id: 'att-retry', seq: 0, total: 1 } })
  // The rejoin in between also emits a 'join', which is why the filter
  // matters: join frames are not send attempts.
  return actionsOnly().length === 2
})

await checkAsync('a SECOND "not joined" is not retried again — the ceiling is 2', async () => {
  attempts.length = 0; script = ['not-joined', 'not-joined']
  let threw = null
  try {
    await bin.send(new Uint8Array(8), { metadata: { id: 'att-twice', seq: 0, total: 1 } })
  } catch (e) { threw = e.message }
  // Single-shot: the second refusal propagates rather than looping. An
  // unbounded retry here would be a send that never gives up.
  return actionsOnly().length === 2 && /not joined/.test(threw || '')
})

await checkAsync('any OTHER refusal is not retried at all — one attempt', async () => {
  attempts.length = 0; script = ['other-error']
  let threw = null
  try {
    await bin.send(new Uint8Array(8), { metadata: { id: 'att-refused', seq: 0, total: 1 } })
  } catch (e) { threw = e.message }
  // A group-policy refusal must not be re-sent; retrying "you are muted"
  // would be pointless and a way to hammer the server.
  return actionsOnly().length === 1 && /cannot send media/.test(threw || '')
})

await checkAsync('so N attempts for one send means N/2 invocations, not a loop', async () => {
  /* Four separate logical sends, each racing the rejoin ONCE: 8 attempts.
   *
   * Modelled per-attachment rather than with a flat script, because a flat
   * one is wrong: the retry consumes the next entry too, so ['not-joined' x4]
   * makes the FIRST send fail twice and throw. That mistake is worth leaving
   * described — it is the same off-by-one that makes "8 attempts" look like a
   * runaway loop when it is four independent sends. */
  attempts.length = 0; script = []
  const raced = new Set()
  firstAttemptFails = (id) => { if (raced.has(id)) return false; raced.add(id); return true }
  for (let i = 0; i < 4; i++) {
    await bin.send(new Uint8Array(8), { metadata: { id: `att-multi-${i}`, seq: 0, total: 1 } })
  }
  firstAttemptFails = null
  return actionsOnly().length === 8
})

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  send retry — one send, bounded attempts')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
