/**
 * Spot Me — message schema.
 *
 * Every op that goes onto the append-only log passes through here. Autobase
 * logs are immutable: a field omitted today cannot be back-filled tomorrow, so
 * the shape below deliberately reserves room for features that are not built
 * yet (replies, reactions, ephemerality) rather than bolting them on later.
 *
 * Cross-platform by construction — no Node built-ins, no React. This file runs
 * unchanged in a Bare worklet and in Node.
 */

/** Wire-format version. Bump only for a breaking change; readers must tolerate. */
const SCHEMA_VERSION = 1

const OP = {
  MSG: 'msg',
  REACT: 'react',
  DELETE: 'delete',
  PROFILE: 'profile',
  ADD_WRITER: 'addWriter'
}

/** Ephemeral modes. See the honesty note at the bottom of this file. */
const EPHEMERAL = {
  ONCE: 'once', // burn after first view
  TIMER: 'timer' // burn N seconds after first view
}

const MAX_TEXT_BYTES = 8192
const MAX_NAME_BYTES = 64

/**
 * Monotonic-ish id. Random suffix disambiguates two ops in the same
 * millisecond; the timestamp prefix keeps ids roughly sortable for debugging.
 * Not a security primitive — authorship is proven by the Hypercore signature,
 * never by this id.
 */
function messageId () {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${Date.now().toString(36)}-${rand}`
}

function byteLength (str) {
  // Bare has no Buffer.byteLength guarantee; TextEncoder is present in both.
  return new TextEncoder().encode(str).length
}

/**
 * Build a text message.
 *
 * `lang` is the SOURCE language and is recorded on the wire. Translation is a
 * local derived view — each peer translates on arrival into their own
 * preference — so no translated text is ever replicated. That keeps the
 * end-to-end property intact and costs zero extra bytes.
 */
function msg ({ from, text, lang, replyTo = null, ephemeral = null }) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('msg: text must be a non-empty string')
  }
  if (byteLength(text) > MAX_TEXT_BYTES) {
    throw new Error(`msg: text exceeds ${MAX_TEXT_BYTES} bytes`)
  }
  if (typeof lang !== 'string' || lang.length === 0) {
    throw new Error('msg: lang is required (BCP-47, e.g. "ta", "en", "hi")')
  }
  if (ephemeral !== null) validateEphemeral(ephemeral)

  return {
    v: SCHEMA_VERSION,
    type: OP.MSG,
    id: messageId(),
    from,
    text,
    lang,
    ts: Date.now(),
    replyTo,
    ephemeral
  }
}

/** React to a message. `target` is a message id. */
function react ({ from, target, emoji }) {
  if (!target) throw new Error('react: target message id is required')
  if (typeof emoji !== 'string' || emoji.length === 0) {
    throw new Error('react: emoji is required')
  }
  return { v: SCHEMA_VERSION, type: OP.REACT, id: messageId(), from, target, emoji, ts: Date.now() }
}

/**
 * Tombstone a message.
 *
 * This appends a *delete instruction*; it does not erase bytes. The original op
 * remains in the log forever — that is what an append-only log means. Every
 * cooperating client hides the target, and `Room.transcript()` honours it. A
 * modified client can ignore it. See the honesty note below.
 */
function del ({ from, target }) {
  if (!target) throw new Error('delete: target message id is required')
  return { v: SCHEMA_VERSION, type: OP.DELETE, id: messageId(), from, target, ts: Date.now() }
}

/** Set display name and preferred language for this identity. */
function profile ({ from, name, lang }) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('profile: name is required')
  }
  if (byteLength(name) > MAX_NAME_BYTES) {
    throw new Error(`profile: name exceeds ${MAX_NAME_BYTES} bytes`)
  }
  return { v: SCHEMA_VERSION, type: OP.PROFILE, id: messageId(), from, name, lang, ts: Date.now() }
}

/** Grant another device permission to post. This IS the invite mechanism. */
function addWriter ({ key }) {
  if (typeof key !== 'string' || key.length !== 64) {
    throw new Error('addWriter: key must be a 64-char hex string')
  }
  return { v: SCHEMA_VERSION, type: OP.ADD_WRITER, key, ts: Date.now() }
}

function validateEphemeral (e) {
  if (e.mode !== EPHEMERAL.ONCE && e.mode !== EPHEMERAL.TIMER) {
    throw new Error(`ephemeral: mode must be "${EPHEMERAL.ONCE}" or "${EPHEMERAL.TIMER}"`)
  }
  if (e.mode === EPHEMERAL.TIMER) {
    if (!Number.isInteger(e.seconds) || e.seconds <= 0) {
      throw new Error('ephemeral: timer mode requires a positive integer "seconds"')
    }
  }
}

/**
 * Validate an op arriving from a peer. Never trust the wire: a peer is remote
 * code we do not control, so a malformed or hostile op must be dropped rather
 * than allowed to corrupt the view.
 */
function isValidOp (op) {
  if (!op || typeof op !== 'object') return false
  if (typeof op.type !== 'string') return false

  switch (op.type) {
    case OP.MSG:
      return typeof op.id === 'string' &&
        typeof op.text === 'string' && op.text.length > 0 &&
        byteLength(op.text) <= MAX_TEXT_BYTES &&
        typeof op.lang === 'string' && op.lang.length > 0
    case OP.REACT:
      return typeof op.id === 'string' && typeof op.target === 'string' &&
        typeof op.emoji === 'string' && op.emoji.length > 0
    case OP.DELETE:
      return typeof op.id === 'string' && typeof op.target === 'string'
    case OP.PROFILE:
      return typeof op.name === 'string' && op.name.length > 0 &&
        byteLength(op.name) <= MAX_NAME_BYTES
    case OP.ADD_WRITER:
      return typeof op.key === 'string' && op.key.length === 64
    default:
      return false // unknown op type — forward-compat readers simply skip it
  }
}

/* ---------------------------------------------------------------------------
 * HONESTY NOTE — read before writing any UI copy about these features.
 *
 * "Delete without a trace", view-once and timer-delete are COOPERATIVE, not
 * enforced. Once a peer holds the bytes, that peer controls them: a modified
 * client can ignore a tombstone, screenshot a view-once photo, or simply never
 * run the timer. This is a property of P2P replication, not a gap in effort —
 * no amount of work here changes it.
 *
 * What we can honestly deliver: local deletion, a replicated tombstone that
 * every cooperating client honours, and a screenshot-detection nudge. What we
 * must not do is inherit Telegram's implied promise that the message is gone.
 * The UI copy has to say "asks the other device to delete", not "deletes".
 * ------------------------------------------------------------------------- */

module.exports = {
  SCHEMA_VERSION,
  OP,
  EPHEMERAL,
  MAX_TEXT_BYTES,
  MAX_NAME_BYTES,
  messageId,
  msg,
  react,
  del,
  profile,
  addWriter,
  isValidOp
}
