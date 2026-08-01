/**
 * Spot Me — where this device's SIGNING identity lives. Implements ADR-008.
 *
 * Phase 2 of Roadmap V2 Priority 1, first half: STORAGE ONLY. Nothing here
 * publishes a key, mints a server record, or makes a signing key reachable
 * from the app's runtime — `test/signing-not-shipped.test.js` still enforces
 * that, now with this module inside the fence. Publication and
 * rollback-after-publication are the second half, in their own PR, because
 * ADR-008 §12 says a published key needs a server-side lifecycle to exist
 * BEFORE the first key is published, and that lifecycle is a reviewable
 * change of its own.
 *
 * WHY A THIRD DATABASE. `spotme-e2e` (agreement identity) and
 * `spotme-identity-pins` (peer trust) are both at version 1 with live
 * connections in other tabs. Adding a store to either means a version bump,
 * and an open v1 connection then fails with VersionError — a change that looks
 * additive would break the identity load path in every already-open tab
 * (ADR-005 §4 learned this once). `spotme-signing` costs one more `open` and
 * keeps this genuinely additive.
 *
 * THE RECORD NEVER LEAVES. The private key is generated non-extractable and
 * stored as a live CryptoKey via structured clone, exactly as
 * `identity-store.js` does — localStorage would force `extractable: true` and
 * serialisation, at which point any XSS owns the identity permanently.
 * Consequence, stated because ADR-008 §6 requires it stated: THERE IS NO
 * BACKUP AND NO RECOVERY. Storage loss is identity loss. The eventual UI must
 * say so before key creation and before destructive actions, and must never
 * imply account recovery restores identity trust.
 *
 * EVERY LESSON FROM identity-store.js IS APPLIED, NOT RE-LEARNED:
 *   - the load PROMISE is cached, not just the value — two concurrent first
 *     loads must not generate two identities (the A5 matrix found this race
 *     live in the agreement store; PR #30 fixed it there)
 *   - an aborted read is NOT an empty store — generating over a record we
 *     merely failed to read destroys a key that has no copy
 *   - a write is proven by reading it back — Safari has historically rejected
 *     CryptoKey puts without throwing anywhere visible, and `persisted: false`
 *     is what stops a future publication path from replacing a good record
 *     with an ephemeral one
 *   - a record from a NEWER schema, or one missing its private key, is
 *     UNREADABLE, not absent (ADR-008 §8) — report unavailable, write nothing
 */
import { generateSigningIdentity, exportSigningPublicKeyB64 } from './signing-identity.js'

const DB_NAME = 'spotme-signing'
const DB_VERSION = 1
const STORE = 'identity'
const SELF = 'self'

/** Record-level schema version, independent of the database version — a record
 *  can outlive the build that wrote it when an older build runs in another tab
 *  (ADR-005 §4.1 precedent). */
export const SIGNING_SCHEMA_VERSION = 1

function openDb () {
  return new Promise((resolve, reject) => {
    let req
    try { req = indexedDB.open(DB_NAME, DB_VERSION) } catch (err) { reject(err); return }
    req.onupgradeneeded = () => {
      try { req.result.createObjectStore(STORE) } catch (err) { reject(err) }
    }
    req.onsuccess = () => {
      const db = req.result
      // A live connection blocks wipeDevice's `deleteDatabase` until it closes:
      // `deleteDatabase` fires `versionchange` at every open connection. Close
      // on notice so the app does not block its own wipe.
      db.onversionchange = () => db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('signing store is blocked by another connection'))
  })
}

function tx (db, mode, fn) {
  return new Promise((resolve, reject) => {
    let t
    try { t = db.transaction(STORE, mode) } catch (err) { reject(err); return }
    const out = fn(t.objectStore(STORE))
    // Same guard as identity-store.js: a MISS resolves `result` to undefined,
    // and `?? out` would hand back the IDBRequest itself.
    t.oncomplete = () => resolve(out && typeof out === 'object' && 'result' in out ? out.result : out)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error || new Error('transaction aborted'))
  })
}

