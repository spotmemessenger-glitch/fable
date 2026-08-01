/**
 * Spot Me — the identity trust state machine. PURE. No storage, no DOM, no
 * network, no clock.
 *
 * WHAT GAP THIS EXISTS FOR. `safety-number.js` can already produce the 60
 * digits two people compare, and `views/verify.js` already displays them — but
 * nothing anywhere records the ANSWER. Verification is a thing you look at and
 * then lose. Meanwhile `identity-store.js` stores `convo.peerKey` at creation,
 * `roomKeyForConvo` will re-fetch when `forceRefetch` is set, and `rooms.js`
 * writes whatever came back straight over the stored value. So a server that
 * can provoke a decrypt failure can provoke a key rotation and have it adopted
 * silently. This module is where "which key did we agree was theirs, and how
 * sure are we" becomes a fact that survives a reload.
 *
 * WHAT THIS MODULE DOES NOT DO, DELIBERATELY. It is not wired to anything. No
 * call site imports it, nothing observes keys through it, nothing is blocked by
 * it. That is the whole shape of this first change: the state machine and its
 * persistence land as a tested foundation, and the behaviour changes that USE
 * it — recording pins on first use, connecting verification, and finally
 * failing closed — are separate, separately reversible steps.
 *
 * THE CLOCK IS AN ARGUMENT, NOT AN IMPORT. Every event carries `at`. A module
 * that reads `Date.now()` itself cannot be tested for ordering without faking
 * globals, and "no dormant side effects" has to mean this too.
 *
 * TOTALITY. `applyEvent` never throws for any (state, event) pair. Invalid
 * combinations return `{ ok: false, error: { code, message } }` with a defined
 * code. A silent no-op would be worse than an error: the caller could not tell
 * "we recorded your verification" from "we ignored it".
 */

/* --------------------------------------------------------------- states --- */

export const UNVERIFIED = 'Unverified'
export const PINNED = 'Pinned'
export const VERIFIED = 'Verified'
export const CHANGED = 'Changed'
export const REVOKED = 'Revoked'

export const STATES = Object.freeze([UNVERIFIED, PINNED, VERIFIED, CHANGED, REVOKED])

/* --------------------------------------------------------------- events --- */

export const OBSERVE = 'observe'
export const VERIFY = 'verify'
export const ACCEPT = 'accept'
export const REJECT = 'reject'
export const REVOKE = 'revoke'
export const CLEAR_REVOCATION = 'clearRevocation'

export const EVENTS = Object.freeze([OBSERVE, VERIFY, ACCEPT, REJECT, REVOKE, CLEAR_REVOCATION])

/* --------------------------------------------------------------- errors --- */

/**
 * Defined, enumerable, and stable. The UI has to be able to say something
 * specific and recoverable — "this key is not the one you verified" is
 * actionable, "something went wrong" is not.
 */
export const ERR = Object.freeze({
  NO_PIN: 'NO_PIN',
  KEY_MISMATCH: 'KEY_MISMATCH',
  NOTHING_PROPOSED: 'NOTHING_PROPOSED',
  REVOKED: 'REVOKED',
  NOT_REVOKED: 'NOT_REVOKED',
  MISSING_KEY: 'MISSING_KEY',
  MALFORMED_KEY: 'MALFORMED_KEY',
  UNKNOWN_EVENT: 'UNKNOWN_EVENT',
  UNKNOWN_STATE: 'UNKNOWN_STATE',
})

const fail = (code, message) => ({ ok: false, error: { code, message } })

/* ------------------------------------------------- canonical key form --- */

/** Raw byte lengths of the identity keys this app issues, from e2e-v2.js.
 *  Anything else is not one of our keys and is refused rather than pinned. */
const RAW_LEN = Object.freeze({ 32: 'X25519', 65: 'P-256' })

const b64encode = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

