/**
 * Two peers over the REAL Hyperswarm DHT.
 *
 * room.test.js pipes two stores together, which proves convergence but proves
 * nothing about networking. This test uses the actual public DHT: announce,
 * discover, connect, replicate. It is the last step before the same code runs
 * in a Bare worklet on a phone.
 *
 * Caveat carried over from the P2P spike, and it still applies here: both peers
 * run on ONE machine. Discovery is genuinely remote, but the transport may
 * never leave localhost. A true cross-network hole-punch — phone on mobile
 * data, desktop on broadband — remains unproven and is the number that decides
 * the relay budget.
 *
 * Slower than the other tests by design: DHT announce took ~6s when measured.
 *
 *   node test/swarm.test.js
 */
const os = require('os')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const { Room } = require('../core/room')
const { RoomSwarm } = require('../core/swarm')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spotme-swarm-'))
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

async function main () {
  const started = Date.now()

  // ------------------------------------------------------------ Alice
  const storeA = new Corestore(path.join(tmp, 'alice'))
  await storeA.ready()
  const alice = await Room.create(storeA, { identity: 'alice' })
  await alice.post('Vanakkam from the DHT', { lang: 'ta' })
  await alice.update()

  log('room key      :', alice.key.slice(0, 16) + '...')
  log('discovery key :', alice.discoveryKey.toString('hex').slice(0, 16) + '...')

  // The topic must not be the read capability. If these ever match, the room
  // is being published to anyone watching the DHT.
  check('topicIsNotTheReadKey',
    alice.discoveryKey.toString('hex') !== alice.key)

  const swarmA = new RoomSwarm(alice, {
    onPeer: (p) => log('alice: peer connected, total', p.connections)
  })
  await swarmA.join()
  log('alice announced to DHT after', ((Date.now() - started) / 1000).toFixed(1) + 's')
  check('announceSucceeded', true)

  // -------------------------------------------------------------- Bob
  // Bob knows ONLY the room key — exactly what an invite link carries.
  const storeB = new Corestore(path.join(tmp, 'bob'))
  await storeB.ready()
  const bob = await Room.join(storeB, alice.key, { identity: 'bob' })

  const swarmB = new RoomSwarm(bob, {
    onPeer: (p) => log('bob: peer connected, total', p.connections)
  })
  await swarmB.join()
  log('bob announced, searching for peers...')

  const found = await swarmB.waitForPeer({ timeout: 45000 })
  log('peer found:', found, 'after', ((Date.now() - started) / 1000).toFixed(1) + 's')
  check('peersFoundEachOther', found)

  if (found) {
    // ------------------------------------------------- history over the wire
    let synced = false
    for (let i = 0; i < 60 && !synced; i++) {
      await bob.update()
      synced = (await bob.transcript()).length >= 1
      if (!synced) await new Promise((r) => setTimeout(r, 500))
    }
    check('historyReplicatedOverDHT', synced)
    log('bob synced history:', synced)

    // ----------------------------------------------------- invite + reply
    await alice.invite(bob.writerKey)
    await alice.update()

    let writable = false
    for (let i = 0; i < 60 && !writable; i++) {
      await bob.update()
      writable = bob.writable
      if (!writable) await new Promise((r) => setTimeout(r, 500))
    }
    check('inviteTravelledOverDHT', writable)
    log('bob writable:', writable)

    if (writable) {
      await bob.post('Naan irukken, over the network', { lang: 'ta' })
      await bob.update()
      const converged = await waitForConvergence(alice, bob)
      check('convergedOverRealNetwork', converged)

      const view = await alice.transcript()
      console.log('\n--- transcript over DHT ---')
      for (const m of view) console.log(` ${m.from}: ${m.text} [${m.lang}]`)
    }
  }

  // ------------------------------------------------------------ report
  console.log('\n================ RESULT ================')
  for (const [name, passed] of Object.entries(results)) {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
  const ok = Object.values(results).every(Boolean)
  const count = Object.values(results).filter(Boolean).length
  console.log(`\n${count}/${Object.keys(results).length} in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log('verdict :', ok
    ? 'DHT WORKS - peers discovered and replicated over the public network'
    : 'SOMETHING FAILED')
  console.log('NOTE    : both peers ran on one machine. Cross-network')
  console.log('          hole-punching is still unproven.')
  console.log('========================================')

  await swarmA.leave()
  await swarmB.leave()
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
