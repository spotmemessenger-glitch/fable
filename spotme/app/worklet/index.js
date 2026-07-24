/**
 * Spot Me — Bare worklet.
 *
 * This is the P2P process. It runs in Bare (Holepunch's minimal JS runtime),
 * NOT in React Native's engine, because RN cannot do raw UDP and therefore
 * cannot host Hyperswarm. Everything below the RPC boundary — cores, swarm,
 * crypto — lives here and never crosses into the UI thread.
 *
 * React Native talks to it over IPC with newline-delimited JSON. Deliberately
 * boring: a text protocol can be logged, diffed and replayed when a sync bug
 * appears on a physical phone with no debugger attached.
 *
 *   RN  -> worklet   {id, cmd, args}
 *   RN <-  worklet   {id, ok: true, result} | {id, ok: false, error}
 *   RN <-  worklet   {event, ...}            (unsolicited: ready, update, peer)
 */
/* global BareKit */
const Corestore = require('corestore')
const { Room } = require('spotme-core/core/room')
const { RoomSwarm } = require('spotme-core/core/swarm')

const ipc = BareKit.IPC

let store = null
let room = null
let swarm = null

/** Guards against emitting a transcript identical to the last one. */
let lastTranscript = '[]'

function send (payload) {
  ipc.write(JSON.stringify(payload) + '\n')
}

function emit (event, data = {}) {
  send({ event, ...data })
}

/**
 * Push the transcript to the UI whenever it actually changes.
 *
 * Autobase has no single "changed" event covering remote appends, so this
 * polls. 400ms sits below the threshold where a chat feels laggy and well
 * above the cost of diffing a few hundred messages.
 */
const POLL_MS = 400
let pollTimer = null

function startPolling () {
  if (pollTimer) return
  pollTimer = setInterval(async () => {
    if (!room) return
    try {
      await room.update()
      const transcript = await room.transcript()
      const serialised = JSON.stringify(transcript)
      if (serialised !== lastTranscript) {
        lastTranscript = serialised
        emit('update', { transcript, writable: room.writable })
      }
    } catch (err) {
      emit('error', { where: 'poll', message: err.message })
    }
  }, POLL_MS)
}

function stopPolling () {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

const commands = {
  /**
   * `storagePath` comes from React Native because only the RN side knows the
   * platform's documents directory. Bare has no notion of app sandboxes.
   */
  async create ({ storagePath, identity = 'me' }) {
    await teardown()
    store = new Corestore(storagePath)
    await store.ready()
    room = await Room.create(store, { identity })
    await startSwarm()
    startPolling()
    return { key: room.key, writerKey: room.writerKey, writable: room.writable }
  },

  async join ({ storagePath, roomKey, identity = 'me' }) {
    await teardown()
    store = new Corestore(storagePath)
    await store.ready()
    room = await Room.join(store, roomKey, { identity })
    await startSwarm()
    startPolling()
    return { key: room.key, writerKey: room.writerKey, writable: room.writable }
  },

  async post ({ text, lang, replyTo = null, ephemeral = null }) {
    assertRoom()
    const id = await room.post(text, { lang, replyTo, ephemeral })
    await room.update()
    return { id }
  },

  async react ({ target, emoji }) {
    assertRoom()
    await room.react(target, emoji)
    return { ok: true }
  },

  async remove ({ target }) {
    assertRoom()
    await room.delete(target)
    return { ok: true }
  },

  async invite ({ writerKey }) {
    assertRoom()
    await room.invite(writerKey)
    return { ok: true }
  },

  async transcript () {
    assertRoom()
    await room.update()
    return {
      transcript: await room.transcript(),
      writable: room.writable,
      peers: swarm ? swarm.peerCount : 0
    }
  },

  async status () {
    return {
      hasRoom: room !== null,
      key: room ? room.key : null,
      writerKey: room ? room.writerKey : null,
      writable: room ? room.writable : false,
      peers: swarm ? swarm.peerCount : 0
    }
  }
}

function assertRoom () {
  if (!room) throw new Error('no room open - call create or join first')
}

async function startSwarm () {
  swarm = new RoomSwarm(room, {
    onPeer: (p) => emit('peer', { count: p.connections })
  })
  // Do not await the announce: it takes seconds on the DHT and the UI must be
  // usable immediately. Peers surface later via the `peer` event.
  swarm.join().catch((err) => emit('error', { where: 'swarm', message: err.message }))
}

async function teardown () {
  stopPolling()
  lastTranscript = '[]'
  try {
    if (swarm) await swarm.leave()
    if (room) await room.close()
    if (store) await store.close()
  } catch {
    /* closing a half-open store on re-init is not worth failing the command */
  }
  swarm = null
  room = null
  store = null
}

// ------------------------------------------------------------------ IPC loop
let buffer = ''

ipc.on('data', async (chunk) => {
  buffer += chunk.toString()

  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue

    let request
    try {
      request = JSON.parse(line)
    } catch {
      emit('error', { where: 'parse', message: 'malformed request' })
      continue
    }

    const handler = commands[request.cmd]
    if (!handler) {
      send({ id: request.id, ok: false, error: `unknown command: ${request.cmd}` })
      continue
    }

    try {
      const result = await handler(request.args || {})
      send({ id: request.id, ok: true, result })
    } catch (err) {
      send({ id: request.id, ok: false, error: err.message })
    }
  }
})

emit('ready')
