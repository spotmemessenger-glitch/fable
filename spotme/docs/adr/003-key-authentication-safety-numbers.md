# ADR-003 — Key authentication before forward secrecy

**Status:** Accepted · **Date:** 2026-08-01 · **Follows:** ADR-001 · **Phase:** 1a

## Context

A "complete Signal Protocol architecture" was requested: X3DH, Double Ratchet,
signed and one-time prekeys, safety numbers, QR verification, multi-device sync,
and key custody in Android Keystore / iOS Secure Enclave. This ADR records why
only **one** piece of that shipped first, and what gates the rest.

### What exists today, read from source

`web/src/lib/crypto/e2e-v2.js` — X25519 (P-256 fallback) → ECDH → HKDF-SHA256 →
non-extractable AES-GCM-256, with `info` binding the key to the room id and both
public keys. `identity-store.js` holds a **non-extractable** identity in
IndexedDB, reports `identityStatus()`, and refuses to republish an ephemeral key
over a good one.

Legacy `e2e_v1` rooms keep the `cyrb53` secret. They are server-recomputable,
labelled legacy in the UI, and deliberately not migrated — migrating destroys
their history.

### Why that is insufficient

`e2e-v2.js` names the hole in its own header: **the server hands out the public
keys.** `GET /api/v2/auth/keys/:userId` is the only source of a peer's key, so a
malicious or compromised server can answer with a key it holds the private half
of, agree one room key with each side, relay between them, and read everything —
while both clients display `e2e_v2` and every test passes.

That makes the ECDH partly decorative against the one adversary the product
promises protection from. Forward secrecy does not help here: a ratchet started
from a substituted key ratchets the attacker's session forward just as happily.

**Key authentication is therefore logically prior to forward secrecy**, not a
lesser feature to add afterwards.

## Alternatives considered

| Option | What it buys | What it costs |
|---|---|---|
| **A. Safety numbers + QR** (chosen) | Detects key substitution, including at first contact. Pure function of two identity keys | No forward secrecy. Requires humans to actually compare |
| **B. Full X3DH + Double Ratchet first** | Forward secrecy, break-in recovery | Prekey tables, exhaustion handling, a new message envelope, and **an unresolved licence question** (below). Does not detect substitution — a ratchet over a MITM'd key is still MITM'd |
| **C. TOFU pinning** — trust the first key seen, warn on change | Very cheap; catches later substitution | **Misses substitution at first contact**, which is exactly when a server would strike. Strictly weaker than A, and A subsumes it |

### The licence question that gates option B

**libsignal is AGPL-3.0.** ADR-001 already rejected it on those grounds: linking
it obliges Spot Me to publish its own source. That leaves three paths, and all
three are decisions for the owner, not the engineer:

1. Accept AGPL and open-source Spot Me.
2. Obtain a commercial licence from Signal (rarely granted).
3. Hand-roll a Double Ratchet.

Option 3 is how projects ship subtly broken cryptography. A ratchet is not hard
to write and is very hard to write *correctly* — out-of-order handling, skipped
message keys, header encryption and chain-key erasure each have failure modes
that leave the transcript readable while every test still passes.

**Until that decision is made, no responsible ratchet work can start.**

## Decision

Ship **safety numbers with QR verification** as Phase 1a.

Signal's displayable-fingerprint construction, followed rather than invented:
per party, `SHA-512(version ‖ key ‖ identifier)` iterated 5,200 times over
`(hash ‖ key)`; first 30 bytes; six 5-byte groups; each big-endian, mod 100000,
zero-padded to five digits. The two 30-digit strings are **sorted** and joined
into 60 digits.

- **5,200 iterations** make grinding a substitute key with a colliding display
  string expensive. A single hash would not.
- **The identifier is the account id, not the username.** `usernameRelease`
  renames a row, so a fingerprint bound to a name would change hands with it.
- **Sorting** means both devices compute the identical string without either
  needing to know who goes first.
- **The QR carries the two public keys and ids — never the digits.** A code
  carrying only the display string would verify nothing an attacker could not
  also print. The scanner recomputes and compares; divergence is the detection.

**Not Signal-interoperable.** The construction is the same, the version prefix
and identifier bytes are Spot Me's, so numbers differ between the apps. What is
bought is the security argument and the human factors (60 digits in groups of
five, sized to be read aloud), not compatibility.

## Consequences

- Nothing about the wire format, the room key or stored history changes. This
  computes over keys both devices already hold, so **there is no migration and
  no risk to existing conversations.**
- `e2e_v1` rooms have no per-device identity key, so they have no safety number.
  The UI must say that rather than showing an empty screen.
- **Cost is real and measured: ~750 ms per number** (two parties, 10,400
  SHA-512s) on a cloud container; slower on a phone. It must be derived when the
  verification screen opens, behind a spinner, and cached against the two public
  keys — never on the render path.
- Verification state is not yet persisted, so this detects substitution *when a
  human looks*. Storing "verified at key X" and warning on change is the natural
  next increment and is not in this ADR.

## What is explicitly NOT delivered

Stated plainly so no one reads this as "Signal Protocol, done":

- **No forward secrecy, no break-in recovery.** Static pairs. One stolen device
  key still opens that pair's whole v2 history. Gated on the licence decision.
- **No X3DH, no signed prekeys, no one-time prekeys**, so no asynchronous
  session setup with a party who has never been online.
- **No Ed25519 signing.** Identity keys are agreement-only.
- **No multi-device sync.** A second device generates a different identity and
  cannot read the first's v2 rooms.
- **No hardware-backed custody.** The Android app is a Capacitor WebView;
  non-extractable WebCrypto keys are the strongest primitive available *in that
  context*. Android Keystore would need a native plugin and a different custody
  model. **There is no iOS project at all**, so Secure Enclave is not
  addressable. The three storage backends in the brief reduce, today, to the one
  already implemented.
- **No verification persistence or UI.** This ADR ships the primitive and its
  tests; the screen that displays it is the next increment.

## Rollback

Delete `web/src/lib/crypto/safety-number.js` and its test, and remove the test
from `package.json`. Nothing else imports it, no schema changed, no wire format
changed, and no stored data is touched — rollback is a file deletion with no
migration and no user-visible effect beyond losing the primitive.