let cached = null
let loading = null
let openFailed = false
/** ADR-008 §8: an unreadable record is a DISTINCT state from an absent one.
 *  It means "a record exists and this build must not touch it", and the only
 *  safe report is unavailable — never a silent regeneration. */
let unreadable = false

/** Is a stored record one this build may trust and use? */
function readable (rec) {
  if (!rec || typeof rec !== 'object') return false
  if (!rec.privateKey || !rec.publicKey || typeof rec.publicKeyB64 !== 'string') return false
  if (typeof rec.schemaVersion !== 'number' || rec.schemaVersion > SIGNING_SCHEMA_VERSION) return false
  return true
}

/**
 * This device's signing identity: `{ algo, publicKey, privateKey,
 * publicKeyB64, createdAt, schemaVersion, persisted? }`, or null when the
 * store cannot serve one (private mode, corruption, newer schema).
 *
 * Generates ON FIRST USE — but note what "use" means today: NOTHING in the
 * app calls this. The suite exercises it; the first runtime caller arrives
 * with the publication PR, behind its own gate. That is the ADR-006 gating
 * pattern carried forward: the capability is real and tested, and switching
 * it on is a deliberate change whose subject is switching it on.
 */
export async function loadSigningIdentity () {
  if (cached) return cached
  // Promise-cached so concurrent first callers share one load — the exact race
  // the A5 matrix caught in the agreement store. Cleared on settle so a denied
  // open (private mode can refuse once and allow later) stays retryable.
  if (!loading) loading = loadOnce().finally(() => { loading = null })
  return loading
}

async function loadOnce () {
  if (cached) return cached
  unreadable = false
  let db
  try { db = await openDb() } catch { openFailed = true; return null }
  openFailed = false

  /* AN ABORTED READ IS NOT AN EMPTY STORE. The branch below GENERATES and
   * writes; taking it because a read threw would put a fresh key over one that
   * was fine, and a non-extractable key has no copy. Fail closed: report the
   * store unavailable and write nothing. */
  let found
  try {
    found = await tx(db, 'readonly', (s) => s.get(SELF))
  } catch {
    openFailed = true
    return null
  }

  if (found !== undefined) {
    if (!readable(found)) {
      /* A record EXISTS and this build cannot vouch for it — missing private
       * key, or written by a newer schema. Overwriting it is the one
       * unrecoverable move (ADR-008 §8), so the honest answer is "the store is
       * unavailable to this build", loudly. */
      unreadable = true
      console.warn(
        'spotme signing: a stored signing record exists but is not readable by ' +
        'this build (corrupt, or written by a newer version). Refusing to ' +
        'touch it — see ADR-008 §8.'
      )
      return null
    }
    cached = found
    return cached
  }

  // Genuinely empty: first use on this device.
  const fresh = await generateSigningIdentity()
  const record = {
    algo: fresh.algo,
    publicKey: fresh.publicKey,
    privateKey: fresh.privateKey,
    publicKeyB64: await exportSigningPublicKeyB64(fresh),
    createdAt: Date.now(),
    schemaVersion: SIGNING_SCHEMA_VERSION,
  }

  /* WRITE, THEN PROVE IT STUCK. `persisted: false` is not decoration: the
   * future publication path must refuse to publish an ephemeral signing key,
   * because peers would pin an identity that evaporates on the next launch —
   * strictly worse than the agreement-key version of the same bug, which
   * "only" broke conversations rather than trust anchors. */
  let persisted = false
  try {
    await tx(db, 'readwrite', (s) => s.put(record, SELF))
    const readBack = await tx(db, 'readonly', (s) => s.get(SELF))
    persisted = readable(readBack)
  } catch {
    persisted = false
  }
  if (!persisted) {
    console.warn(
      'spotme signing: this device cannot persist its signing key. It exists ' +
      'for this session only and MUST NOT be published — see ADR-008 §4.'
    )
  }
  cached = { ...record, persisted }
  return cached
}

