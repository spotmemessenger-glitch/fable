# e2e_v3 — decision record

**Status: APPROVED WITH REVISIONS, 2026-08-01.** Companion to ADR-004,
`004a` (schema) and `004b` (vectors).

**This record is docs-only. No ratchet implementation exists, and none belongs
in PR #15.** Implementation is sequenced separately and begins with identity
pinning (Q4), not with the ratchet.

---

## Q1 — Reference implementation · **APPROVED, vectors-only**

**Syndace `DoubleRatchet` + `X3DH`, as a conformance oracle. Never a production
runtime dependency.**

### Pinned

```
DoubleRatchet==1.3.0   sha256 a869c81aa175abd9d7cfcf0069a0fa1261116b2ff2684c1ac95a1b83b875b18d
X3DH==1.3.0            sha256 92548974e0cd9eccf19315f59014e5796ee4c5440b6fe753a9168fb92dd6c914
cryptography==41.0.7   (transitive; Apache-2.0 OR BSD-3-Clause)

generator environment  Python 3.11.15 · Linux-6.18.5-x86_64-with-glibc2.39
```

Both packages are MIT, confirmed from installed package metadata rather than
from a web page.

**Reproduction:**

```bash
pip install 'DoubleRatchet==1.3.0' 'X3DH==1.3.0'
python3 spotme/docs/adr/004b-e2e-v3-ratchet-vectors.py > vectors.json
diff vectors.json spotme/docs/adr/004b-e2e-v3-ratchet-vectors.json   # must be empty
```

The wheel hashes above are the authoritative pin — they are what
`pip install --require-hashes` verifies, and what a CI job should assert.

**Upstream source commit SHAs are NOT recorded here.** This environment's proxy
returns 403 for the unauthenticated GitHub API, so they could not be fetched and
will not be guessed. A reviewer with network access can obtain them with:

```bash
git ls-remote --tags https://github.com/Syndace/python-doubleratchet
git ls-remote --tags https://github.com/Syndace/python-x3dh
```

They should be added to this section when available. The wheel hashes already
pin the artifact that is actually executed, so reproduction is not blocked on
this — but provenance back to source is weaker until it is filled in.

### It is an oracle, not the definition of the protocol

Where the Signal specifications are silent, **`004a` makes an explicit Spot Me
decision and both sides follow it.** Copying library behaviour is prohibited,
because that is how an implementation detail silently becomes a wire format.

Two such decisions have already been taken rather than inherited:

1. **Skipped-key eviction is FIFO** — stated in `004a` §5, not adopted because
   the library happens to do it.
2. **Expiry and resource bounds are Spot Me's**, in full. The upstream
   implementation deletes skipped keys **only** when the maximum count is
   reached, in FIFO order; it has **no time-based or event-based deletion at
   all.** So the 7-day expiry, and every other lifecycle rule, exists only if
   Spot Me implements it. The oracle cannot validate it and must not be
   mistaken for doing so.

### Not a production dependency

It is Python; the client is browser JavaScript. That mismatch is deliberate —
there is no path by which the oracle becomes the shipping implementation. It
must never appear in `web/package.json` or `backend/package.json`.

---

## Q2 — +33 bytes per message · **ACCEPTED**

This is now part of the `e2e_v3` wire format. **Once merged and deployed, the
meaning of those bytes must not change under protocol version 3.**

Required before the format is frozen — tracked in `004a`:

| Requirement | Where |
|---|---|
| Canonical byte serialization pinned | `004a` §5c |
| Exact minimum and maximum envelope sizes | `004a` §2a |
| Malformed-length and truncation tests | `004a` §11, tests 19–22 |
| Unknown-field and unknown-version behaviour | `004a` §7, §11 tests 16–17 |
| Overhead benchmarked for small messages and high-volume conversations | **outstanding** — Priority 1 benchmark report |
| No field reconstructable instead of transmitted | `004a` §3a |

---

## Q3 — Bounds 1000 / 2000 / 7 days · **PROVISIONAL DEFAULTS ONLY**

**Accepted as configurable defaults. The seven-day expiry is NOT frozen as a
protocol-level invariant and must not be described as one until measured.**

`004a` §5 now states this explicitly, so a later reader cannot mistake a default
for a guarantee.

### Required measurements — none of which exist yet

- Memory and IndexedDB growth at each bound
- Processing time for large sequence gaps
- Deliberately hostile skipped-message patterns
- Devices offline for more than seven days
- Out-of-order delivery near and beyond each limit
- Recovery behaviour after eviction
- User-visible behaviour when an old message can no longer be decrypted

