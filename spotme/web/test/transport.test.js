/**
 * Both adapters must satisfy the same contract — and neither may touch a key.
 *
 * The contract half is the obvious part. The second half is the one that
 * matters: ADR-001 stopped V-19 by giving `roomKey()` a provider with NO
 * password fallback for e2e_v2 rooms, and that defence lives in
 * socket-transport.js. A transport rewrite is the most plausible way to undo
 * it — an adapter that grows its own `deriveKey`/`roomKey`/`password` handling
 * would silently restore the cyrb53 key, both peers would degrade identically,
 * and nothing would surface. So "adapters carry opaque bytes" is asserted here
 * rather than asked for in a comment.
 *
 * Runs offline. `centrifuge` is imported dynamically by its adapter and is not
 * installed, which this file treats as a normal condition to be asserted, not
 * an obstacle to work around.
 */
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

const {
  TRANSPORT_METHODS, FORBIDDEN_KEY_SURFACE, TransportStatus,
  assertImplementsTransport, makeFrame
} = await import('../src/lib/transport/ITransportAdapter.js')
const { createSocketIOAdapter } = await import('../src/lib/transport/socketio-adapter.js')
const { createCentrifugoAdapter, roomChannel } = await import('../src/lib/transport/centrifugo-adapter.js')
const { TRANSPORT_KEYS, selectedTransport, setTransport, createTransport } =
  await import('../src/lib/transport/index.js')

const results = {}
const check = (name, fn) => {
  try { results[name] = fn() === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}
const checkAsync = async (name, fn) => {
  try { results[name] = (await fn()) === true } catch (e) { results[name] = false; results[`${name} (threw: ${e.message})`] = false }
}

const socketio = createSocketIOAdapter()
const centrifugo = createCentrifugoAdapter({ url: 'ws://127.0.0.1:1/connection/websocket' })

/* ========================== the contract itself ========================== */

check('SocketIOAdapter satisfies ITransportAdapter', () => {
  assertImplementsTransport(socketio, 'SocketIOAdapter')
  return true
})

check('CentrifugoAdapter satisfies ITransportAdapter', () => {
  assertImplementsTransport(centrifugo, 'CentrifugoAdapter')
  return true
})

check('both expose EXACTLY the contract methods, no drift', () => {
  for (const m of TRANSPORT_METHODS) {
    if (typeof socketio[m] !== 'function') return false
    if (typeof centrifugo[m] !== 'function') return false
  }
  return true
})

check('both report a legal TransportStatus before connecting', () => {
  return socketio.status() === TransportStatus.IDLE && centrifugo.status() === TransportStatus.IDLE
})

check('each adapter names itself, so a fallback is identifiable', () => {
  return socketio.name === 'socketio' && centrifugo.name === 'centrifugo'
})

/* ============ the assertion is real: it REJECTS a bad adapter ============ */

check('a missing method is rejected', () => {
  const broken = { ...socketio }
  delete broken.publish
  try { assertImplementsTransport(broken, 'broken'); return false } catch { return true }
})

check('a bogus status() is rejected', () => {
  try { assertImplementsTransport({ ...socketio, status: () => 'vibes' }, 'bogus'); return false } catch { return true }
})

check('a non-object is rejected', () => {
  for (const bad of [null, undefined, 'adapter', 42]) {
    try { assertImplementsTransport(bad, 'bad'); return false } catch { /* expected */ }
  }
  return true
})

/* =============== NO ADAPTER MAY TOUCH KEY MATERIAL (ADR-002 §2) ========== */

check('neither adapter exposes any key-shaped surface', () => {
  for (const banned of FORBIDDEN_KEY_SURFACE) {
    if (banned in socketio) return false
    if (banned in centrifugo) return false
  }
  return true
})

check('the key prohibition is enforced, not merely declared', () => {
  // Prove the check bites: an adapter that grew a roomKey() must be refused.
  const leaky = { ...socketio, roomKey: () => 'a key' }
  try { assertImplementsTransport(leaky, 'leaky'); return false } catch { return true }
})

check('every forbidden name is individually caught', () => {
  for (const banned of FORBIDDEN_KEY_SURFACE) {
    const leaky = { ...socketio, [banned]: () => {} }
    try { assertImplementsTransport(leaky, 'leaky'); return false } catch { /* expected */ }
  }
  return true
})

/* ============================== the frame =============================== */

check('a frame demands base64 TEXT, never binary', () => {
  try { makeFrame({ roomId: 'r', type: 'msg', payload: new Uint8Array([1, 2]) }); return false } catch { return true }
})

check('a frame requires roomId and type', () => {
  try { makeFrame({ type: 'msg' }); return false } catch { /* expected */ }
  try { makeFrame({ roomId: 'r' }); return false } catch { /* expected */ }
  return true
})

check('a well-formed frame passes through unchanged', () => {
  const f = makeFrame({ roomId: 'dm-abc', type: 'msg', payload: 'aGk=', meta: { seq: 1 } })
  return f.roomId === 'dm-abc' && f.type === 'msg' && f.payload === 'aGk=' && f.meta.seq === 1
})

/* ========================= runtime selection ============================ */

check('the default transport is socketio', () => {
  localStorage.removeItem('spotme.transport')
  return selectedTransport() === 'socketio'
})

check('an unknown stored value falls back to the default, it does not throw', () => {
  localStorage.setItem('spotme.transport', 'carrier-pigeon')
  return selectedTransport() === 'socketio'
})

check('setTransport accepts the known keys and rejects others', () => {
  for (const k of TRANSPORT_KEYS) if (setTransport(k) !== k) return false
  try { setTransport('smoke-signals'); return false } catch { return true }
})

/* ADR-033: the p2p escape hatch is REMOVED, and stays removed. These assert
 * absence — a PR that reintroduces the option must fail here. */

check('p2p is not a transport key any more (ADR-033)', () => {
  return !TRANSPORT_KEYS.includes('p2p')
})

check('setTransport refuses p2p (ADR-033)', () => {
  try { setTransport('p2p'); return false } catch { return true }
})

check('a stored legacy p2p flag falls back to the default (ADR-033)', () => {
  localStorage.setItem('spotme.transport', 'p2p')
  return selectedTransport() === 'socketio'
})

/* ===================== fallback must be VISIBLE ========================= */

await checkAsync('asking for centrifugo without the SDK falls back AND says so', async () => {
  setTransport('centrifugo')
  const { adapter, requested, actual, reason } = await createTransport({ url: 'ws://127.0.0.1:1/x' })
  // The point is not that it fell back — that is correct, a dead broker must
  // not mean a dead app. The point is that `actual` and `reason` make it
  // impossible to believe you were testing Centrifugo when you were not.
  return requested === 'centrifugo' && actual === 'socketio' &&
         typeof reason === 'string' && reason.length > 0 && adapter?.name === 'socketio'
})

await checkAsync('socketio is returned with no fallback reason', async () => {
  setTransport('socketio')
  const { adapter, requested, actual, reason } = await createTransport()
  return requested === 'socketio' && actual === 'socketio' && reason === null && adapter?.name === 'socketio'
})

/* ADR-033: no source file may import the removed P2P stack. An import is the
 * one thing a reintroduction cannot avoid, so it is what gets asserted. */
await checkAsync('no src file imports trystero (ADR-033)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const src = fileURLToPath(new URL('../src', import.meta.url))
  const offenders = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(js|mjs|ts)$/.test(name)) continue
      const text = readFileSync(p, 'utf8')
      if (/from\s+['"][^'"]*trystero|import\(\s*['"][^'"]*trystero/.test(text)) offenders.push(p)
    }
  }
  walk(src)
  if (offenders.length) console.error('  trystero imports found in:', offenders)
  return offenders.length === 0
})