/**
 * ONE canonical encoding, because trust comparisons are string equality.
 *
 * Two encodings of the SAME key — base64url instead of base64, padding
 * stripped, a stray newline from a copy-paste — would compare unequal and
 * therefore read as a key SUBSTITUTION: the user gets a MITM warning for a peer
 * who did nothing. The opposite is worse but rarer. So every key entering the
 * machine is decoded, length-checked against the curves this app actually
 * issues, and re-encoded to the single form that gets stored and compared.
 *
 * Returns null for anything that is not one of our identity keys, and callers
 * turn that into a defined MALFORMED_KEY error rather than pinning it.
 */
export function canonicalKey (input) {
  if (typeof input !== 'string' || !input) return null
  // Whitespace anywhere, and base64url's alphabet, both normalise away.
  let s = input.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const pad = s.length % 4
  if (pad === 1) return null           // never a valid base64 length
  if (pad) s += '='.repeat(4 - pad)
  let bytes
  try {
    const bin = atob(s)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } catch {
    return null
  }
  if (!RAW_LEN[bytes.length]) return null
  // Re-encoded from the BYTES, so the stored form cannot inherit an odd
  // spelling of the input.
  return b64encode(bytes)
}

/** The curve implied by a canonical key's length, or null. */
export const algoOf = (key) => {
  const c = canonicalKey(key)
  if (!c) return null
  return RAW_LEN[atob(c).length] || null
}

/** Only trusted sources may retire an identity. A server assertion is NOT one:
 *  a server can deny service, which is a different thing from proving that a
 *  peer's key was retired, and conflating them hands the server a way to force
 *  a re-pin. `signed-statement` is reserved and not yet reachable — nothing in
 *  Spot Me can sign today, because identity keys are generated for
 *  `deriveBits` only. */
export const REVOCATION_SOURCES = Object.freeze(['local-action', 'signed-statement'])

/** How many history entries a record keeps. Bounded because this is persisted
 *  per peer and an unbounded audit log on a device is a storage leak, not a
 *  feature. Oldest entries are dropped first. */
export const HISTORY_LIMIT = 50

/* ---------------------------------------------------------------- shape --- */

export const SCHEMA_VERSION = 1

/**
 * A fresh record. Nothing is trusted and nothing has been seen.
 * No secret material is ever stored here — public keys only.
 */
export function emptyRecord (peerId) {
  return {
    schemaVersion: SCHEMA_VERSION,
    peerId,
    state: UNVERIFIED,
    pinnedKey: null,
    pinnedAlgo: null,
    proposedKey: null,
    proposedAlgo: null,
    /**
     * PROVENANCE, not a guess. What `Changed` must fall back to when the user
     * rejects a proposal — recorded at the moment the change was detected,
     * because by rejection time the only other way to answer "what was this
     * before?" would be to ask the server, and the server is the thing whose
     * answer is in question. Rejection is never hard-coded to Verified: a peer
     * that was merely Pinned returns to Pinned.
     */
    priorState: null,
    /** Who reported the differing key, and why they were asking. Enough to
     *  tell a routine re-fetch from the decrypt-failure self-heal path, which
     *  is the one an attacker would drive. */
    changeSource: null,
    changeReason: null,
    pinnedAt: null,
    verifiedAt: null,
    changedAt: null,
    revocation: null,
    updatedAt: null,
    history: [],
  }
}

const clone = (rec) => ({ ...rec, history: rec.history.slice() })

function note (rec, at, event, from, to, detail) {
  const history = rec.history.concat([{ at, event, from, to, ...(detail ? { detail } : {}) }])
  rec.history = history.length > HISTORY_LIMIT ? history.slice(history.length - HISTORY_LIMIT) : history
  rec.updatedAt = at
  return rec
}

/* ----------------------------------------------------------- transitions --- */

