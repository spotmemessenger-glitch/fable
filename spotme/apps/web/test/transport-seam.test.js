/**
 * The transport SEAM: one place decides, and a fallback is never silent.
 *
 * Until now every screen imported `joinRoom` straight from socket-transport.js,
 * so "which transport is this app on?" was answered four times in four files by
 * whatever each happened to import. transport/room.js is now the single answer.
 *
 * THE TEST THAT MATTERS IS THE LAST ONE. It pins the reason the chat path is
 * NOT routed through `createTransport()`: CentrifugoAdapter has no seal step, so
 * whatever payload it is handed goes on the wire verbatim. That is fine while it
 * only ever carries already-sealed bytes, and catastrophic the moment someone
 * "finishes the wiring" by pointing createNet at it — the app seals inside
 * socket-transport.js, BELOW the adapter, so nothing would seal at all and the
 * server would receive plaintext. FORBIDDEN_KEY_SURFACE cannot catch that: it
 * asserts an adapter holds no key, which a keyless adapter trivially satisfies.
 *
 * If someone adds sealing to CentrifugoAdapter, the last check here fails. That
 * failure is the signal to revisit transport/room.js, not to edit this file.
 */
import { mock } from 'node:test'

globalThis.window = {
  addEventListener () {},
  location: { origin: 'http://localhost:5173', hostname: 'localhost', pathname: '/', href: 'http://localhost:5173/', protocol: 'http:', host: 'localhost:5173' }
}
globalThis.location = globalThis.window.location
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }
globalThis.localStorage = {
  _d: new Map(),
  getItem (k) { return this._d.get(k) ?? null },
  setItem (k, v) { this._d.set(k, String(v)) },
  removeItem (k) { this._d.delete(k) },
  key (i) { return [...this._d.keys()][i] ?? null },
  get length () { return this._d.size }
}

/* Every room the fake transport was asked for, with the config it was given —
 * so the seam can be checked for passing the caller's secret through untouched. */
const joins = []

/* A file:// URL, not a cwd path — mock.module matches on the resolved specifier,
 * and a plain path silently fails to apply. When it does, the REAL transport
 * loads and its guest-auth loop polls for a profile that never arrives, so the
 * symptom is a hung test rather than an error. */
const SRC = new URL('../src/', import.meta.url).href

mock.module(`${SRC}lib/socket-transport.js`, {
  namedExports: {
    joinRoom: (config, roomId) => {
      joins.push({ config, roomId })
      return { DURABLE: true, roomId, makeAction: () => ({ send () {} }), getPeers: () => ({}), leave () {} }
    },
    selfId: 'seam-test-self',
    serverMode: true,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    /* Phase 5: media-transfer.js imports these, and a PARTIAL ESM module mock
     * fails at LINK time with a SyntaxError, not at call time — so every export
     * the module graph reaches has to be present even when unused here. */
    sealForRoom: async (_room, bytes) => bytes,
    openForRoom: async (_room, bytes) => bytes,
    freshTokens: async () => ({ accessToken: 'seam-test-token' })
  }
})

const { joinRoom, activeTransport } = await import('../src/lib/transport/room.js')
const { setTransport } = await import('../src/lib/transport/index.js')
const { createCentrifugoAdapter } = await import('../src/lib/transport/centrifugo-adapter.js')

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

/* ===================== the seam decides, in one place ===================== */

check('an unset flag joins on the default transport, with no fallback to report', () => {
  localStorage.removeItem('spotme.transport')
  joins.length = 0
  const room = joinRoom({ appId: 'io.ysnapai.spotme', password: 'secret-a' }, 'room-default')
  const report = activeTransport()
  return !!room && joins.length === 1 && report.requested === 'socketio' &&
    report.actual === 'socketio' && report.reason === null
})

check('the caller’s room secret is passed through untouched', () => {
  joins.length = 0
  joinRoom({ appId: 'io.ysnapai.spotme', password: 'secret-b', rtcConfig: { iceServers: [] } }, 'room-secret')
  return joins[0].config.password === 'secret-b' && joins[0].roomId === 'room-secret'
})

check('an explicit socketio selection is honoured as itself', () => {
  setTransport('socketio')
  joinRoom({ password: 'x' }, 'room-socketio')
  const report = activeTransport()
  return report.requested === 'socketio' && report.actual === 'socketio' && report.reason === null
})

check('p2p cannot be selected — the escape hatch is removed (ADR-033)', () => {
  try { setTransport('p2p'); return false } catch { /* expected */ }
  // A legacy device with the flag already stored still gets the server path.
  localStorage.setItem('spotme.transport', 'p2p')
  const room = joinRoom({ password: 'x' }, 'room-legacy-p2p-flag')
  const report = activeTransport()
  return !!room && report.requested === 'socketio' && report.actual === 'socketio'
})

/* ================== asking for centrifugo is not silent ================== */

check('asking for centrifugo still returns a working room — the app never dies', () => {
  setTransport('centrifugo')
  const room = joinRoom({ password: 'x' }, 'room-centrifugo')
  return !!room && typeof room.makeAction === 'function'
})

check('…but it did NOT get centrifugo, and the report says so', () => {
  const report = activeTransport()
  return report.requested === 'centrifugo' && report.actual === 'socketio'
})

check('…and the reason names plaintext, not just "unavailable"', () => {
  const { reason } = activeTransport()
  return typeof reason === 'string' && /plaintext/i.test(reason)
})

check('an unknown flag value falls back to the default rather than throwing', () => {
  localStorage.setItem('spotme.transport', 'quic-over-carrier-pigeon')
  const room = joinRoom({ password: 'x' }, 'room-unknown')
  return !!room && activeTransport().actual === 'socketio'
})

/* ============ WHY the chat path is not wired to the adapters ============ */

await checkAsync('CentrifugoAdapter puts its payload on the wire VERBATIM — it cannot seal', async () => {
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, status: 200, json: async () => ({}) }
  }
  try {
    const adapter = createCentrifugoAdapter({ url: 'ws://127.0.0.1:1/connection/websocket' })
    // The exact hazard: hand it something a human could read.
    await adapter.publish('room-plain', { type: 'msg', payload: 'MEET ME AT SIX' })
  } finally {
    globalThis.fetch = realFetch
  }
  // It reached the server unchanged. Sealing happens BELOW this layer, inside
  // socket-transport.js, so an adapter fed raw text ships raw text.
  return sent.length === 1 && sent[0].body.payload === 'MEET ME AT SIX'
})

check('so the seam never hands a room to a keyless adapter, whatever the flag says', () => {
  // The invariant, stated as itself rather than as a count: the rooms opened
  // while the flag asked for centrifugo — and while it held a value nobody
  // recognises — still went to the Socket.IO transport, which seals.
  const landed = joins.map((j) => j.roomId)
  return landed.includes('room-centrifugo') && landed.includes('room-unknown')
})

/* ------------------------------------------------------------- report --- */

const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  transport seam — one decision, visible')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
if (passed !== names.length) process.exit(1)