/* ...AND NO TEST MAY NAME IT EITHER.
 *
 * The src-only fence above passed while the suite was broken. Five test files
 * still carried `mock.module('@trystero-p2p/torrent', …)` — defensive stubs
 * that threw if the P2P path was reached. Harmless while the package was
 * installed; fatal once ADR-033 removed it, because mock.module() has to
 * RESOLVE a specifier before it can stub it. `npm ci && npm test` therefore
 * died on ERR_MODULE_NOT_FOUND at the third file, and a fence that only looked
 * at src/ could not see it.
 *
 * A dependency is not removed until nothing references it, tests included. */
await checkAsync('no test file references trystero either (ADR-033)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = fileURLToPath(new URL('.', import.meta.url))
  const offenders = []
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(js|mjs|ts)$/.test(name)) continue
      const text = readFileSync(p, 'utf8')
      /* Comments are stripped first: this file and the cleaned suites EXPLAIN
       * the removed package by name, and prose must not read as a reference. */
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      /* Only SPECIFIER positions count — `mock.module('…')`, `from '…'`,
       * `import('…')`. A bare search for the word matched the fence above,
       * whose own regex literal spells it out, so this file failed itself. */
      if (/(?:mock\.module\(|from|import\()\s*['"][^'"]*trystero/.test(code)) offenders.push(p)
    }
  }
  walk(dir)
  if (offenders.length) console.error('  trystero references found in:', offenders)
  return offenders.length === 0
})

/* ============================== channels ================================ */

check('room channels are namespaced so the server ACL can mirror them', () => {
  return roomChannel('dm-abc') === 'room:dm-abc'
})

/* --------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  transport adapters — one contract')
console.log('========================================')
for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