function onObserve (rec, ev) {
  if (!ev.key) return fail(ERR.MISSING_KEY, 'observe requires a key')
  const key = canonicalKey(ev.key)
  if (!key) return fail(ERR.MALFORMED_KEY, 'not a well-formed identity key')
  ev = { ...ev, key, algo: ev.algo ?? algoOf(key) }
  const from = rec.state
  const next = clone(rec)

  if (from === REVOKED) {
    // Recorded, but it changes nothing. A revoked identity publishing a key is
    // information; it is not grounds for re-trusting it.
    note(next, ev.at, OBSERVE, from, REVOKED, 'observed while revoked')
    return { ok: true, next, changed: false }
  }

  if (from === UNVERIFIED) {
    next.state = PINNED
    next.pinnedKey = ev.key
    next.pinnedAlgo = ev.algo ?? null
    next.pinnedAt = ev.at
    note(next, ev.at, OBSERVE, from, PINNED, 'first use')
    return { ok: true, next, changed: true }
  }

  if (from === CHANGED) {
    // STICKY, and this is the load-bearing decision in this module.
    //
    // If observing the pinned key again cleared the warning, an attacker could
    // substitute a key, be seen, then revert — and the warning would disappear
    // before any human looked at it. So `Changed` is resolved only by an
    // explicit human decision. The cost is that a peer who legitimately
    // rotates and rotates back still needs a click; `reject` makes that one
    // click, and until A5 nothing is blocked by it either way.
    if (ev.key !== next.proposedKey && ev.key !== next.pinnedKey) {
      next.proposedKey = ev.key
      next.proposedAlgo = ev.algo ?? null
      next.changedAt = ev.at
      next.changeSource = ev.source ?? null
      next.changeReason = ev.reason ?? null
      note(next, ev.at, OBSERVE, from, CHANGED, 'a different key again')
      return { ok: true, next, changed: true }
    }
    note(next, ev.at, OBSERVE, from, CHANGED, 'still unresolved')
    return { ok: true, next, changed: false }
  }

  // PINNED or VERIFIED
  if (ev.key === next.pinnedKey) {
    note(next, ev.at, OBSERVE, from, from, 'unchanged')
    return { ok: true, next, changed: false }
  }

  // THE ONE THAT MATTERS. The pin is NOT overwritten. Everything downstream
  // keeps deriving against the key the user actually agreed to.
  next.state = CHANGED
  next.priorState = from
  next.proposedKey = ev.key
  next.proposedAlgo = ev.algo ?? null
  next.changedAt = ev.at
  next.changeSource = ev.source ?? null
  next.changeReason = ev.reason ?? null
  note(next, ev.at, OBSERVE, from, CHANGED, `proposed while ${from.toLowerCase()}`)
  return { ok: true, next, changed: true }
}

function onVerify (rec, ev) {
  if (!ev.key) return fail(ERR.MISSING_KEY, 'verify requires a key')
  // Canonicalised the SAME way the pin was, so the comparison below is between
  // two forms of the same thing. Verification must bind the key that was
  // actually compared out of band — never whatever the server returns at
  // commit time — so the caller passes the compared key in and it is matched
  // against the stored pin or proposal, not re-fetched.
  const key = canonicalKey(ev.key)
  if (!key) return fail(ERR.MALFORMED_KEY, 'not a well-formed identity key')
  ev = { ...ev, key }
  const from = rec.state
  if (from === REVOKED) return fail(ERR.REVOKED, 'this identity is revoked')
  if (from === UNVERIFIED) return fail(ERR.NO_PIN, 'nothing has been pinned to verify')

  const next = clone(rec)

  if (from === CHANGED) {
    if (ev.key === next.proposedKey) {
      // Stronger evidence than `accept`: a completed comparison binds THIS key.
      next.state = VERIFIED
      next.pinnedKey = next.proposedKey
      next.pinnedAlgo = next.proposedAlgo
      next.pinnedAt = ev.at
      next.verifiedAt = ev.at
      next.proposedKey = null
      next.proposedAlgo = null
      next.priorState = null
      next.changeSource = null
      next.changeReason = null
      note(next, ev.at, VERIFY, from, VERIFIED, 'verified the proposed key')
      return { ok: true, next, changed: true }
    }
    if (ev.key === next.pinnedKey) {
      // Verifying the ORIGINAL key resolves the change in the pin's favour.
      next.state = VERIFIED
      next.verifiedAt = ev.at
      next.proposedKey = null
      next.proposedAlgo = null
      next.priorState = null
      next.changeSource = null
      next.changeReason = null
      note(next, ev.at, VERIFY, from, VERIFIED, 'verified the pinned key; proposal dropped')
      return { ok: true, next, changed: true }
    }
    return fail(ERR.KEY_MISMATCH, 'that key is neither the pinned nor the proposed one')
  }

  if (ev.key !== next.pinnedKey) {
    return fail(ERR.KEY_MISMATCH, 'that key is not the pinned one')
  }

  next.state = VERIFIED
  next.verifiedAt = ev.at
  note(next, ev.at, VERIFY, from, VERIFIED, from === VERIFIED ? 're-verified' : 'verified')
  return { ok: true, next, changed: from !== VERIFIED }
}

