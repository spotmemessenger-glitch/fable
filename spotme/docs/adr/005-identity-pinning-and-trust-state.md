# ADR-005 — Identity pinning and the trust state machine (A1)

**Status:** accepted for A1 (foundation only). A2–A5 amend this as they land.
**Supersedes nothing.** Builds on ADR-001 (`e2e_v2` ECDH) and ADR-003 (safety numbers).

---

## 1. The problem

ADR-003 shipped safety numbers: `safety-number.js` computes the 60 digits two
people compare, and `views/verify.js` displays them. **Nothing records the
answer.** Verification is something you look at and then lose.

That would be a gap on its own. It is worse in combination with the key-fetch
path, which as of `8f3cebc` does this:

| Location | Behaviour |
|---|---|
| `identity-store.js` — `roomKeyForConvo` | prefers the stored `convo.peerKey`, **but** `forceRefetch` bypasses it |
| `rooms.js` — `onPeerKeyChanged` | writes whatever came back **straight over** the stored value and persists it |
| `socket-transport.js` — `refreshRoomKey` | triggers that refetch **on decrypt failure** |

So a server able to provoke a decrypt failure can provoke a key rotation and
have it adopted silently and permanently. The safety number the users compared
is not consulted, because nothing stored what it proved.

**This is a Priority 1 security defect**, and A1 is the foundation for fixing
it. A1 changes no call site — see §7.

## 2. Five states, one total transition function

`Unverified · Pinned · Verified · Changed · Revoked`

Implemented in `src/lib/crypto/identity-pin.js` as a pure, total function.
Every `(state, event)` pair returns either a defined next state or a defined
error code from `ERR`. None throws. **None is a silent no-op** — a silent no-op
in a trust decision reads to the caller as *"recorded"* when it means
*"ignored"*, and the caller then tells the user the wrong thing.

The clock is an argument (`ev.at`), never an import, so ordering is testable
without faking globals and the module has no dormant side effects.

### 2.1 Decisions that are load-bearing

**`Changed` is sticky.** Re-observing the pinned key does *not* clear it. If it
did, an attacker could substitute a key, be seen, revert, and have the warning
disappear before any human looked at it. `Changed` is left only by an explicit
user action: `reject`, `accept`, `verify`, or `revoke`.

**`accept` lands on `Pinned`, never `Verified`.** Accepting means *"I
acknowledge and trust this new key enough to continue"*. It does not prove an
out-of-band comparison happened. Collapsing the two would let a user clear a
genuine MITM warning and end up with a verified badge they never earned.

**`verify` may reach `Verified` directly from `Changed`**, because a completed
QR scan or safety-number comparison is strictly stronger evidence than
acceptance. It binds **the key that was compared**: `applyEvent` matches the
supplied key against the stored pin or proposal and never re-fetches, so the
server cannot substitute a different key between comparison and commit.

**`reject` restores the *recorded* prior trust level**, not a hard-coded one.
A peer that was `Pinned` returns to `Pinned`; one that was `Verified` returns to
`Verified`. This is why `Changed` carries provenance (§2.2) — by rejection time
the only other way to answer *"what was this before?"* would be to ask the
server, and the server's answer is the thing in question. A record whose
provenance is missing or unrecognised falls back to `Pinned`, never `Verified`.

### 2.2 Transition context persisted with `Changed`

| Field | Why |
|---|---|
| `pinnedKey` / `pinnedAlgo` | the trusted key — **never** overwritten by an observation |
| `proposedKey` / `proposedAlgo` | what was seen instead |
| `priorState` | the trust level to restore on `reject` |
| `changedAt` | when the change was detected |
| `changeSource` / `changeReason` | who reported it and why they were asking — enough to tell a routine re-fetch from the decrypt-failure self-heal path, which is the one an attacker would drive |

The five user-visible states are unchanged by this; it is provenance behind
them.

### 2.3 Revocation, in A1

Only `local-action` can revoke. `signed-statement` is defined and deliberately
**unreachable**: `generateIdentity()` produces keys with `usages: ['deriveBits']`
— X25519 or P-256 ECDH — which cannot sign. Nothing in Spot Me can produce or
verify a revocation statement today.