/**
 * The device's signing-key situation, synchronously, for the UI and for the
 * publication gate. Same ladder as `identityStatus()`, plus the state that
 * store has no equivalent of:
 *
 *   'ok'          persists across reloads
 *   'ephemeral'   generated, write did not stick — must never be published
 *   'unavailable' the database would not open or read
 *   'unreadable'  a record EXISTS that this build must not touch (ADR-008 §8)
 *   'unknown'     nothing has asked yet
 */
export function signingKeyStatus () {
  if (cached) return cached.persisted === false ? 'ephemeral' : 'ok'
  if (unreadable) return 'unreadable'
  return openFailed ? 'unavailable' : 'unknown'
}

/**
 * Drop the in-memory identity so the next load starts clean.
 *
 * `wipeDevice` deletes the database, but this cache outlives it — without this
 * a "wiped" device keeps the old private key live for the rest of the page,
 * which is precisely what a wipe exists to prevent. Same two-halves rule as
 * `forgetIdentity()` and `forgetAllTrust()`.
 */
export function forgetSigningIdentity () {
  cached = null
  loading = null
  openFailed = false
  unreadable = false
}

/**
 * Replace this device's signing key with a fresh one. EXPLICIT ONLY.
 *
 * Rotation is a trust event, not maintenance: once publication exists, every
 * peer that pinned the old key sees an identity change. So this is never
 * called on a timer, never on an error path, and never silently — the future
 * caller is a deliberate user action plus, post-publication, a signed
 * supersession statement (that half lives with the publication PR).
 *
 * Returns `{ ok, previousPublicKeyB64, next }`. The previous public key is
 * handed back because the revocation flow will need to say WHICH key was
 * retired; this module deliberately does not remember it — retired keys are
 * the revocation system's ledger, not the store's.
 *
 * REFUSES when the current record is unreadable or the store is unavailable:
 * rotating over a record we merely failed to read would destroy a key that
 * might be fine (§8), and rotating into a store that cannot persist would
 * trade a durable identity for an ephemeral one.
 */
export async function rotateSigningIdentity () {
  const current = await loadSigningIdentity()
  if (unreadable) {
    return { ok: false, error: { code: 'UNREADABLE', message: 'a stored record exists that this build cannot read — refusing to rotate over it' } }
  }
  if (!current) {
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'the signing store is unavailable — a rotation would not survive' } }
  }
  if (current.persisted === false) {
    return { ok: false, error: { code: 'EPHEMERAL', message: 'this device cannot persist a signing key — rotating gains nothing and loses the session key' } }
  }

  let db
  try { db = await openDb() } catch { return { ok: false, error: { code: 'UNAVAILABLE', message: 'store would not open' } } }

  const fresh = await generateSigningIdentity()
  const record = {
    algo: fresh.algo,
    publicKey: fresh.publicKey,
    privateKey: fresh.privateKey,
    publicKeyB64: await exportSigningPublicKeyB64(fresh),
    createdAt: Date.now(),
    schemaVersion: SIGNING_SCHEMA_VERSION,
  }
  try {
    await tx(db, 'readwrite', (s) => s.put(record, SELF))
    const readBack = await tx(db, 'readonly', (s) => s.get(SELF))
    if (!readable(readBack) || readBack.publicKeyB64 !== record.publicKeyB64) {
      return { ok: false, error: { code: 'WRITE_FAILED', message: 'the rotated key did not persist — the previous key remains in effect' } }
    }
  } catch {
    return { ok: false, error: { code: 'WRITE_FAILED', message: 'the rotated key did not persist — the previous key remains in effect' } }
  }

  const previousPublicKeyB64 = current.publicKeyB64
  cached = { ...record, persisted: true }
  return { ok: true, previousPublicKeyB64, next: cached }
}
