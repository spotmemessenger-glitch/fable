/**
 * Live Nearby Events detail — open/close state machine; ready without a
 * provider; loading→ready/unavailable with one; invents nothing.
 *   node test/live-events-detail.test.js
 */
import { createEventDetail, DETAIL_STATE } from '../src/lib/live-events/detail.js'

const results = {}
const names = []
const check = (name, pass) => { names.push(name); results[name] = pass === true }

const EV = { id: 'p:1', title: 'Show', lat: 1, lon: 2 }

async function run () {
  check('starts CLOSED', (() => createEventDetail().snapshot().status === DETAIL_STATE.CLOSED)())

  check('open with NO provider → immediately READY (no endless spinner)', await (async () => {
    const d = createEventDetail()
    const s = await d.open(EV)
    return s.status === DETAIL_STATE.READY && s.event.id === 'p:1'
  })())

  check('open with a provider → READY, merging returned fields', await (async () => {
    const d = createEventDetail()
    const provider = { name: 'x', detail: async () => ({ description: 'full text', lineup: ['a'] }) }
    const s = await d.open(EV, { provider })
    return s.status === DETAIL_STATE.READY && s.event.description === 'full text' &&
      Array.isArray(s.event.lineup) && s.event.id === 'p:1'
  })())

  check('a provider cannot blank required fields (id preserved)', await (async () => {
    const d = createEventDetail()
    const provider = { name: 'x', detail: async () => ({ id: 'HACKED', title: null }) }
    const s = await d.open(EV, { provider })
    return s.event.id === 'p:1'
  })())

  check('a THROWING detail provider → UNAVAILABLE (not a crash)', await (async () => {
    const d = createEventDetail()
    const provider = { name: 'x', detail: async () => { throw new Error('down') } }
    const s = await d.open(EV, { provider })
    return s.status === DETAIL_STATE.UNAVAILABLE
  })())

  check('opening a null event → UNAVAILABLE', await (async () => {
    const d = createEventDetail()
    const s = await d.open(null)
    return s.status === DETAIL_STATE.UNAVAILABLE
  })())

  check('close returns to CLOSED and clears the event', await (async () => {
    const d = createEventDetail()
    await d.open(EV)
    d.close()
    const s = d.snapshot()
    return s.status === DETAIL_STATE.CLOSED && s.event === null
  })())

  check('subscribers are notified with immutable snapshots', await (async () => {
    const d = createEventDetail()
    let last = null; let count = 0
    d.subscribe((s) => { last = s; count++ })
    await d.open(EV)
    return count >= 1 && last.event.id === 'p:1'
  })())

  console.log('\n========== live-events detail ==========')
  for (const n of names) console.log(`  ${results[n] ? 'PASS' : 'FAIL'}  ${n}`)
  const passed = names.filter((n) => results[n]).length
  console.log(`  ${passed}/${names.length} passed\n`)
  process.exit(passed === names.length ? 0 : 1)
}

run()
