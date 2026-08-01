# ADR-008 — Where a signing key lives

**Status:** Design only. **Nothing in this ADR is implemented**, and no
production signing key may be generated or published until it is reviewed.
**Depends on:** ADR-006 (the signing identity), ADR-005 (pin store precedent).

## Why this exists before any code

ADR-006 ships a signing foundation that is deliberately unreachable. Publishing
a signing key is one-way — the moment one exists in the field it is the anchor
peers pin — so the storage design has to be settled *before* the first key is
minted, not discovered afterwards. Every question below has a wrong answer that
is only expensive after keys exist.

## 1. Non-extractable `CryptoKey`, in IndexedDB

Same reasoning as `identity-store.js`, and it is not a preference. localStorage
stores strings, so putting a key there forces `extractable: true` and
serialisation — at which point any XSS walks off with the identity permanently
and ADR-006's non-extractability argument becomes decoration. IndexedDB stores
live `CryptoKey` objects through structured clone, so the private half
round-trips as an opaque handle and `extractable === false` survives.

**Consequence, stated plainly: the private key can never be backed up, exported,
or transferred.** That is the point, and §6 is where the cost lands.

## 2. Schema and versioning

A **third** database, `spotme-signing`, at version 1, store `identity`,
out-of-line key `self`.

Not a store inside `spotme-e2e` and not inside `spotme-identity-pins`, for the
reason ADR-005 §4 gives: adding a store means bumping that database's version,
and an open connection at the old version fails with a `VersionError`. A
separate database keeps this additive, which is the condition it lands under.

The record: `{ algo, publicKey, privateKey, publicKeyB64, createdAt, schemaVersion }`.
`schemaVersion` is *inside* the record as well as on the database, exactly as the
pin store does — two levels, because a record can outlive the schema that wrote
it when a user runs an older build in another tab.

## 3. Portability

Ed25519 in WebCrypto landed considerably later than X25519. A device perfectly
able to do v2 agreement may have no Ed25519, so `negotiateSigningAlgo()` records
`Ed25519` or `ECDSA-P-256` **per identity** and the algorithm is stored with the
key. A device must never assume its own algorithm when reading back.

**Open, and it must be answered before generation:** whether storing a
non-extractable Ed25519 `CryptoKey` in IndexedDB actually round-trips on Safari
and on the Android System WebView. It has historically failed for other key
types on Safari, by rejecting the request rather than throwing anywhere visible.
`identity-store.js` verifies its write by reading it back for exactly this
reason, and this must do the same.

## 4. Restart persistence, and the honest failure

Write, then **read back and prove it stuck**, then cache. `persisted: false` is
the honest answer to "will this survive a reload", and it gates publication the
same way `publishIdentity` is gated today.

A device that cannot persist a signing key **must not publish one**. Publishing
an ephemeral signing key is strictly worse than publishing an ephemeral
agreement key: peers pin it as an identity anchor, and it is gone on the next
launch, so every conversation shows an identity change the user cannot explain.

## 5. Logout and device wipe

`wipeDevice` must delete `spotme-signing` alongside `spotme-e2e` and
`spotme-identity-pins`, and must clear the module-level cache — the same two
halves `forgetIdentity()` exists for. A cached key surviving a wipe would be
republished under the next account, which is precisely what a wipe prevents.

**Wiping is irreversible and ends that identity.** The UI must say so in those
words, because §6 means it is true.

## 6. Backup, migration, recovery — the cost of §1

There is **no backup and no recovery**. A non-extractable key cannot be
exported, so storage loss is identity loss: the device generates a new signing
key, publishes it, and every peer sees an identity change.

The alternatives, and why neither is taken here:

- **An extractable key** would allow backup and would undo the property the key
  exists to have.
- **A wrapped key escrowed to a passphrase** is a real design used by other
  messengers, needs a key-derivation and recovery-phrase flow Spot Me does not
  have, and is a much larger change than A7.

So recovery is **out of scope and must be documented in the UI**, not left for a
user to discover. Deferring it is acceptable per the migration plan's
multi-device carve-out; pretending it exists is not.

## 7. Multi-tab concurrency

`loadIdentity`'s race (PR #30) is the precedent and must not be repeated: cache
the **promise**, not the resolved value, so concurrent callers share one load.
Two tabs on a first launch each generating and writing a signing key would leave
the published key different from the one some sessions hold.

Beyond one tab there is no cross-tab lock; IndexedDB serialises overlapping
`readwrite` transactions on a store, which is what the pin store relies on, and
the same applies here.

## 8. Corruption

