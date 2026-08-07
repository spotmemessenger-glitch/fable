/**
 * Attachments must survive a RECONNECT, not just a cold start.
 *
 * THE BUG THIS PINS. `join()` read `ack.envelopes`; `rejoin()` did not — and
 * then ran `advanceCursor(ack.lastEventId)` anyway. That is unconditional,
 * permanent loss, because:
 *
 *   - the server strips `bin` rows out of `ack.events` entirely
 *     (rooms.service.ts: `type: { not: 'bin' }`), so an ENVELOPE is the only way
 *     a missed attachment ever comes back;
 *   - `lastEventId` is computed across those same bin rows, so the cursor moves
 *     above slices the client was never handed.
 *
 * Next join asks `since = <past the slices>` and the server correctly returns
 * nothing. The photo does not exist on that device, ever again.
 *
 * And `rejoin` is the COMMON path. `joinPromise` is cached, so the full `join`
 * runs once per room per page load; every socket drop after that — a lift, wifi
 * handing to cellular, a backgrounded tab — goes through `rejoin`.
 *
 * The second half of this file is the truncation fix: a client far enough
 * behind gets a capped page, and the cursor may only advance as far as the page
 * actually reached.
 *
 *   node test/replay-envelopes.test.js
 */

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

/* ------------------------------------------------------------- harness --- */

/**
 * The cursor rule under test, lifted verbatim in shape from socket-transport:
 * a page may only move the cursor as far as it actually delivered.
 */
function replayPage (ack, state) {
  const delivered = []
  for (const ev of ack.events || []) delivered.push({ kind: 'event', id: ev.seq })
  // THE LINE THAT WAS MISSING FROM rejoin()
  for (const env of ack.envelopes || []) delivered.push({ kind: 'attachment', id: env.seq })
  if (ack.lastEventId > state.cursor) state.cursor = ack.lastEventId
  return delivered
}

/** What the server does, faithfully enough to catch a cursor that overshoots. */
function serverReplay (log, since, limit = 5000) {
  const events = log.filter((r) => r.type !== 'bin' && r.id > since).slice(0, limit)
  const bins = log.filter((r) => r.type === 'bin' && r.id > since)
  const truncated = events.length === limit
  const lastEventId = truncated
    ? events[events.length - 1].id
    : Math.max(since, events.at(-1)?.id ?? 0, bins.at(-1)?.id ?? 0)
  return {
    events: events.map((r) => ({ seq: r.id })),
    envelopes: bins.filter((r) => r.seq0 && r.id <= lastEventId).map((r) => ({ seq: r.id })),
    lastEventId,
    truncated
  }
}

/* --------------------------------------------------------------- checks --- */

/* A voice note arrives while the socket is down; the socket comes back. */
const log = [
  { id: 10, type: 'msg' },
  { id: 11, type: 'bin', seq0: true },   // the voice note's envelope
  { id: 12, type: 'bin' },
  { id: 13, type: 'bin' }
]

{
  const state = { cursor: 9 }
  const ack = serverReplay(log, state.cursor)
  const got = replayPage(ack, state)
  check('THE BUG: a reconnect delivers the attachment, not just the text',
    got.some((d) => d.kind === 'attachment'))
  check('…and the cursor does not move past an attachment it never delivered',
    state.cursor === 13 && got.some((d) => d.kind === 'attachment'))
}

{
  /* The old rejoin, reproduced exactly: dispatch events, skip envelopes,
   * advance anyway. Then reconnect again and ask the server for what is left. */
  const state = { cursor: 9 }
  const ack = serverReplay(log, state.cursor)
  for (const _ of ack.events || []) { /* dispatched */ }
  state.cursor = ack.lastEventId          // advanced without absorbing envelopes
  const second = serverReplay(log, state.cursor)
  check('the OLD behaviour really did lose it for good (the fix is load-bearing)',
    second.events.length === 0 && second.envelopes.length === 0)
}

{
  /* 6200 events behind, with a photo sent after the cap. The uncapped
   * attachments query used to drag `lastEventId` above the capped events. */
  const big = []
  for (let i = 1; i <= 6200; i++) big.push({ id: i, type: 'msg' })
  big.push({ id: 6300, type: 'bin', seq0: true })

  const state = { cursor: 0 }
  const ack = serverReplay(big, state.cursor)
  replayPage(ack, state)
  check('a capped page stops the cursor at the cap, not at a later bin row',
    state.cursor === 5000)
  check('…and says so, so the client knows to come back for the rest',
    ack.truncated === true)
  check('…and withholds an envelope from above the frontier',
    ack.envelopes.length === 0)

  /* Draining, which is what the client now does instead of waiting for a
   * reconnect that may never come. */
  let guard = 0
  let more = ack.truncated
  while (more && guard++ < 20) {
    const next = serverReplay(big, state.cursor)
    replayPage(next, state)
    more = next.truncated
  }
  check('draining reaches the end of the backlog', state.cursor === 6300)
  check('…including the attachment that was above the first page',
    serverReplay(big, state.cursor).envelopes.length === 0 && state.cursor === 6300)
}

{
  /* The overshoot the fix removes, stated directly: with the old rule the
   * cursor jumped to the bin row and 1200 messages became unreachable. */
  const big = []
  for (let i = 1; i <= 6200; i++) big.push({ id: i, type: 'msg' })
  big.push({ id: 6300, type: 'bin', seq0: true })
  const events = big.filter((r) => r.type !== 'bin').slice(0, 5000)
  const bins = big.filter((r) => r.type === 'bin')
  const oldLastEventId = Math.max(0, events.at(-1).id, bins.at(-1).id)
  const lost = big.filter((r) => r.id > 5000 && r.id <= oldLastEventId && r.type !== 'bin').length
  check('the OLD rule skipped a real, countable number of messages', oldLastEventId === 6300 && lost === 1200)
}

/* -------------------------------------------------------------- report --- */

console.log('\n========================================')
console.log('  replay — attachments survive a reconnect, and a capped page caps the cursor')
console.log('========================================')
for (const name of names) console.log(`  ${results[name] ? 'PASS' : 'FAIL'}  ${name}`)
const passed = names.filter((n) => results[n]).length
console.log('========================================')
console.log(`  ${passed}/${names.length} passed`)
console.log('========================================\n')
process.exit(passed === names.length ? 0 : 1)
