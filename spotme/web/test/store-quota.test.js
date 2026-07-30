/**
 * The store under storage pressure, and how often it writes.
 *
 * Two bugs are pinned here, both measured on a real device before they were
 * understood:
 *
 *   1. THE SENDER LOSES THEIR OWN VOICE NOTES. On QuotaExceededError save()
 *      sheds the HEAVIEST media first and rewrites it as {data:null,
 *      detached:true}. That rule was written for videos and is right for them,
 *      but a voice note at 16 KB/s is now the heaviest thing in an ordinary
 *      chat — so the rule started eating the user's own recordings. Measured:
 *      after nine 30-second notes the first one came back from a reload as
 *      "Voice note — tap to load", in the sender's own thread. Everything
 *      received can be re-sent by the person who sent it; a recording made
 *      here has only this device and the server log. Theirs goes first.
 *
 *      Worse, the shed only ever touched the SERIALISED copy — the in-memory
 *      Map kept its bytes, so nothing looked wrong until the next reload, days
 *      later. It has to say so out loud when it happens.
 *
 *   2. SEND LATENCY GREW WITH THE CONVERSATION. Every add and patch
 *      re-stringified the whole room, and one attachment fires several
 *      patches: 279ms -> 901ms over twenty voice notes, monotonically. Writes
 *      are coalesced now, so a burst costs one serialisation, and every way a
 *      page can go away flushes the pending one.
 *
 *   node test/store-quota.test.js
 */

/* --------------------------------------------------------- browser shim */
/* A localStorage with a hard byte cap, which is the whole point: the real
 * failure only appears when setItem actually throws. Chromium and iOS Safari
 * both sit around 5 MB per origin. */
const QUOTA = 5 * 1024 * 1024
const mem = new Map()
let writes = 0

function used (exceptKey) {
  let n = 0
  for (const [k, v] of mem) if (k !== exceptKey) n += k.length + v.length
  return n
}

globalThis.localStorage = {
  get length () { return mem.size },
  key: (i) => Array.from(mem.keys())[i] ?? null,
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => {
    const value = String(v)
    writes += 1
    if (used(k) + k.length + value.length > QUOTA) {
      const error = new Error('QuotaExceededError')
      error.name = 'QuotaExceededError'
      throw error
    }
    mem.set(k, value)
  },
  removeItem: (k) => mem.delete(k)
}

const { createStore } = await import('../src/store.js')

/* ------------------------------------------------------------- harness */
const results = {}
const check = (name, value) => { results[name] = value === true }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** Longer than SAVE_DEBOUNCE_MS, so a pending write has certainly landed. */
const settle = () => wait(400)

const ME = 'me-id'
const THEM = 'them-id'

/** A voice note whose data URL is `chars` long — the size is the bug. */
const note = (id, from, chars) => ({
  id,
  from,
  name: from === ME ? 'Me' : 'Them',
  ts: Number(id.split('-')[1]) || 1,
  kind: 'voice',
  text: '',
  dur: 30,
  mime: 'audio/webm',
  data: 'data:audio/webm;base64,' + 'A'.repeat(chars)
})

const onDisk = (key) => JSON.parse(localStorage.getItem(key) || '{"messages":[]}').messages

