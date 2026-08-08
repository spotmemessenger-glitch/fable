/**
 * Chat characterization — pins the OBSERVABLE behaviour the React chat slice
 * (ADR-035, final slice) must reproduce, at the lib/rooms.js + view-contract
 * level. Written BEFORE any React code, per the slice plan: these assert what
 * the code DOES today, not what it should do.
 *
 * What is deliberately NOT here: send-failure/retry (send-failure-visible,
 * send-retry), media slicing (media, media-transfer), view-once burn
 * (viewonce), request gating (requests) — already pinned by their own suites.
 * This file pins the flows chat.js composes on top of the engine:
 *
 *   - outgoing envelope shape and thread ordering
 *   - incoming message → preview/unread/ordering
 *   - per-kind preview grammar (the inbox row + notification body)
 *   - reply metadata (replyTo) riding the envelope untouched
 *   - the translation envelope (text swapped, tr carries the original)
 *   - read receipts: monotonic readUpTo, and the view's Read/Sent derivation
 *   - typing indicator lifecycle
 *   - edit semantics (author-only, marked, preview follows)
 *   - delete on both sides
 *   - reactions aggregate on the target message
 *   - disappearing-message timer control (either side sets, both obey)
 *   - view-contract text pins: day divider + tick derivation in chat.js
 *
 *   node --experimental-test-module-mocks --no-warnings test/chat-characterization.test.js
 */
import { mock } from 'node:test'
import { readFileSync } from 'node:fs'

const SRC = new URL('../src/', import.meta.url).href

/* --------------------------------------------------------- browser shim */
globalThis.location = { hostname: 'localhost', href: 'http://localhost/?id=chatchar' }
globalThis.window = { location: globalThis.location, addEventListener () {} }
globalThis.document = { addEventListener () {}, visibilityState: 'visible' }
const mem = new Map()
globalThis.localStorage = {
  get length () { return mem.size },
  key: (i) => Array.from(mem.keys())[i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k)
}
globalThis.atob = (b64) => Buffer.from(b64, 'base64').toString('binary')
globalThis.btoa = (bin) => Buffer.from(bin, 'binary').toString('base64')

/* ------------------------------------------------------- fake transport */
const actions = {}
function makeAction (name) {
  const action = {
    sends: [],
    send: (payload, opts) => {
      action.sends.push({ payload, metadata: opts?.metadata ?? null })
      opts?.onProgress?.(1)
      return Promise.resolve()
    },
    onMessage: null,
    onReceiveProgress: null,
    request: () => Promise.resolve(null)
  }
  actions[name] = action
  return action
}
const fakeRoom = {
  makeAction,
  getPeers: () => ({}),
  addStream: () => {}, removeStream: () => {}, replaceTrack: () => {},
  onPeerJoin: null, onPeerLeave: null, onPeerStream: null, onUndecryptable: null,
  leave: () => {}
}

mock.module(`${SRC}lib/socket-transport.js`, {
  namedExports: {
    joinRoom: () => fakeRoom,
    selfId: 'self-id',
    serverMode: false,
    setRoomKey: () => {},
    setRoomKeyProvider: () => {},
    clearRoomKey: () => {},
    clearRoomCursor: () => {},
    sealForRoom: async (_roomId, bytes) => bytes,
    openForRoom: async (_roomId, bytes) => bytes,
    refreshRoomKey: async () => null,
    freshTokens: async () => ({ accessToken: 'test-token' })
  }
})
mock.module(`${SRC}lib/notify.js`, {
  namedExports: {
    pushNote: () => {}, alertMessage: () => {}, chime: () => {}, primeAudio: () => {}
  }
})

const { rooms } = await import(`${SRC}lib/rooms.js`)
const { db } = await import(`${SRC}lib/db.js`)

/* ------------------------------------------------------------- harness */
const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { for (let i = 0; i < 30; i++) await tick() }

const ROOM = 'dm-chatchar'
db.setProfile({ id: 'me-chat', name: 'Me', lang: 'en' })
db.upsertConvo({
  roomId: ROOM, secret: 'secret-chatchar', kind: 'dm',
  peer: { id: 'peer-chat', name: 'Peer', lang: 'ta' }
})

const conn = rooms.ensure(ROOM)
await settle()

const events = []
conn.on((e) => events.push(e))
const list = () => conn.store.list()
const incoming = (payload) => actions.msg.onMessage(payload, { peerId: 'peer-chat' })

/* ============================ outgoing envelope + ordering ============= */

