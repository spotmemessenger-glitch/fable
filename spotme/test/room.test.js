/**
 * Two-peer room — the convergence property the whole app rests on.
 *
 * Alice opens a room, Bob joins read-only from the room key alone, Alice
 * invites him, both post, and both must end up with an IDENTICAL transcript.
 * If that fails, group chat is not possible and nothing above it matters.
 *
 * Networking is deliberately absent: the two stores are piped together
 * directly, exactly as Hyperswarm would connect them. That keeps this test
 * fast and free of DHT flakiness — the real network is a separate test.
 *
 *   node test/room.test.js
 */
const assert = require('assert')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Corestore = require('corestore')
const { Room } = require('../core/room')
const { EPHEMERAL } = require('../core/schema')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spotme-room-'))
const results = {}
const check = (name, value) => { results[name] = value === true }

/**
 * Poll until two peers hold byte-identical transcripts.
 *
 * Replication is asynchronous and per-op: a peer can hold a message while its
 * reaction is still on the wire. Any assertion about agreement must wait for
 * agreement itself, never for a proxy like "the message arrived".
 */
async function waitForConvergence (a, b, { attempts = 30, interval = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await a.update()
    await b.update()
    const [va, vb] = [await a.transcript(), await b.transcript()]
    if (va.length > 0 && JSON.stringify(va) === JSON.stringify(vb)) return true
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

const cleanup = () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* Windows holds core file handles briefly after close */
  }
}

async function main () {
  // ------------------------------------------------------------ Alice
  const storeA = new Corestore(path.join(tmp, 'alice'))
  await storeA.ready()
  const alice = await Room.create(storeA, { identity: 'alice' })

  console.log('room key:', alice.key.slice(0, 16) + '...')
  check('creatorIsWritable', alice.writable)

  const first = await alice.post('Vanakkam!', { lang: 'ta' })
  await alice.post('Anyone here?', { lang: 'en' })
  await alice.update()

  // -------------------------------------------------------------- Bob
  const storeB = new Corestore(path.join(tmp, 'bob'))
  await storeB.ready()
  const bob = await Room.join(storeB, alice.key, { identity: 'bob' })

  // Wire them together, as Hyperswarm would.
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)

  check('joinerSeesHistory', await bob.waitFor((r) => r.length >= 2))
  console.log('bob synced', bob.length, 'ops (read-only)')

  // The room key grants READ, never WRITE. This is the security property that
  // makes it safe to share an invite link.
  check('joinerCannotPostYet', bob.writable === false)
  let refused = false
  try {
    await bob.post('sneaking in', { lang: 'en' })
  } catch {
    refused = true
  }
  check('uninvitedPostThrows', refused)

  // ------------------------------------------------- Alice invites Bob
  await alice.invite(bob.writerKey)
  await alice.update()
  check('inviteMakesWritable', await bob.waitFor((r) => r.writable))
  console.log('bob writable after invite:', bob.writable)

  // ------------------------------------------------------ conversation
  const reply = await bob.post('Naan irukken!', { lang: 'ta', replyTo: first })
  await bob.react(first, 'heart')
  await bob.update()
  // Wait for CONVERGENCE, not for an op count.
  //
  // Two earlier versions of this assertion were wrong in opposite directions:
  // waiting on `length >= 5` counted an addWriter that apply() consumes and
  // never puts in the view, and waiting on "the reply arrived" returned while
  // the reaction was still in flight, capturing Alice mid-sync. The property
  // actually being claimed is that both peers agree — so wait for exactly that.
  const converged = await waitForConvergence(alice, bob)
  check('bothSeeTheReply', converged)

  const aliceView = await alice.transcript()
  const bobView = await bob.transcript()

  console.log('\n--- transcript ---')
  for (const m of aliceView) {
    const marks = [
      m.replyTo ? `reply->${m.replyTo.slice(0, 6)}` : null,
      m.reactions.length ? `+${m.reactions.length} reaction` : null,
      m.ephemeral ? `[${m.ephemeral.mode}]` : null
    ].filter(Boolean).join(' ')
    console.log(` ${m.from}: ${m.text} [${m.lang}] ${marks}`)
  }

  check('transcriptsIdentical', JSON.stringify(aliceView) === JSON.stringify(bobView))
  check('replyThreadPreserved', aliceView.some((m) => m.replyTo === first))
  check('reactionAttachedToTarget',
    aliceView.find((m) => m.id === first)?.reactions.length === 1)

  // Authorship is signed, not self-declared. Alice and Bob wrote from different
  // cores, so their proven authors must differ regardless of the `from` field.
  const authors = new Set(aliceView.map((m) => m.author))
  check('authorsAreCryptographicallyDistinct', authors.size === 2)

  // ---------------------------------------------------------- deletion
  await bob.delete(reply)
  await bob.update()
  let gone = false
  for (let i = 0; i < 25 && !gone; i++) {
    await alice.update()
    const t = await alice.transcript()
    gone = !t.some((m) => m.id === reply)
    if (!gone) await new Promise((r) => setTimeout(r, 200))
  }
  check('tombstoneReplicates', gone)

  const afterAlice = await alice.transcript()
  const afterBob = await bob.transcript()
  check('deletedMessageHiddenForBoth',
    !afterAlice.some((m) => m.id === reply) &&
    !afterBob.some((m) => m.id === reply))

  // ------------------------------------------------------- ephemeral
  const burn = await alice.post('this one burns', {
    lang: 'en',
    ephemeral: { mode: EPHEMERAL.TIMER, seconds: 30 }
  })
  await alice.update()
  let survived = false
  for (let i = 0; i < 25 && !survived; i++) {
    await bob.update()
    const t = await bob.transcript()
    const m = t.find((x) => x.id === burn)
    survived = m?.ephemeral?.mode === EPHEMERAL.TIMER && m.ephemeral.seconds === 30
    if (!survived) await new Promise((r) => setTimeout(r, 200))
  }
  check('ephemeralFlagSurvivesTheWire', survived)

  // ------------------------------------------------------------ report
  console.log('\n================ RESULT ================')
  for (const [name, passed] of Object.entries(results)) {
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
  const ok = Object.values(results).every(Boolean)
  const count = Object.values(results).filter(Boolean).length
  console.log(`\n${count}/${Object.keys(results).length}`)
  console.log('verdict :', ok
    ? 'ROOM WORKS - two peers converge, invites gate writing, tombstones honoured'
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