### Failure behaviour — mandatory

The implementation must **fail closed** with a **defined protocol error**. It
must not:

- loop
- allocate without limit
- silently lose state
- automatically reset the session

An automatic session reset is singled out because it is the tempting fix and it
is a downgrade: it would discard forward secrecy to recover availability,
silently.

Bounds are **centrally configurable** and reported in telemetry — counts and
timings only, **never keys or message content**.

---

## Q4 — Identity pinning · **APPROVED, AND IT LANDS BEFORE v3 ACTIVATION**

**Identity pinning and verification must ship before `e2e_v3` is activated.**

### Identity states

| State | Meaning | UI obligation |
|---|---|---|
| **Unverified** | Key seen, never confirmed | Visibly unverified — not neutral, not silent |
| **Pinned** | Key recorded for this peer | Baseline for change detection |
| **Verified** | Confirmed by safety number or QR | Positively indicated |
| **Changed** | Pinned key replaced by a different one | **Security event; requires explicit recovery or re-verification** |
| **Revoked** | Key withdrawn | Refuse; no silent re-pin |

### Rules

- **Silent TOFU is not sufficient** to claim protection from a malicious server
  at first contact, and this document must not imply otherwise.
- An initial unverified conversation **may** be supported as an explicit product
  decision — but it must be **visibly unverified**.
- After pinning, an unexpected identity-key change is **never silently
  accepted.** It raises a security event and requires an explicit flow.
- **QR and safety-number verification are required by Priority 1.** ADR-003 and
  PRs #12/#14 shipped the primitive and the screen; pinning and the state machine
  above are what remain.

---

## Q5 — Own or defer · **A: Spot Me owns the ratchet integration, after Q4**

### What "own" means — precisely

Spot Me owns:

- Protocol behaviour and `e2e_v3` framing
- Session and device lifecycle
- Ratchet-state persistence
- **Transaction boundaries**
- Skipped-key handling
- Multi-device fan-out
- Migration and rollback
- Error and recovery behaviour
- Compatibility tests and vectors

### What it explicitly does NOT mean

**Do not implement cryptographic primitives from scratch.** Use established
platform or audited primitives. Specifically **do not write**: AES, Curve25519,
signatures, HKDF, hashing, random-number generation, or constant-time
arithmetic.

All of those exist in WebCrypto, which is what ADR-004 established: we write a
**state machine**, not mathematics. This distinction is the whole basis on which
"own the ratchet" is a defensible answer rather than a reckless one.

### Why not libsignal

Signal's `libsignal` exposes TypeScript through a **native Node add-on**,
**states that outside use is unsupported**, and is **AGPL-3.0**. It is therefore
not an appropriate browser production dependency on three independent grounds,
any one of which would be sufficient.

Syndace remains a **vector generator only**.

---

## Mandatory design requirements

No longer observations. These are required parts of the design and are specified
in `004a` §9a.

### Attachments

- Generate a **random key per attachment**.
- Carry that key **inside the ratcheted message envelope**.
- **Persist it with the decrypted message record**, so lazy retrieval does not
  depend on retaining a deleted message key.
- **View-once deletion must remove both the bytes and the retained attachment-key
  material.** Deleting one and not the other is the failure mode: bytes without a
  key look deleted but are not, and a key without bytes is a live secret for an
  object the bucket may still hold.

### Replay and idempotency

Decryption and durable cursor advancement have a **defined transactional
order**. Retrying an already-decrypted envelope must not:

- lose the message
- advance the ratchet twice
- regenerate an attachment record

### Forbidden key surface — expanded

Prohibited from logs, Redux/devtools, analytics, crash reports, URLs, ordinary
`localStorage`, and server payloads:

ratchet state · chain keys · root keys · skipped-message keys · attachment keys ·
identity private keys · prekey private material

This widens phase A's `FORBIDDEN_KEY_SURFACE`, which today covers adapters only
and does not name any ratchet term.

### Nonce

**Production encryption uses the ADR-approved random nonce/IV.** The reference
generator's derived nonce is a reproducibility device for vectors and **must not
be inherited.**

---

## What remains open

- Every Q3 measurement.
- Q2's overhead benchmark.
- Upstream source commit SHAs for the oracle (§Q1).
- Multi-device fan-out is named in Q5's ownership list but **is not designed**;
  `004a` §9 says so.
- No implementation exists. The sequence begins with identity pinning, proposed
  as small, independently testable and reversible PRs, and returned for review
  **before** any cryptographic implementation starts.