const m1 = rooms.sendMessage(ROOM, { text: 'first' })
const m2 = rooms.sendMessage(ROOM, { text: 'second' })
await settle()

check('an outgoing text is stored immediately with the full envelope shape',
  m1 && m1.kind === 'text' && m1.text === 'first' &&
  m1.from === 'me-chat' && m1.name === 'Me' && m1.lang === 'en' &&
  typeof m1.id === 'string' && typeof m1.ts === 'number')
check('…and goes out over the msg action as the same envelope',
  actions.msg.sends.length === 2 && actions.msg.sends[0].payload.id === m1.id)
check('the thread lists messages in send order',
  list().map((m) => m.id).join(',') === `${m1.id},${m2.id}`)
check('sending bumps the convo preview as mine',
  db.convo(ROOM).last.text === 'second' && db.convo(ROOM).last.fromMe === true)

/* ============================ incoming message ========================= */

const inbound = { id: 'in-1', from: 'peer-chat', name: 'Peer', lang: 'ta', ts: Date.now(), kind: 'text', text: 'vanakkam' }
incoming(inbound)
await settle()

check('an incoming message appends to the thread in arrival order',
  list().at(-1)?.id === 'in-1')
check('…raises the unread count', (db.convo(ROOM).unread || 0) === 1)
check('…updates the preview as theirs',
  db.convo(ROOM).last.text === 'vanakkam' && db.convo(ROOM).last.fromMe === false)
check('…and emits a message event the view repaints from',
  events.some((e) => e.type === 'message' && e.message?.id === 'in-1'))
check('a duplicate id is refused — replay cannot double a bubble', (() => {
  const before = list().length
  incoming({ ...inbound })
  return list().length === before
})())

/* ============================ preview grammar ========================== */

const previewOf = (partial) => {
  incoming({ id: `pv-${Math.random()}`, from: 'peer-chat', name: 'Peer', ts: Date.now(), text: '', ...partial })
  return db.convo(ROOM).last.text
}
check('preview: photo', previewOf({ kind: 'image', data: 'data:image/png;base64,x' }) === 'Photo')
check('preview: private (view-once) photo', previewOf({ kind: 'image', viewOnce: true, data: 'data:image/png;base64,x' }) === 'Private photo')
check('preview: voice note carries its duration', previewOf({ kind: 'voice', dur: 7, data: 'data:audio/webm;base64,x' }) === 'Voice note (7s)')
check('preview: file falls back to its name', previewOf({ kind: 'file', fileName: 'notes.pdf', data: 'data:application/pdf;base64,x' }) === 'notes.pdf')
check('preview: location vs live location',
  previewOf({ kind: 'location', lat: 1, lon: 2 }) === 'Location' &&
  previewOf({ kind: 'location', live: true, lat: 1, lon: 2 }) === 'Live location')

/* ============================ reply + translation ====================== */

const reply = rooms.sendMessage(ROOM, { text: 'replying', replyTo: 'in-1' })
await settle()
check('replyTo rides the envelope untouched — store and wire agree',
  list().find((m) => m.id === reply.id)?.replyTo === 'in-1' &&
  actions.msg.sends.at(-1).payload.replyTo === 'in-1')

const translated = rooms.sendMessage(ROOM, { text: 'வணக்கம்', lang: 'ta', tr: { lang: 'en', text: 'hello' } })
await settle()
check('a translated send carries the translation and keeps the original in tr',
  translated.text === 'வணக்கம்' && translated.lang === 'ta' &&
  actions.msg.sends.at(-1).payload.tr?.text === 'hello' &&
  actions.msg.sends.at(-1).payload.tr?.lang === 'en')

/* ============================ read receipts ============================ */

rooms.markRead(ROOM)
await settle()
check('markRead sends an upTo timestamp receipt and clears unread',
  typeof actions.read.sends.at(-1)?.payload?.upTo === 'number' &&
  (db.convo(ROOM).unread || 0) === 0)

const now = Date.now()
actions.read.onMessage({ upTo: now }, { peerId: 'peer-chat' })
check('an incoming receipt raises readUpTo — the Read tick line', conn.readUpTo === now)
actions.read.onMessage({ upTo: now - 5000 }, { peerId: 'peer-chat' })
check('readUpTo is monotonic — a stale receipt cannot un-read a message', conn.readUpTo === now)
check('…and each advance emits a read event', events.filter((e) => e.type === 'read').length === 1)

/* ============================ typing =================================== */