function onAccept (rec, ev) {
  const from = rec.state
  if (from === REVOKED) return fail(ERR.REVOKED, 'this identity is revoked')
  if (from !== CHANGED) return fail(ERR.NOTHING_PROPOSED, 'there is no proposed key to accept')

  const next = clone(rec)
  // PINNED, never straight to VERIFIED. Accepting is "I believe this is them";
  // verifying is "I checked". Collapsing the two would let a user clear a
  // genuine MITM warning and end up with a green tick they never earned.
  next.state = PINNED
  next.pinnedKey = next.proposedKey
  next.pinnedAlgo = next.proposedAlgo
  next.pinnedAt = ev.at
  next.verifiedAt = null
  next.proposedKey = null
  next.proposedAlgo = null
  next.priorState = null
  next.changeSource = null
  next.changeReason = null
  note(next, ev.at, ACCEPT, from, PINNED, 'accepted the new key; verification cleared')
  return { ok: true, next, changed: true }
}

function onReject (rec, ev) {
  const from = rec.state
  if (from === REVOKED) return fail(ERR.REVOKED, 'this identity is revoked')
  if (from !== CHANGED) return fail(ERR.NOTHING_PROPOSED, 'there is no proposed key to reject')

  const next = clone(rec)
  // The RECORDED prior state, never an inference and never hard-coded. A peer
  // that was merely Pinned returns to Pinned; one that was Verified returns to
  // Verified. PINNED is the fallback only for a record carrying no provenance
  // at all, which means a corrupted row rather than a normal transition.
  const to = STATES.includes(next.priorState) ? next.priorState : PINNED
  next.state = to
  next.proposedKey = null
  next.proposedAlgo = null
  next.priorState = null
  next.changedAt = null
  next.changeSource = null
  next.changeReason = null
  note(next, ev.at, REJECT, from, to, 'kept the pinned key')
  return { ok: true, next, changed: true }
}

function onRevoke (rec, ev) {
  const source = ev.source
  if (!REVOCATION_SOURCES.includes(source)) {
    // The point of the whole split: a server saying "this user is gone" is a
    // transport fact, and must not arrive here at all.
    return fail(ERR.UNKNOWN_EVENT, `revocation source "${source}" is not trusted`)
  }
  const from = rec.state
  const next = clone(rec)
  next.state = REVOKED
  next.revocation = {
    source,
    reason: ev.reason ?? null,
    at: ev.at,
    // Public evidence only. Never key material, never a shared secret.
    evidence: ev.evidence ?? null,
  }
  next.proposedKey = null
  next.proposedAlgo = null
  next.priorState = null
  note(next, ev.at, REVOKE, from, REVOKED, source)
  return { ok: true, next, changed: from !== REVOKED }
}

function onClearRevocation (rec, ev) {
  if (rec.state !== REVOKED) return fail(ERR.NOT_REVOKED, 'this identity is not revoked')
  const next = clone(rec)
  // Back to knowing nothing — NOT back to the old pin. A mistaken revocation
  // must be recoverable, but recovering it cannot silently restore trust that
  // was explicitly thrown away.
  const kept = next.history
  Object.assign(next, emptyRecord(rec.peerId))
  next.history = kept
  note(next, ev.at, CLEAR_REVOCATION, REVOKED, UNVERIFIED, 'trust reset to nothing')
  return { ok: true, next, changed: true }
}

