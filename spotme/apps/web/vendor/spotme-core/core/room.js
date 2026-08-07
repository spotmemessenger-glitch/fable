/**
 * Spot Me — a chat room.
 *
 * Wraps Autobase so the rest of the app never touches Hypercore directly.
 * Deliberately knows nothing about networking: callers hand in replication
 * streams (see the two-peer test, or swarm.js for the real-network case). That
 * separation is what lets the room be tested without a DHT.
 *
 * Cross-platform — runs unchanged in a Bare worklet and in Node.
 *
 * ---------------------------------------------------------------------------
 * CRYPTOGRAPHY — what is already guaranteed, and by what
 *
 *   Authorship    Ed25519. Every append is signed by the writer's own core, so
 *                 `apply()` stamps the proven key over the self-declared `from`.
 *   Integrity     BLAKE2b Merkle tree. History is tamper-evident; a peer cannot
 *                 rewrite the past without detection.
 *   Transport     Noise (NOISE_XX) on every Hyperswarm connection — encrypted
 *                 and mutually authenticated. No TLS, no certificate authority.
 *   Read gating   Replication requires the core's public key. Proven, not
 *                 assumed: hypercore-check.js shows a wrong-key core stays empty.
 *   At rest       OPTIONAL block encryption, via `encryptionKey` below.
 *
 * The encryption key is what makes a relay node blind. Replicating a core needs
 * its PUBLIC key; reading the blocks additionally needs the ENCRYPTION key. Give
 * an always-on node the former and withhold the latter and it stores and
 * forwards ciphertext it cannot read — a cryptographic property, not a promise.
 * ------------------------------------------------------------------------- */
const Autobase = require('autobase')
const { OP, isValidOp, msg, react, del, profile, addWriter } = require('./schema')

/** Replication is async everywhere in this stack. Never assert on first update. */
const POLL_INTERVAL_MS = 200
const POLL_ATTEMPTS = 25

/**
 * How room state is derived from the merged log. Every peer runs this exact
 * function, which is precisely why every peer converges on the same transcript.
 * Must stay deterministic: no clocks, no randomness, no I/O.
 *
 * Built as a factory so the encryption key can be closed over — peers must pass
 * the SAME key or they will not converge.
 */
function makeOpen (encryptionKey) {
  return function open (store) {
    const opts = { valueEncoding: 'json' }
    if (encryptionKey) opts.encryptionKey = encryptionKey
    return store.get('transcript', opts)
  }
}

async function apply (nodes, view, base) {
  for (const node of nodes) {
    const op = node.value

    // Drop anything malformed. A peer is remote code we do not control, so a
    // hostile op must not corrupt a view every peer has to agree on.
    if (!isValidOp(op)) continue

    if (op.type === OP.ADD_WRITER) {
      await base.addWriter(Buffer.from(op.key, 'hex'), { indexer: true })
      continue
    }

    // Stamp the cryptographically-proven author over any self-declared `from`.
    // op.from is a display hint and is trivially spoofable; node.from.key is
    // signed by the writer's own core and is not.
    const author = node.from?.key ? node.from.key.toString('hex') : null
    await view.append({ ...op, author })
  }
}

class Room {
  #base
  #identity

  constructor (base, identity) {
    this.#base = base
    this.#identity = identity
  }

  /**
   * Create a brand-new room. The returned `key` is the invite code.
   *
   * `encryptionKey` (32 bytes) enables at-rest block encryption. Pass the same
   * key to every peer in the room. Omit it and blocks are stored in the clear —
   * acceptable for tests, not for a device that can be stolen.
   */
  static async create (store, { identity = 'me', encryptionKey = null } = {}) {
    const base = new Autobase(store, null, {
      open: makeOpen(encryptionKey),
      apply,
      valueEncoding: 'json'
    })
    await base.ready()
    return new Room(base, identity)
  }

  /**
   * Join an existing room by its key. Joining is read-only — the room key alone
   * grants history, never the right to post. Posting requires an explicit
   * `invite()` from an existing writer.
   */
  static async join (store, roomKey, { identity = 'me', encryptionKey = null } = {}) {
    const key = typeof roomKey === 'string' ? Buffer.from(roomKey, 'hex') : roomKey
    const base = new Autobase(store, key, {
      open: makeOpen(encryptionKey),
      apply,
      valueEncoding: 'json'
    })
    await base.ready()
    return new Room(base, identity)
  }