actions.typing.onMessage({ on: true, name: 'Peer', kind: 'typing' }, { peerId: 'peer-chat' })
check('typing on: conn.typing carries name, kind and a ~4s deadline',
  conn.typing?.name === 'Peer' && conn.typing?.kind === 'typing' &&
  conn.typing.until > Date.now() && conn.typing.until <= Date.now() + 4100)
actions.typing.onMessage({ on: false }, { peerId: 'peer-chat' })
check('typing off clears it', conn.typing === null)

/* ============================ edit ===================================== */

const edited = rooms.editMessage(ROOM, m1.id, '  first, corrected  ')
await settle()
check('editing my own message trims, patches text and stamps editedAt',
  edited === 'first, corrected' &&
  list().find((m) => m.id === m1.id)?.text === 'first, corrected' &&
  typeof list().find((m) => m.id === m1.id)?.editedAt === 'number')
check('…and the correction goes out over the edit action',
  actions.edit.sends.at(-1)?.payload?.id === m1.id)
check('editing someone else\'s message is refused',
  rooms.editMessage(ROOM, 'in-1', 'forged') === null)
check('an incoming edit from a non-author is ignored', (() => {
  actions.edit.onMessage({ id: 'in-1', from: 'someone-else', text: 'forged' })
  return list().find((m) => m.id === 'in-1')?.text === 'vanakkam'
})())
check('an incoming edit from the author lands, marked', (() => {
  actions.edit.onMessage({ id: 'in-1', from: 'peer-chat', text: 'vanakkam!', editedAt: Date.now() })
  const m = list().find((x) => x.id === 'in-1')
  return m?.text === 'vanakkam!' && typeof m?.editedAt === 'number'
})())

/* ============================ delete + reactions ======================= */

rooms.deleteMessage(ROOM, m2.id)
await settle()
check('delete removes locally and sends the tombstone',
  !list().some((m) => m.id === m2.id) && actions.del.sends.at(-1)?.payload?.id === m2.id)
check('a deleted id cannot come back through the wire', (() => {
  incoming({ id: m2.id, from: 'peer-chat', name: 'Peer', ts: Date.now(), kind: 'text', text: 'zombie' })
  return !list().some((m) => m.id === m2.id)
})())

rooms.react(ROOM, 'in-1', '❤️')
actions.react.onMessage({ target: 'in-1', emoji: '👍', from: 'peer-chat' }, { peerId: 'peer-chat' })
await settle()
check('reactions from both sides aggregate on the target message', (() => {
  const r = list().find((m) => m.id === 'in-1')?.reactions || []
  return r.some((x) => x.emoji === '❤️' && x.from === 'me-chat') &&
    r.some((x) => x.emoji === '👍' && x.from === 'peer-chat')
})())

/* ============================ disappearing-timer control =============== */

actions.msg.onMessage({ id: 'sys-t', from: 'peer-chat', ts: Date.now(), kind: 'system', sys: 'timer', secs: 3600 }, { peerId: 'peer-chat' })
await settle()
check('either side setting the timer updates this convo\'s msgTtl (WhatsApp semantics)',
  db.convo(ROOM).msgTtl === 3600)
check('…and the system line previews as the timer notice',
  db.convo(ROOM).last.text === '⏱ Timer messages on')
rooms.sendMessage(ROOM, { id: 'sys-off', kind: 'system', sys: 'timer', secs: 0 })
await settle()
check('turning it off from this side clears msgTtl', (db.convo(ROOM).msgTtl || 0) === 0)

/* ============================ view-contract pins ======================= */
/* chat.js is 4,700 lines with no exports beyond render(); these pin the two
 * derivations the React message list must reproduce EXACTLY, as text. If one
 * fails, the contract moved — update the React port, not just this test. */

const chatSrc = readFileSync(new URL('../src/views/chat.js', import.meta.url), 'utf8')
check('view contract: the tick line derives Read from readUpTo >= ts, defaulting to Sent',
  /conn\.readUpTo >= m\.ts/.test(chatSrc) && /read \? 'Read' : 'Sent'/.test(chatSrc))
check('view contract: the day divider says Today for today, fmtDay otherwise',
  /toDateString\(\) === new Date\(\)\.toDateString\(\) \? 'Today' : fmtDay/.test(chatSrc))
check('view contract: a failed message renders Not delivered', /'Not delivered'/.test(chatSrc))
check('view contract: chat talks to the engine only through rooms/conn — no transport import',
  !/from '\.\.\/lib\/socket-transport\.js'/.test(chatSrc))

/* -------------------------------------------------------------- report */
console.log('\n========================================')
console.log('  chat characterization — the contract the React slice must match')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
if (passed !== names.length) process.exit(1)
process.exit(0)
