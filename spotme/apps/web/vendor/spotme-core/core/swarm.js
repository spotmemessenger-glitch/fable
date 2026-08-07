/**
 * Spot Me — networking.
 *
 * Connects a Room to the real Hyperswarm DHT. Kept apart from room.js on
 * purpose: the room stays testable without a network, and this file is the only
 * place that knows peers exist.
 *
 * ---------------------------------------------------------------------------
 * THE TOPIC IS THE DISCOVERY KEY, NEVER THE ROOM KEY
 *
 * A Hyperswarm topic is public — anyone can watch the DHT for who announces
 * what. The room key is the READ CAPABILITY: hold it and you can replicate and
 * decrypt the whole history. Announcing it would publish the room to the world.
 *
 * The discovery key is derived from the room key by a one-way hash. It is
 * enough to find peers and cannot be reversed into read access. Always
 * advertise `room.discoveryKey`.
 * ------------------------------------------------------------------------- */
const Hyperswarm = require('hyperswarm')

/** DHT announce is not instant — the P2P spike measured roughly 6 seconds. */
const DEFAULT_ANNOUNCE_TIMEOUT_MS = 30000

class RoomSwarm {
  #swarm
  #room
  #connections = new Set()
  #onPeer

  constructor (room, { keyPair = null, bootstrap = null, onPeer = null } = {}) {
    this.#room = room
    this.#onPeer = onPeer

    const opts = {}
    if (keyPair) opts.keyPair = keyPair
    // `bootstrap` points at a private DHT — used by tests so they never touch
    // the public network, and available later for self-hosted bootstrap nodes.
    if (bootstrap) opts.bootstrap = bootstrap

    this.#swarm = new Hyperswarm(opts)

    this.#swarm.on('connection', (connection, info) => {
      this.#connections.add(connection)
      connection.on('close', () => this.#connections.delete(connection))
      connection.on('error', () => this.#connections.delete(connection))

      // Hand the raw socket to Corestore. Everything above this line is
      // plaintext-free: the stream is already Noise-encrypted by Hyperswarm,
      // and the blocks inside are encrypted again if the room has a key.
      this.#room.store.replicate(connection)

      if (this.#onPeer) {
        this.#onPeer({
          publicKey: info?.publicKey ? info.publicKey.toString('hex') : null,
          connections: this.#connections.size
        })
      }
    })
  }

  get peerCount () {
    return this.#connections.size
  }

  /**
   * Announce this room and start looking for peers.
   *
   * Resolves once the topic is announced to the DHT — which is NOT the same as
   * having found a peer. Callers who need an actual peer should await
   * `waitForPeer()`.
   */
  async join ({ server = true, client = true } = {}) {
    const discovery = this.#swarm.join(this.#room.discoveryKey, { server, client })
    await discovery.flushed()
    return this
  }

  /**
   * Wait until at least one peer is connected.
   *
   * Separate from join() because the two failure modes are entirely different:
   * "the DHT never took my announcement" and "nobody else is in this room".
   * Collapsing them produces the least debuggable class of P2P bug.
   */
  async waitForPeer ({ timeout = DEFAULT_ANNOUNCE_TIMEOUT_MS } = {}) {
    if (this.#connections.size > 0) return true

    return new Promise((resolve) => {
      const onConnection = () => {
        clearTimeout(timer)
        this.#swarm.off('connection', onConnection)
        resolve(true)
      }

      const timer = setTimeout(() => {
        this.#swarm.off('connection', onConnection)
        resolve(false)
      }, timeout)

      this.#swarm.on('connection', onConnection)
    })
  }

  /** Wait for every pending peer handshake to settle. */
  async flush () {
    await this.#swarm.flush()
  }

  async leave () {
    await this.#swarm.leave(this.#room.discoveryKey)
    await this.#swarm.destroy()
    this.#connections.clear()
  }
}

/** Convenience: join a room's swarm and wait for the announcement to land. */
async function joinRoom (room, opts = {}) {
  const swarm = new RoomSwarm(room, opts)
  await swarm.join()
  return swarm
}

module.exports = { RoomSwarm, joinRoom, DEFAULT_ANNOUNCE_TIMEOUT_MS }