async function main () {
  /* ------------------------------------------------------------------ 1 */
  /* THE HEART OF IT. A voice-heavy room that cannot fit: eight 30-second
   * notes, four from each side, against a 5 MB quota. Something must be shed.
   * It must not be the four this device recorded. */
  const shed = []
  const roomA = createStore('quota-a', 'spotme:test:', {
    selfId: () => ME,
    onShed: (info) => shed.push(info)
  })

  /* Sizes at the measured 16 KB/s: ~55s of mine, ~30s of theirs, base64'd.
   * MINE IS DELIBERATELY THE HEAVIEST — that is the whole failure. The old
   * rule was "shed heaviest first", so the longer the note you recorded, the
   * surer it was to be the one thrown away. Eight of these overrun 5 MB, which
   * is the only condition under which any of this code runs at all. */
  const MINE_BYTES = 900_000
  const THEIRS_BYTES = 500_000
  for (let i = 1; i <= 8; i++) {
    const from = i % 2 ? THEM : ME
    roomA.add(note(`n-${i}`, from, from === ME ? MINE_BYTES : THEIRS_BYTES))
  }
  await settle()

  const stored = onDisk('spotme:test:quota-a')
  const survived = (from) => stored.filter((m) => m.from === from && typeof m.data === 'string').length
  const detached = (from) => stored.filter((m) => m.from === from && m.detached === true).length

  check('the conversation still persists when it does not fit', stored.length === 8)
  check('something had to be shed', detached(ME) + detached(THEM) > 0)
  check('THE BUG: not one of the notes recorded on this device is shed', detached(ME) === 0)
  check('all four of my own recordings keep their audio', survived(ME) === 4)
  check('their media is what gets sacrificed', detached(THEM) > 0)

  /* The shed is invisible in memory by design — that is why it has to be
   * announced. Both halves are asserted: memory intact, and somebody told. */
  check('memory keeps every byte, so the tab shows nothing wrong',
    roomA.list().every((m) => typeof m.data === 'string'))
  check('a shed is reported rather than discovered on the next reload', shed.length > 0)
  check('the report says how much went', shed.at(-1)?.count > 0)
  check('the report says none of it was mine', shed.at(-1)?.own === 0)

  /* ------------------------------------------------------------------ 2 */
  /* Only when there is nothing of theirs left may it touch mine — and then it
   * must say THAT, because it is a different sentence to the user. */
  mem.clear()
  const mineOnly = []
  const roomB = createStore('quota-b', 'spotme:test:', {
    selfId: () => ME,
    onShed: (info) => mineOnly.push(info)
  })
  for (let i = 1; i <= 8; i++) roomB.add(note(`m-${i}`, ME, 700_000))
  await settle()

  const storedB = onDisk('spotme:test:quota-b')
  check('a room of only my own media still persists', storedB.length === 8)
  check('mine is shed when there is nothing else to give',
    storedB.some((m) => m.detached === true))
  check('the newest recordings are the ones kept',
    typeof storedB.at(-1).data === 'string')
  check('losing my own recording is reported as mine', mineOnly.at(-1)?.own > 0)

  /* A shed that does not get worse must not nag on every subsequent write. */
  const announced = mineOnly.length
  roomB.add({ id: 'text-1', from: ME, ts: 99, kind: 'text', text: 'hello' })
  await settle()
  check('a room parked at the quota does not re-announce', mineOnly.length === announced)

  /* ------------------------------------------------------------------ 3 */
  /* A shed message keeps everything except the bytes, so "tap to load" can
   * actually go and get them back. Losing the mime would leave the fetch
   * guessing image/jpeg for a voice note. */
  const shedRow = storedB.find((m) => m.detached === true)
  check('a shed message keeps its id', typeof shedRow.id === 'string')
  check('a shed message keeps its mime so it can be fetched back',
    shedRow.mime === 'audio/webm')
  check('a shed message is marked detached, not deleted', shedRow.data === null)

  /* ------------------------------------------------------------------ 4 */
  /* Write coalescing. Twenty adds in one tick used to mean twenty full
   * serialisations of a growing conversation; it is one now. */
  mem.clear()
  writes = 0
  const roomC = createStore('burst', 'spotme:test:')
  for (let i = 0; i < 20; i++) {
    roomC.add({ id: `b-${i}`, from: ME, ts: i, kind: 'text', text: `msg ${i}` })
  }
  check('a burst of adds does not write once per add', writes === 0)
  await settle()
  check('the burst lands as a single write', writes === 1)
  check('every message in the burst is persisted', onDisk('spotme:test:burst').length === 20)

  /* ------------------------------------------------------------------ 5 */
  /* Coalescing must never be able to lose the tail. flush() is what pagehide,
   * beforeunload and a hidden tab all call. */
  writes = 0
  roomC.add({ id: 'last', from: ME, ts: 999, kind: 'text', text: 'goodbye' })
  roomC.flush()
  check('flush writes immediately rather than waiting', writes === 1)
  check('the flushed message is on disk',
    onDisk('spotme:test:burst').some((m) => m.id === 'last'))
  writes = 0
  await settle()
  check('a flushed write is not repeated when the timer fires', writes === 0)

  /* ------------------------------------------------------------------ 6 */
  /* clear() must win against a write that is already queued, or wiping a
   * conversation would silently bring it back 250ms later. */
  roomC.add({ id: 'ghost', from: ME, ts: 1000, kind: 'text', text: 'boo' })
  roomC.clear()
  await settle()
  check('a cleared room stays cleared', localStorage.getItem('spotme:test:burst') === null)
}

await main()

/* ------------------------------------------------------------- report */
const names = Object.keys(results)
const passed = names.filter((n) => results[n]).length
console.log('\n========================================')
console.log('  store — quota shedding and write cost')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