  /** Share this to invite someone. Grants read access only. */
  get key () {
    return this.#base.key.toString('hex')
  }

  /**
   * The swarm topic for this room.
   *
   * Derived from the room key but NOT reversible to it. This distinction is
   * load-bearing: announcing the room key on a public DHT would hand read
   * access to anyone watching the topic. Always advertise this, never `key`.
   */
  get discoveryKey () {
    return this.#base.discoveryKey
  }

  /** This device's writer key — what an existing writer passes to invite(). */
  get writerKey () {
    return this.#base.local.key.toString('hex')
  }

  /** Underlying Corestore — swarm.js wires this to replication streams. */
  get store () {
    return this.#base.store
  }

  /** False until an existing writer has invited this device. */
  get writable () {
    return this.#base.writable
  }

  get length () {
    return this.#base.view.length
  }

  async post (text, { lang, replyTo = null, ephemeral = null } = {}) {
    this.#assertWritable('post')
    const op = msg({ from: this.#identity, text, lang, replyTo, ephemeral })
    await this.#base.append(op)
    return op.id
  }

  async react (target, emoji) {
    this.#assertWritable('react')
    await this.#base.append(react({ from: this.#identity, target, emoji }))
  }

  /**
   * Ask every cooperating client to hide a message.
   *
   * Appends a tombstone; does not erase bytes, and cannot. Read the honesty
   * note in schema.js before writing any UI copy for this.
   */
  async delete (target) {
    this.#assertWritable('delete')
    await this.#base.append(del({ from: this.#identity, target }))
  }

  async setProfile ({ name, lang }) {
    this.#assertWritable('setProfile')
    await this.#base.append(profile({ from: this.#identity, name, lang }))
  }

  /** Promote another device to writer. This IS the invite mechanism. */
  async invite (writerKey) {
    this.#assertWritable('invite')
    await this.#base.append(addWriter({ key: writerKey }))
  }

  async update () {
    await this.#base.update()
  }

  /**
   * Wait until a condition holds, polling `update()`.
   *
   * Every replication assertion must go through here. Asserting immediately
   * after wiring a stream is a race, and it produced every false test failure
   * during the P2P spike — the libraries were fine, the tests were not.
   */
  async waitFor (predicate, { attempts = POLL_ATTEMPTS, interval = POLL_INTERVAL_MS } = {}) {
    for (let i = 0; i < attempts; i++) {
      await this.update()
      if (predicate(this)) return true
      await new Promise((resolve) => setTimeout(resolve, interval))
    }
    await this.update()
    return predicate(this)
  }

  /**
   * The resolved conversation: tombstones honoured, reactions folded into their
   * target message. Ordering comes from Autobase's deterministic merge, so two
   * peers calling this see identical output.
   *
   * Translation is NOT applied here — it is a local derived view applied per
   * reader at the UI layer. The source `lang` travels on the wire; translated
   * text never does.
   */
  async transcript () {
    const ops = []
    for (let i = 0; i < this.#base.view.length; i++) {
      ops.push(await this.#base.view.get(i))
    }

    const deleted = new Set(
      ops.filter((o) => o.type === OP.DELETE).map((o) => o.target)
    )

    const reactions = new Map()
    for (const op of ops) {
      if (op.type !== OP.REACT) continue
      if (!reactions.has(op.target)) reactions.set(op.target, [])
      reactions.get(op.target).push({ emoji: op.emoji, author: op.author })
    }

    return ops
      .filter((o) => o.type === OP.MSG && !deleted.has(o.id))
      .map((o) => ({
        id: o.id,
        text: o.text,
        lang: o.lang,
        ts: o.ts,
        author: o.author,
        from: o.from,
        replyTo: o.replyTo,
        ephemeral: o.ephemeral,
        reactions: reactions.get(o.id) || []
      }))
  }

  /** Latest profile per author, for rendering names. */
  async profiles () {
    const out = new Map()
    for (let i = 0; i < this.#base.view.length; i++) {
      const op = await this.#base.view.get(i)
      if (op.type === OP.PROFILE) {
        out.set(op.author, { name: op.name, lang: op.lang })
      }
    }
    return out
  }

  async close () {
    await this.#base.close()
  }

  #assertWritable (action) {
    if (!this.#base.writable) {
      throw new Error(
        `Room.${action}: this device is not a writer yet. ` +
        'An existing writer must call invite(writerKey) first.'
      )
    }
  }
}

module.exports = { Room, makeOpen, apply }