**A server assertion cannot revoke.** It is refused with a defined error. A
server may deny service; that is a different fact from proving a peer's key was
retired, and conflating them would hand the server a route to force a re-pin —
the same substitution attack by another door. The `ServerDisabled` availability
status that expresses *"the server will not serve this peer"* is A6a, and is
deliberately **not** an identity state.

## 3. Canonical key encoding

Trust comparisons are string equality, so encoding differences are security
bugs in both directions. Two spellings of the *same* key — base64url, missing
padding, a stray newline — would compare unequal and raise a MITM warning
against a peer who did nothing; and a warning that fires on innocent input is
one users learn to click through.

`canonicalKey()` therefore decodes, length-checks against the curve lengths this
app actually issues (32 = X25519, 65 = P-256), and **re-encodes from the bytes**.
Anything else is `MALFORMED_KEY` and is refused rather than pinned. The stored
form is always canonical, so it cannot inherit an odd spelling of its input.

## 4. Why a separate IndexedDB database

`identity-pin-store.js` uses **`spotme-identity-pins`**, not `spotme-e2e`.

`identity-store.js` opens `spotme-e2e` at **version 1**. Adding an object store
there requires opening at version 2, and an existing connection at version 1
then fails with a `VersionError` — so a change that looks purely additive would
break the identity load path on any tab that had already opened it. Since A1's
whole condition is that it changes nothing, a second database is the honest
cost: one extra `open`, and no coupling.

### 4.1 Schema versioning policy

Two independent version numbers, on purpose:

- **Database version** (`DB_VERSION`, currently 1) — governs object stores and
  indexes. Bumped only when the *store layout* changes. `onupgradeneeded`
  creates `pins` if absent and must remain idempotent: a re-run that replaced
  the store would silently wipe every trust decision on the device.
- **Record version** (`SCHEMA_VERSION`, currently 1) — governs the *shape of a
  record*. Bumped when fields change. Upgrades happen in `migrateRecord()` on
  read, so exactly one place knows what old shapes looked like.

Record-level migration is deliberately the primary mechanism, because it needs
no database version bump and therefore cannot break a concurrently open tab.

Three refusals are as important as the upgrades:

- a record from a **newer** `SCHEMA_VERSION` is *not* downgraded into false
  trust — it is returned as `Unverified, unreadable: true`, because silently
  dropping fields we cannot see is how a `Verified` badge outlives the thing
  that justified it;
- a record claiming trust with **no key it trusts** is discarded;
- a record with an **unrecognised state** is discarded.

A half-understood trust record is worse than none, because the entire value of
this store is that its contents mean something specific.

### 4.2 Coordinating with `spotme-e2e` — no atomicity assumption

The two databases **cannot** be updated atomically, and nothing may be written
that assumes they can. There is no cross-database transaction in IndexedDB, and
a device can be killed between two writes.

The rule that makes this safe: **`spotme-identity-pins` is derived, never
authoritative for connectivity.** `spotme-e2e` holds the device's own identity
and the conversation records; the pin store holds an opinion *about peers*. So:

- **Pin store ahead of `spotme-e2e`** (a pin exists for a peer with no
  conversation): harmless. It is an opinion about a peer not currently in a
  room, and it applies when one is created.
- **`spotme-e2e` ahead of the pin store** (a conversation exists with no pin):
  the peer reads as `Unverified`, and the next observation pins it — TOFU,
  exactly as a fresh install behaves. No trust is fabricated.
- **A future migration touching both** must be written as two independently
  idempotent steps, each safe to run alone and safe to re-run, with the pin
  store's step designed to be the one that can be lost. Never a single logical
  migration split across the two.

## 5. Recovery: deleting or resetting the trust database

Losing `spotme-identity-pins` is **not** a silent event — it downgrades every
peer to `Unverified`, which means every peer must be verified again. It must
therefore never happen implicitly.

**Documented recovery flow:**

1. **Diagnose before deleting.** `allRecords()` returns every stored record. A
   record returned as `unreadable: true` came from a newer build — the fix is to
   update the app, *not* to delete the database.