const HANDLERS = {
  [OBSERVE]: onObserve,
  [VERIFY]: onVerify,
  [ACCEPT]: onAccept,
  [REJECT]: onReject,
  [REVOKE]: onRevoke,
  [CLEAR_REVOCATION]: onClearRevocation,
}

/**
 * The transition function. Total: every (state, event) pair returns either
 * `{ ok: true, next, changed }` or `{ ok: false, error: { code, message } }`,
 * and never throws.
 *
 * `changed` distinguishes "this was accepted and altered the record" from
 * "this was accepted and was a no-op", so a caller can skip a write.
 *
 * @param {object} rec   a record from `emptyRecord` or storage
 * @param {{type: string, at: number, key?: string, algo?: string,
 *          source?: string, reason?: string, evidence?: object}} ev
 */
export function applyEvent (rec, ev) {
  if (!rec || !STATES.includes(rec.state)) {
    return fail(ERR.UNKNOWN_STATE, `not a valid record state: ${rec && rec.state}`)
  }
  const handler = HANDLERS[ev && ev.type]
  if (!handler) return fail(ERR.UNKNOWN_EVENT, `unknown event: ${ev && ev.type}`)
  if (typeof ev.at !== 'number') return fail(ERR.UNKNOWN_EVENT, 'every event needs a numeric `at`')
  return handler(rec, ev)
}

/**
 * Normalise a record read from storage.
 *
 * Records written by an older schema are upgraded here rather than at the call
 * site, so there is exactly one place that knows what old shapes looked like.
 * An unreadable record becomes a FRESH one rather than being trusted: a
 * half-understood trust record is worse than no trust record, because the whole
 * value of this store is that its contents mean something specific.
 */
export function migrateRecord (raw, peerId) {
  if (!raw || typeof raw !== 'object') return emptyRecord(peerId)

  const version = typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0
  if (version > SCHEMA_VERSION) {
    // Written by a NEWER build — another tab on a version this one predates.
    // Refusing is right: silently downgrading would drop fields we cannot see.
    return { ...emptyRecord(peerId), unreadable: true, foundVersion: version }
  }

  const base = emptyRecord(peerId)
  if (version === 0) {
    // Pre-versioning shape. Nothing has ever shipped one, so this exists to
    // make the upgrade PATH real and tested rather than hypothetical — the
    // first time it is needed must not be the first time it is exercised.
    const state = STATES.includes(raw.state) ? raw.state : UNVERIFIED
    return {
      ...base,
      state,
      pinnedKey: raw.pinnedKey ?? raw.key ?? null,
      pinnedAlgo: raw.pinnedAlgo ?? raw.algo ?? null,
      pinnedAt: raw.pinnedAt ?? null,
      verifiedAt: raw.verifiedAt ?? null,
      history: Array.isArray(raw.history) ? raw.history.slice(-HISTORY_LIMIT) : [],
      updatedAt: raw.updatedAt ?? null,
      schemaVersion: SCHEMA_VERSION,
    }
  }

  const merged = { ...base, ...raw, peerId, schemaVersion: SCHEMA_VERSION }
  if (!STATES.includes(merged.state)) return emptyRecord(peerId)
  // A record claiming trust without a key it trusts is incoherent, and trusting
  // it would mean deriving against null.
  if (merged.state !== UNVERIFIED && merged.state !== REVOKED && !merged.pinnedKey) {
    return emptyRecord(peerId)
  }
  if (!Array.isArray(merged.history)) merged.history = []
  return merged
}

/** Whether a state means "a human has confirmed this exact key". */
export const isVerified = (rec) => !!rec && rec.state === VERIFIED

/** Whether a state should stop traffic once A5 lands. Advisory until then. */
export const isBlocking = (rec) => !!rec && (rec.state === CHANGED || rec.state === REVOKED)

/** The key traffic should use, or null if there is none to trust. Never returns
 *  a merely PROPOSED key — that is the entire point of holding the pin. */
export function trustedKey (rec) {
  if (!rec || rec.state === UNVERIFIED || rec.state === REVOKED) return null
  return rec.pinnedKey || null
}
