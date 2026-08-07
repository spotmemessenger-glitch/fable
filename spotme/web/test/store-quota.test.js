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
  /* THE RULE THAT REPLACED THE SHEDDING LADDER: media bytes never reach
   * localStorage at all.
   *
   * This suite used to assert that when a voice-heavy room overran the quota,
   * the ladder shed THEIR media before MINE. That ordering was right and the
   * premise was wrong. A data URL is base64 — ~1.33x the file — against a
   * quota of 5-10 MB, so one 40 MB video serialised to ~53 MB, `setItem` threw,
   * and the ladder existed to recover from a write that should never have been
   * attempted. It still had to destroy somebody's recording to succeed, and it
   * only ran after the entire conversation had failed to persist once.
   *
   * Now the bytes are held in memory and made durable in IndexedDB. The
   * persisted copy carries a reference. Nothing is shed because nothing
   * oversized is ever written.
   *
   * The ladder itself is NOT deleted — a room can still overrun on text alone,
   * and private mode still refuses IndexedDB — but it is no longer reachable
   * by media, and this asserts exactly that. */
  const shed = []
  const roomA = createStore('quota-a', 'spotme:test:', {
    selfId: () => ME,
    onShed: (info) => shed.push(info)
  })

  const MINE_BYTES = 900_000
  const THEIRS_BYTES = 500_000
  for (let i = 1; i <= 8; i++) {
    const from = i % 2 ? THEM : ME
    roomA.add(note(`n-${i}`, from, from === ME ? MINE_BYTES : THEIRS_BYTES))
  }
  await settle()

  const stored = onDisk('spotme:test:quota-a')
  const rawDisk = localStorage.getItem('spotme:test:quota-a') || ''

  check('the conversation persists in full', stored.length === 8)
  check('THE INVARIANT: not one base64 payload reached localStorage',
    !rawDisk.includes('data:'))
  check('…and the persisted copy is small enough that the quota is not in play',
    rawDisk.length < 200_000)
  check('every media message is kept as a reference, not deleted',
    stored.filter((m) => m.memoryOnly === true).length === 8)
  check('each reference keeps its id, so the bytes can be matched back',
    stored.every((m) => typeof m.id === 'string'))
  check('each reference keeps its mime, so a fetch is not left guessing',
    stored.every((m) => m.mime === 'audio/webm'))
  check('nothing was shed, because nothing overflowed', shed.length === 0)
  check('NOBODY LOSES A RECORDING — not theirs, and not mine',
    stored.every((m) => m.detached !== true))

  /* The bytes are still on screen for this session; only the disk copy is a
   * reference. A reader mid-conversation sees no change at all. */
  check('memory keeps every byte, so the tab shows nothing wrong',
    roomA.list().every((m) => typeof m.data === 'string'))

  /* ------------------------------------------------------------------ 2 */
  /* Symmetry: a room of only MY OWN media behaves identically. Under the old
   * ladder this was the painful case — my own recordings were the heaviest, so
   * heaviest-first ate them first. Now there is no ladder to run. */
  mem.clear()
  const mineOnly = []
  const roomB = createStore('quota-b', 'spotme:test:', {
    selfId: () => ME,
    onShed: (info) => mineOnly.push(info)
  })
  for (let i = 1; i <= 8; i++) roomB.add(note(`m-${i}`, ME, 700_000))
  await settle()

  const storedB = onDisk('spotme:test:quota-b')
  check('a room of only my own media persists in full', storedB.length === 8)
  check('not one of my own recordings is shed', storedB.every((m) => m.detached !== true))
  check('and nothing is announced, because nothing was lost', mineOnly.length === 0)

  /* ------------------------------------------------------------------ 3 */
  /* A reference keeps everything except the bytes, so recovery can find them. */
  const refRow = storedB[0]
  check('a reference keeps its id', typeof refRow.id === 'string')
  check('a reference keeps its mime', refRow.mime === 'audio/webm')
  check('a reference carries no payload', refRow.data === null)
  check('a reference is marked memory-only, NOT detached',
    refRow.memoryOnly === true && refRow.detached !== true)


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