A record that reads back without a `privateKey`, or whose `algo` is unknown, or
whose `schemaVersion` is **newer than this build understands**, is treated as
**unreadable, not absent**. The distinction is the ADR-005 §4.1 rule and the
`identity-store.js` "an aborted read is not an empty store" lesson: treating an
unreadable record as empty leads to generating a replacement over the top of a
key that was fine, and there is no copy.

Unreadable ⇒ report the store unavailable, write nothing, publish nothing.

## 9. Device replacement

A new device gets a **new signing key**. There is no transfer (§6). Peers see a
new identity, which is a legitimate trust event and must be surfaced as one —
this is exactly the case ADR-006 §Context is trying to make cheap for agreement
keys, and it does **not** solve it for the signing key itself.

## 10. Relationship to the agreement key

Independent lifetimes, on purpose. The agreement key may rotate freely while the
signing key persists; that asymmetry is the entire value of A7. The binding
(ADR-006) is what ties a current agreement key to the persistent identity.

They live in **separate databases** so that losing one does not implicitly lose
the other, and so a future change to either schema cannot version-block the other.

## 11. Does creating a signing key change safety numbers?

**Not on its own, and not until a separate, explicitly versioned change says so.**

Today the displayed number is computed over the *agreement* key with
`VERSION = [0x00, 0x00]`, and `SAFETY_VERSION` is already bound into the QR
payload. Moving the number to the signing key is a new construction, a new
version prefix, and a coexistence period — it is ADR-006's "not implemented
here", and it must not happen as a side effect of a key appearing in a database.

## 12. Rollback

**Before any key is published:** free. Delete the database, revert the code;
nothing external ever saw anything.

**After a key is published:** *not* free, and this is the line the owner is
being asked to authorise. Reverting the client leaves a signing key on the
server that peers may have pinned. The revert must therefore either withdraw the
published key server-side or leave it standing and inert — and which of those is
correct depends on a server API that does not exist yet.

**No publishing change may land until that question has an answer**, because a
rollback plan that cannot be executed is not a rollback plan.

## BLOCKING DESIGN QUESTION — safety numbers under multi-device

Recorded here and in ADR-006 rather than left as a note, because it blocks the
multi-device work and cannot be resolved inside a signing-foundation PR.

**A single-device fingerprint cannot honestly represent a multi-device identity.**
Once a user has a device *set*, sixty digits derived from one device's key say
nothing about the others, and two people comparing them would be verifying
something narrower than what they believe they are verifying.

The options, none yet chosen:

1. **One device-to-device key pair** — what exists today. Honest only while a
   user has exactly one device.
2. **A user identity key plus an authenticated device set** — the number covers
   the account key; devices are authenticated *to* it. Needs an account-level key,
   which needs the transfer or escrow §6 rules out.
3. **A Merkle or hash commitment to the active device set** — the number changes
   when the device set changes, which is honest and means adding a device is a
   visible verification event for every contact.
4. **Another explicitly versioned account-level construction.**

**This must be decided before multi-device is implemented, not during.** Whatever
is chosen becomes a new `SAFETY_VERSION`, and the coexistence rules in ADR-006
apply.

## Implementation status — updated 2026-08-01 (Roadmap V2 Phase 2, first half)

**§1–§5, §7–§10 are IMPLEMENTED** in `web/src/lib/crypto/signing-key-store.js`
(`spotme-signing` v1, record-level `schemaVersion`, promise-cached load,
write-then-read-back with an honest `ephemeral` status, corruption and
newer-schema treated as UNREADABLE-not-absent, wipe integration in
`wipeDevice`, explicit-only rotation returning the retired public key for the
future revocation ledger). Covered by `test/signing-key-store.test.js`,
`test/wipe-device.test.js`, and `test/bench/signing-store.bench.mjs`
(cold ~0.3 ms median / read-back ~0.01 ms on the Node fake; the browser adds
disk cost, measured in the Phase 6 hardware pass).

**Still design-only, deliberately:** §4's publication gate consumer, §6's UI
warnings, §11's safety-number interaction, and **all of §12** — publication and
rollback-after-publication are the second Phase 2 PR, because the server-side
published-key lifecycle must exist in the same change that first publishes.
`test/signing-not-shipped.test.js` now fences the store too: the app may reach
exactly `forgetSigningIdentity` (the wipe), and nothing else.

**Rotation semantics (addendum to §9):** rotation within a device exists and is
explicit-only — never on a timer, never on an error path. Pre-publication it is
a local affair; post-publication every rotation must carry the signed
supersession statement the publication PR introduces, and the returned
`previousPublicKeyB64` is what that statement names.
