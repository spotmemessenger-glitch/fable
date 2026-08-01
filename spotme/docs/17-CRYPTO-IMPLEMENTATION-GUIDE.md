# 17 — Spot Me Cryptography Implementation Guide

**Audience:** a future engineer — possibly you in six months, possibly someone
new — who must understand, debug, extend, or activate Spot Me's end-to-end
encryption without having lived through building it.

**Read this before touching any file in `web/src/lib/crypto/` or
`backend/src/auth/`.** It is the "why" the code deliberately does not repeat at
every line. The "what" is in the code and the ADRs; this is the map.

> **Status when written (2026-08-01):** e2e_v3 (X3DH + Double Ratchet) and
> multi-device are IMPLEMENTED BEHIND FLAGS and NOT ACTIVATED. Everything here
> describes code that exists and is tested but does not run in production yet.

---

## 0. The one idea everything else follows from

**The server is the adversary.** Not "the server might be compromised" as a
footnote — the entire design assumes the server is actively trying to read
messages, and asks, for every feature, "what can a malicious server do here?"
If you ever find yourself trusting the server for a security property, you have
found a bug. The server is allowed to route, store ciphertext, and see metadata
(who talks to whom, when, how big). It must never be able to read content or
impersonate a user to their peers.

---

## 1. Why each protocol exists (the layer cake)

Each layer solves a problem the layer below it cannot. Do not collapse them.

| Layer | Solves | Because the layer below can't |
|---|---|---|
| **e2e_v1** (legacy) | nothing safely — key derives from two user ids via `cyrb53` | the server can recompute the key (R3). Kept only for existing rooms + wire compat; a *negative control* in tests. |
| **e2e_v2** (shipped) | server can't read a room | one static key per room: whoever gets it reads everything, forward and back |
| **A1–A5** (shipped) | detects a substituted key; can refuse to send to a changed/revoked peer | v2 has no notion of "is this the key I expect?" |
| **A7 signing identity** | a *durable, transferable proof* "this key was mine" | v2's agreement key is ephemeral; a verification pinned to it dies when the key rotates |
| **X3DH** | open a forward-secret session to an *offline* peer, asynchronously | you can't run an interactive handshake with someone who's offline |
| **Double Ratchet** | a fresh key per message; heal after a compromise | X3DH gives *one* shared secret — compromise it and the whole session falls |
| **Multi-device** | a safety number honest about a device *set* | a number over one device key lies about the others |

**The golden rule:** e2e_v3 (X3DH + ratchet) is built *on top of* the identity
layer (A1–A7). Its entire downgrade defence rests on the signing key being
authentic, which rests on the user checking a safety number. **v3 does not
replace verification; it depends on it.** Activating v3 before pinning/
verification is live builds forward secrecy on sand (004a §8a).

## 2. Why each ADR decision was made (the load-bearing choices)

- **ADR-001 (e2e_v2 over v1):** v1 keys are server-recomputable. v2 uses
  device-held X25519 ECDH so the server never has the private half.
- **ADR-005 (pin, propose-never-adopt):** a changed key is *proposed*, never
  silently accepted. Silent adoption is the substitution attack succeeding.
- **ADR-006 (a SEPARATE signing key):** the signing key (Ed25519) is distinct
  from the agreement key (X25519), with independent lifetimes. That asymmetry
  is the whole value: the agreement key may rotate while the signing identity
  persists, so a once-verified peer can vouch for its next agreement key.
- **ADR-007 (enforcement computes always, flag only gates biting):** a flag
  that *skips* the code it gates means the code first runs in anger the day
  it's switched on — the worst day to find it's wrong. So the verdict is always
  computed; the flag only decides whether it blocks.
