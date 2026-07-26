/**
 * Two independent rooms, open at once, in one process, over the REAL DHT.
 *
 * This is the direct precursor proof for the worklet rewrite that replaces
 * today's single global `store`/`room`/`swarm` with a `Map<localId, session>`
 * (see spotme/app/worklet/index.js) — before touching a device, prove the
 * underlying primitives (multiple Corestores, multiple Autobases, multiple
 * Hyperswarm instances) tolerate running concurrently in one process at all.
 *
 * Modelled on the actual target scenario: one phone (Alice) holds TWO
 * conversations open simultaneously, each with a different peer (Bob in
 * room 1, Carol in room 2). Asserts both:
 *   - neither room's swarm cross-talks with the other's peer
 *   - both rooms converge independently WHILE running concurrently, and each
 *     room's transcript stays free of the other room's messages
 *
 * Caveat carried over from swarm.test.js: all three identities run on ONE
 * machine. Discovery is genuinely remote; the transport may never leave
 * localhost.
 *
 *   node test/multiroom.test.js
 */
const os = require('os')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const { Room } = require('../core/room')
const { RoomSwarm } = require('../core/swarm')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spotme-multiroom-'))
const results = {}
const check = (name, value) => { results[name] = value === true }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const cleanup = () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* Windows holds core file handles briefly after close */
  }
}

async function waitForConvergence (a, b, { attempts = 60, interval = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await a.update()
    await b.update()
    const [va, vb] = [await a.transcript(), await b.transcript()]
    if (va.length > 0 && JSON.stringify(va) === JSON.stringify(vb)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

/** Open one side of a room + swarm, mirroring what a single worklet session does. */
async function openSide (dir, { key = null, identity }) {
  const store = new Corestore(path.join(tmp, dir))
  await store.ready()
  const room = key ? await Room.join(store, key, { identity }) : await Room.create(store, { identity })
  const swarm = new RoomSwarm(room, { onPeer: (p) => log(`${identity}: peer connected, total`, p.connections) })
  await swarm.join()
  return { store, room, swarm }
}

async function main () {
  const started = Date.now()

  // ------------------------------------------------- Alice opens BOTH rooms
  const room1Alice = await openSide('alice-room1', { identity: 'alice' })
  const room2Alice = await openSide('alice-room2', { identity: 'alice' })
  log('alice announced both rooms after', ((Date.now() - started) / 1000).toFixed(1) + 's')

  check('twoRoomsHaveDifferentKeys', room1Alice.room.key !== room2Alice.room.key)
  check('twoRoomsHaveDifferentDiscoveryKeys',
    !room1Alice.room.discoveryKey.equals(room2Alice.room.discoveryKey))

  // ---------------------------------------------------- Bob joins room 1 only
  const bob = await openSide('bob', { key: room1Alice.room.key, identity: 'bob' })
  // -------------------------------------------------- Carol joins room 2 only
  const carol = await openSide('carol', { key: room2Alice.room.key, identity: 'carol' })

  // This sandbox's DHT bootstrap runs far slower than a normal network (observed
  // ~70s just to announce, ~190s to find a peer) — give it real room rather than
  // failing on a timeout tuned for typical conditions.
  const [bobFound, carolFound] = await Promise.all([
    bob.swarm.waitForPeer({ timeout: 240000 }),
    carol.swarm.waitForPeer({ timeout: 240000 })
  ])
  check('bobFoundAliceInRoom1', bobFound)
  check('carolFoundAliceInRoom2', carolFound)
  log('both peers found after', ((Date.now() - started) / 1000).toFixed(1) + 's')

  // No cross-talk: Bob's swarm must never see Carol, and vice versa — they
  // are on different discovery keys, so a peer count above 1 would mean a
  // room boundary leaked.
  check('bobSeesExactlyOnePeer', bob.swarm.peerCount === 1)
  check('carolSeesExactlyOnePeer', carol.swarm.peerCount === 1)

  // ------------------------------------------- both rooms post CONCURRENTLY
  await Promise.all([
    room1Alice.room.post('room 1, from alice', { lang: 'en' }),
    room2Alice.room.post('room 2, from alice', { lang: 'en' })
  ])
  await Promise.all([room1Alice.room.update(), room2Alice.room.update()])

  await room1Alice.room.invite(bob.room.writerKey)
  await room2Alice.room.invite(carol.room.writerKey)
  await Promise.all([room1Alice.room.update(), room2Alice.room.update()])

  // Same slow-sandbox allowance as the peer-discovery wait above.
  const WRITABLE_WAIT = { attempts: 240, interval: 1000 }
  const [bobWritable, carolWritable] = await Promise.all([
    bob.room.waitFor((r) => r.writable, WRITABLE_WAIT),
    carol.room.waitFor((r) => r.writable, WRITABLE_WAIT)
  ])
  check('bobInvitedInRoom1', bobWritable)
  check('carolInvitedInRoom2', carolWritable)

  if (bobWritable) await bob.room.post('room 1, from bob', { lang: 'en' })
  if (carolWritable) await carol.room.post('room 2, from carol', { lang: 'en' })
  await Promise.all([bob.room.update(), carol.room.update()])

  // Both rooms must converge WHILE the other is also mid-exchange — proving
  // one process running two rooms doesn't stall or interleave them.
  const [room1Converged, room2Converged] = await Promise.all([
    waitForConvergence(room1Alice.room, bob.room, { attempts: 240, interval: 1000 }),
    waitForConvergence(room2Alice.room, carol.room, { attempts: 240, interval: 1000 })
  ])
  check('room1ConvergedWhileRoom2Active', room1Converged)
  check('room2ConvergedWhileRoom1Active', room2Converged)

  // ----------------------------------------------------------- isolation
  const room1Transcript = await room1Alice.room.transcript()
  const room2Transcript = await room2Alice.room.transcript()
  check('room1FreeOfRoom2Messages',
    !room1Transcript.some((m) => m.text.startsWith('room 2')))
  check('room2FreeOfRoom1Messages',
    !room2Transcript.some((m) => m.text.startsWith('room 1')))
  check('room1HasOnlyItsOwnMessages',
    room1Transcript.every((m) => m.text.startsWith('room 1')))
  check('room2HasOnlyItsOwnMessages',
    room2Transcript.every((m) => m.text.startsWith('room 2')))

  console.log('\n--- room 1 transcript ---')
  for (const m of room1Transcript) console.log(` ${m.from}: ${m.text}`)
  console.log('--- room 2 transcript ---')
  for (const m of room2Transcript) console.log(` ${m.from}: ${m.text}`)

  // ------------------------------------------------------------ report
  console.log('\n================ RESULT ================')
  for (const [name, passed] of Object.entries(results)) {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
  const ok = Object.values(results).every(Boolean)
  const count = Object.values(results).filter(Boolean).length
  console.log(`\n${count}/${Object.keys(results).length} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log('verdict :', ok
    ? 'MULTI-ROOM WORKS - one process ran two independent rooms concurrently, no cross-talk'
    : 'SOMETHING FAILED')
  console.log('========================================')

  for (const side of [room1Alice, room2Alice, bob, carol]) {
    await side.swarm.leave()
    await side.room.close()
    await side.store.close()
  }
  cleanup()
  process.exit(ok ? 0 : 1)
}

main().catch((err) => {
  console.error('fatal:', err)
  cleanup()
  process.exit(1)
})
