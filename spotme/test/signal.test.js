/**
 * Ephemeral signals — typing and read receipts that must never become history.
 *
 * Two properties matter, and both are load-bearing for the chat thread UI:
 *   1. A signal sent by either peer reaches the other over a live connection.
 *   2. A signal NEVER shows up in transcript() — it is not an op, and a
 *      regression that accidentally logged it forever would leak read-state
 *      into the permanent record.
 *
 * Also proves the property the design depends on: a peer who has only joined
 * (read-only, not yet invited) can still send a signal. That works because
 * the signal extension is registered on the view core, which Autobase gives
 * the SAME key across every peer of one room — unlike a writer's own core,
 * the view replicates from the moment two peers connect, before any invite.
 *
 *   node test/signal.test.js
 */
const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const { Room } = require('../core/room')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spotme-signal-'))
const results = {}
const check = (name, value) => { results[name] = value === true }

const cleanup = () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* Windows holds core file handles briefly after close */
  }
}

/** Signals are not ops — there is no update()/transcript() to poll for them. */
async function waitForSignal (received, { attempts = 30, interval = 100 } = {}) {
  for (let i = 0; i < attempts && received.length === 0; i++) {
    await new Promise((r) => setTimeout(r, interval))
  }
  return received.length > 0
}

async function main () {
  // ------------------------------------------------------------ Alice
  const storeA = new Corestore(path.join(tmp, 'alice'))
  await storeA.ready()
  const alice = await Room.create(storeA, { identity: 'alice' })
  await alice.post('hi', { lang: 'en' })
  await alice.update()

  // -------------------------------------------------------------- Bob
  const storeB = new Corestore(path.join(tmp, 'bob'))
  await storeB.ready()
  const bob = await Room.join(storeB, alice.key, { identity: 'bob' })

  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  await bob.waitFor((r) => r.length >= 1)

  // ---------------------------------------- read-only peer sends a signal
  check('bobStillReadOnly', bob.writable === false)

  const aliceReceived = []
  const unsubAlice = alice.onSignal((msg) => aliceReceived.push(msg))
  bob.sendSignal({ type: 'read', upTo: 12345 })

  check('readOnlyPeerSignalDelivered', await waitForSignal(aliceReceived))
  check('readOnlyPeerSignalPayloadIntact',
    aliceReceived[0]?.type === 'read' && aliceReceived[0]?.upTo === 12345)

  const afterSignalTranscript = await alice.transcript()
  check('signalNeverEntersTranscript', afterSignalTranscript.length === 1)

  // ------------------------------------------------- invite, then signal both ways
  await alice.invite(bob.writerKey)
  await alice.update()
  await bob.waitFor((r) => r.writable)

  const bobReceived = []
  const unsubBob = bob.onSignal((msg) => bobReceived.push(msg))
  alice.sendSignal({ type: 'typing', on: true })

  check('writerToWriterSignalDelivered', await waitForSignal(bobReceived))
  check('writerSignalPayloadIntact', bobReceived[0]?.type === 'typing' && bobReceived[0]?.on === true)

  const finalTranscript = await alice.transcript()
  check('transcriptUnaffectedByAnySignal', finalTranscript.length === 1)

  unsubAlice()
  unsubBob()

  // ------------------------------------------------------------ report
  console.log('\n================ RESULT ================')
  for (const [name, passed] of Object.entries(results)) {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
  const ok = Object.values(results).every(Boolean)
  const count = Object.values(results).filter(Boolean).length
  console.log(`\n${count}/${Object.keys(results).length}`)
  console.log('verdict :', ok
    ? 'SIGNALS WORK - ephemeral messages deliver and never touch the transcript'
    : 'SOMETHING FAILED')
  console.log('========================================')

  await alice.close()
  await bob.close()
  await storeA.close()
  await storeB.close()
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('fatal:', err)
  cleanup()
  process.exit(1)
})