- **ADR-008 (non-extractable, no backup, §12 rollback, §BLOCKING safety#):**
  non-extractable keys can't be exfiltrated *or* backed up — storage loss is
  identity loss, stated as a cost. Publication is one-way, so §12 requires an
  *executable* rollback (withdraw) before the first key ships. §BLOCKING defers
  the multi-device safety-number construction to the owner.
- **ADR-004/004a (own the ratchet; wire format frozen):** forward secrecy is
  mandatory for Priority 1, so the ratchet is built, not deferred. The wire
  format is pinned to the byte because two implementations disagree silently.
- **004c (Syndace as a vectors-only oracle):** an independent implementation
  of the *same spec* catches self-consistent mistakes; it is never a runtime
  dependency (it's Python; the client is JS).

## 3. Why these algorithms

| Choice | Why | Alternative rejected |
|---|---|---|
| **X25519** for agreement + ratchet DH | fast, misuse-resistant, WebCrypto-native | P-256 kept only as a *fallback* for old WebViews (recorded per identity) |
| **Ed25519** for signing | deterministic, small, no hash-at-call-site footgun | ECDSA-P256 fallback where Ed25519 is absent |
| **HKDF-SHA256** for all KDFs | standard extract-and-expand; domain-separated by `info` | — |
| **AES-256-GCM** | authenticated encryption; binds AAD (header/version/room) | — |
| **non-extractable CryptoKey** | the private half is a handle the page can compute with but cannot serialize | extractable+localStorage would hand any XSS the identity |
| **length-prefixed transcripts** | `["ab","c"]` and `["a","bc"]` must not sign identically | delimiter-join (`|`) collides on user-controlled fields |

**No primitive is hand-rolled.** Every one is WebCrypto's. If you are tempted
to implement a primitive, stop — that is a standing project constraint.

## 4. Message flow diagrams

### First contact (Alice opens a session to offline Bob)

```mermaid
sequenceDiagram
  participant A as Alice (client)
  participant S as Server (adversary)
  participant B as Bob (client, offline)
  Note over B,S: earlier — Bob published his bundle
  B->>S: PUT /v2/auth/signing-key (IK signing pub)
  B->>S: PUT /v2/auth/prekeys {SPK(+sig), OPK[]}
  Note over A: Alice wants to message Bob
  A->>S: GET /v2/auth/prekeys/bundle/bob?deviceId=…
  S-->>A: {ik, spk(+sig), opk?}   (server consumes one OPK atomically)
  A->>S: GET /v2/auth/signing-key/bob
  S-->>A: {signing pub}
  A->>A: verify sig(IK‖SPK) with Bob's signing key   ← STOPS a substituted bundle
  A->>A: X3DH → root0 → ratchet; seal msg0 (prologue header)
  A->>S: message {roomId, payload=v3 frame, …}
  Note over B: Bob comes online
  S-->>B: message
  B->>B: X3DH responder → same root0 → decrypt; from now on, ratchet
```

### Steady-state message (both established)

```mermaid
sequenceDiagram
  participant A as Alice
  participant B as Bob
  A->>A: messageStep(sendChain) → msgKey; seal(msgKey, IV, pt, AAD)
  A->>B: payload = MAGIC VER HDRLEN HEADER IV CT‖tag
  B->>B: parse → (new peer DH? DH-ratchet) → skip to N (bounded) → msgKey → open → delete key
```

## 5. State transition diagrams

### Trust state (A1–A5, per peer)

```
Unverified ──scan/compare──► Verified
    │                           │
    └──pin──► Pinned ◄──────────┘
                │
     peer key changes
                ▼
            Changed ──accept──► Pinned (new key, no "checked" claim)
                │   └─keep-old──► prior state
           revoke│
                ▼
             Revoked (blocks sends; never silently re-pinned)
```

### Signing-key lifecycle (ADR-008 / #39)

```
(none) ──PUT──► active ──POST supersede(old-key-signed)──► superseded (tombstone)
   ▲              │                                              │
   │         DELETE│                                     new row active
   │              ▼
   └──(never)── withdrawn (tombstone, served forever)
   a retired key NEVER returns; a fresh key after withdrawal may start a new chain
```

### Ratchet session (per conversation)

```
init (X3DH root) → sending/receiving chains
   on recv under NEW peer ratchet pub:  DH-ratchet (skip old chain to PN, new recv chain, new send chain)
   on recv within chain:  skip to N (store skipped keys, BOUNDED) → derive → open → DELETE key
   skipped keys: FIFO, ≤2000 stored, gap ≤1000, 7-day expiry → all fail CLOSED
```

## 6. Failure cases (and the required behavior)

| Failure | Required behavior | Where |
|---|---|---|
| Bundle SPK signature invalid | **refuse** to open a session (never fall back to unsigned) | `x3dh.verifyBundleSpk` |
| OPK pool empty | serve bundle with `opk:null`, wire OPKID=0xFFFFFFFF (visible weaker session) | `prekeys.service.fetchBundle` |
| Signing store unreadable/ephemeral | **never publish**; report the honest status | `signing-key-publication` gate |
| Ratchet gap > MAX_SKIP_PER_CHAIN | **refuse** with `RatchetError('SKIP_BOUND')`; never derive, never auto-reset | `ratchet.skipRecvChain` |
| Duplicate/replayed message | drop silently (key already consumed); never advance, never surface | `ratchet.decrypt` |
| Tampered ciphertext / wrong room | GCM tag fails → `RatchetError('AUTH')`; fail closed | `ratchet.open` |
| Version mismatch (v3 room, v1 frame) | refuse; **advance cursor, surface gap** (a mismatch is unrepairable) | activation-layer (004a §7) |
| Write didn't stick (Safari) | status `ephemeral`; refuse to publish | `signing-key-store` write-then-read-back |

**The anti-pattern to watch for:** a `try { verify() } catch {}` where the
catch means "accepted". Every verifier here funnels *all* failures to a single
`false`/throw so a stray catch cannot mean acceptance. Preserve that.

## 7. Security invariants (never violate these)

1. **A private key is never extractable and never serialized.** No `exportKey('pkcs8'|'jwk')`, no `wrapKey`, on any private key. (Fences enforce it.)
2. **The server never vouches for a signature.** It stores/serves `sig`
   opaquely; the *fetcher* verifies against the peer's published signing key.
3. **A message key is used exactly once**, then deleted. This is the
   precondition that makes the random-IV AEAD safe and gives replay protection.
4. **Bounds fail closed.** Crossing MAX_SKIP/MAX_SKIPPED/expiry loses messages
   with a defined error — never an unbounded loop, never a silent session reset
   (that trades forward secrecy for availability without telling anyone).
5. **Signed structures are length-prefixed**, never delimiter-joined, when any
   field is variable-length. Raw concatenation is allowed ONLY for fixed-width
   operands (e.g. IK‖SPK, both 32 bytes).
6. **The AAD binds version, room, and the full header.** A frame cannot be
   replayed into another room or re-versioned without failing the tag.
7. **e2eVersion is monotonic** — a write that lowers it must be rejected
   (required guard, added at activation, 004a §8).
8. **Fences stay green.** `signing-not-shipped` and `e2e-v3-not-shipped` failing
   means the gated crypto leaked into the app — treat as a build-breaking bug.

## 8. Common implementation mistakes (learned the hard way)

- **Deriving header length from a flag instead of reading HDRLEN.** Length is
  attacker-chosen; `HDRLEN` has exactly two legal values (73/145) and is checked
  *before* trusting FLAGS. (004a §3a keeps the "redundant" field on purpose.)
- **Swapping the message-step output halves.** `chain' || msgKey` — chain first,
  key second. Swapping passes a self-test and fails the vectors (it dropped
  Tier-1 conformance 13→10 in review). Always test against the oracle.
- **Random IV in a reproducible vector.** The oracle uses a *derived* IV so its
  output is reproducible; the shipping code MUST use a random IV. The seam is
  injected precisely so both can share one key schedule.
- **Treating an aborted read as an empty store** → regenerating over a key that
  was fine, which is unrecoverable (no backup). Fail closed to `unavailable`.
- **`json.dump` re-encoding em-dashes / reformatting** unrelated files into a
  diff. Edit surgically.
- **Comparing formatted safety numbers.** Compare the raw 60 digits; formatting
  is display-only.
- **A concurrency race on first load** (two callers → two identities). Cache the
  *promise*, not the value. (The A5 matrix caught this in the agreement store.)

## 9. Future extension points

- **SDEV/RDEV are already in the v3 header** for multi-device fan-out — the wire
  format does not need to change to add devices (004a §9).
- **`SAFETY_VERSION` is versioned and coexisting** — a new safety-number
  construction is a new version prefix + a coexistence period, never a silent
  swap (ADR-006). `device-set.js` is v1 alongside single-device v0.0.
- **The AEAD and keygen are injected seams** in the ratchet — a future AEAD or a
  hardware-backed keystore drops in without touching the key schedule.
- **The signing-key supersession chain** is the hook for a future revocation
  ledger (the retired `previousPublicKeyB64` is already returned).
- **Attachment per-message keys** (004d) are the next envelope extension.

## 10. Exactly how e2e_v3 is activated

**Do not do this until the owner authorizes it.** See `16-…` §17 for the full
sequence. In brief:

1. Ensure A1–A5 pinning/verification is live (v3's downgrade defence needs it).
2. Merge the reviewed X3DH split + Double Ratchet.
3. Build a *separate* activation PR: IndexedDB session persistence, the
   prologue-carrying header combined with the ratchet, attachment keys, and
   `reach.js`/`socket-transport.js` version negotiation with **visible**
   fallback to v2.
4. Add the `e2eVersion` monotonicity guard in `db.upsertConvo`.
5. Ship with `localStorage['spotme.e2e3']` **absent**; set `'on'` for internal
   accounts; widen by cohort. v2 stays the permanent negotiated fallback.
6. To roll back: unset the flag. (Removing v3 *code* strands existing v3 rooms —
   the flag is the rollback, not code removal.)

## 11. How to debug crypto failures

| Symptom | First checks |
|---|---|
| "message undecryptable" on a v3 room | is it a version mismatch (v1/v2 frame in a v3 room)? check MAGIC/VER/HDRLEN parse; is the ratchet chain out of sync (PN/N)? |
| session won't establish | did `verifyBundleSpk` fail (substituted/rotated signing key)? is the OPKID the sentinel (pool was empty)? |
| "identity changed" alarms after reinstall | expected — reinstall mints a new key; it's indistinguishable from an attack by design. The safety number is the check. |
| skipped-key errors / message loss | gap > MAX_SKIP_PER_CHAIN (refused) or > 7-day expiry (evicted) — both are *policy*, surface as undecryptable, not a bug |
| Safari: key "saved" but gone next launch | `signingKeyStatus()==='ephemeral'` — the write-then-read-back caught a silent put failure; do not publish |
| vectors fail after an edit | run `node spotme/docs/adr/004a-e2e-v3-vectors.mjs` and diff; run the ratchet oracle (§12) and diff the JSON |

**Never log keys, message keys, plaintext, or shared secrets.** Debug with
counters, statuses, and public values only. Telemetry is counts and timings.

## 12. Test vector generation process

The vectors are **reproducible**, not asserted — this is how you regenerate and
verify them if you change the protocol (which is a wire-breaking change and
needs a version bump).

**X3DH + KDF ladder + framing (`004a`):**
```bash
node spotme/docs/adr/004a-e2e-v3-vectors.mjs   # prints hex; the spec §10 must match
```
Fixed private keys are repeating bytes (0x11…0x55) so they can never be mistaken
for real ones. The client test (`web/test/x3dh.test.js`) pins these exact values.

**Double Ratchet conformance (`004b`) — the Syndace oracle:**
```bash
pip install 'DoubleRatchet==1.3.0' 'X3DH==1.3.0'   # MIT; pinned wheel hashes in 004c
python3 spotme/docs/adr/004b-e2e-v3-ratchet-vectors.py > /tmp/vectors.json
diff <(jq -S . /tmp/vectors.json) <(jq -S . spotme/docs/adr/004b-e2e-v3-ratchet-vectors.json)  # must be empty
```
The oracle injects Spot Me's labels/AAD/framing (it is NOT the library's
defaults — those would silently become our wire format). It is a **vectors-only
oracle**, never a runtime dependency, never in `package.json`. The ratchet test
(`web/test/ratchet.test.js`) reproduces the oracle's ciphertext byte-for-byte by
injecting the same deterministic keygen and derived-IV AEAD; the *shipping*
ratchet uses a random IV and random keygen and cannot reproduce those bytes —
that's expected and is why the seams are injected.

**If you change any label, salt, field order, or the AAD:** you have changed the
wire. Bump the protocol version, regenerate all vectors, and treat existing v3
rooms as unreadable by the new code (they must be — that's forward secrecy of
the format itself).

---

## Appendix — file map

| File | Role |
|---|---|
| `web/src/lib/crypto/e2e-v2.js` | shipped v2 agreement (X25519 ECDH → HKDF → AES-GCM) |
| `web/src/lib/crypto/safety-number.js` | single-device safety number (v0.0) |
| `web/src/lib/crypto/device-set.js` | multi-device safety number (v1, proposal) |
| `web/src/lib/crypto/signing-identity.js` | A7 Ed25519 signing + length-prefixed transcript |
| `web/src/lib/crypto/identity-binding.js` | bindings + proof-of-possession (HISTORICAL vs LIVE) |
| `web/src/lib/crypto/signing-key-store.js` | non-extractable signing-key storage (ADR-008) |
| `web/src/lib/crypto/signing-key-publication.js` | publication client (flag OFF) + supersession signing |
| `web/src/lib/crypto/x3dh.js` | X3DH handshake (pure) |
| `web/src/lib/crypto/ratchet.js` | Double Ratchet (pure) |
| `backend/src/auth/signing-transcript.ts` | server mirror of the transcript + supersession verify |
| `backend/src/auth/signing-keys.service.ts` | signing-key lifecycle (publish/supersede/withdraw) |
| `backend/src/auth/prekeys.service.ts` | prekey publish + atomic single-use bundle fetch |
| `docs/adr/004*·006·008·013` | the specs this guide summarizes |