2. **Prefer per-peer repair.** `forgetRecord(peerId)` drops one peer. A stuck
   `Changed` warning is resolved with `reject` (keep the pin) or `accept` (adopt
   the new key) — **not** by deleting anything. Deleting is not, and must not
   become, a way to clear a warning.
3. **Full reset is a user-visible action, never automatic.** Deleting the
   database is equivalent to *"forget every identity I have verified"*. Nothing
   in the app may do this on a schema error, a decrypt failure, or a failed
   open — those paths must surface a defined error instead. `_resetForTests()`
   drops only the cached connection, never data.
4. **After a reset**, every conversation returns to `Unverified` and re-pins on
   first observation. Users must be told to re-verify; a silent re-pin after a
   reset is indistinguishable from a successful substitution attack.
5. **A failed `open` is not cached** as permanent. Private browsing can deny once
   and allow later, and a wedged promise would leave the device unable to record
   trust for the whole session.

## 6. Rollback

**A1 is revertible with no data migration**, because nothing reads the store.

- **Reverting the code** leaves `spotme-identity-pins` on the device, orphaned
  and inert. Nothing opens it, and it consumes a few KB per peer. This is
  deliberate: **the revert must not delete it**, because a revert-and-reapply
  cycle would otherwise silently destroy verifications users performed.
- **Re-applying A1** finds the database intact and resumes from it. Records are
  re-read through `migrateRecord()`, so a record written by the reverted build
  is upgraded or refused by the rules in §4.1 rather than trusted blindly.
- **After A2–A5 land**, rollback stops being free: reverting to a build with no
  enforcement means a `Changed` peer is no longer blocked. That is a *reduction*
  in protection, not a data loss, and it is recoverable by re-applying. It must
  be stated in each of those PRs rather than inherited from this one.
- **Purging the database on rollback** is a separate, explicit operation with
  the consequences in §5. It is never part of reverting the code.

## 7. Scope of A1

**No call site changes.** No module imports `identity-pin.js` or
`identity-pin-store.js`; nothing observes keys through them; nothing is blocked
by them; nothing happens on import. The behaviour changes that use this land
separately and separately reversibly:

| | |
|---|---|
| **A2 + A3** (combined) | record pins on first use, turn the server-refetch path from *replace and persist* into *observe and propose*, and stop devices that cannot persist an identity from republishing replacements as if they were normal rotations — atomically, so no window exists where churn remains but recovery is gone |
| **A4** | connect QR and safety-number verification to persisted trust |
| **A5** | fail closed: `Changed` blocks sending until explicit review; `Revoked` blocks entirely |
| **A6a** | revocation *semantics* — cryptographically revoked vs locally revoked vs server-disabled |
| **A7** | signing-identity design, required before authenticated revocation transport |

## 8. Evidence

```
web suite 489 -> 637 assertions, 0 failures   (+148 from A1)
  identity pinning — trust state machine   113/113
  identity pinning — persistence            35/35
lint clean · build clean
```

All 30 `(state × event)` pairs are asserted **individually**, not as an
aggregate count, so a regression names the pair that broke.

Both suites are **mutation-tested**, because a test that cannot fail is not
evidence:

| Mutation | Result |
|---|---|
| `observe` overwrites the pin — the `rooms.js` bug, transplanted | **6 fail**, incl. `THE PIN IS NOT OVERWRITTEN by a different key` |
| read and write split across two transactions | **both concurrency assertions fail** |
| refused transition returns without aborting | `a refused transition ABORTS the transaction, observably` fails |
| canonicalisation removed, raw string compare | **6 fail**, incl. all three spelling-normalisation cases |

The store suite carries a richer IndexedDB fake than the repo's existing ones,
which return a fixed value and fire `oncomplete` on a microtask. The concurrency
claim needs a fake that *serialises* overlapping readwrite transactions and
*rolls back* on abort; testing it against a fake with no concurrency control
would be the same class of false pass as a green authorization test against a
server with no authorization. **The fake's own serialisation is asserted first**,
guarding the tests that depend on it.
