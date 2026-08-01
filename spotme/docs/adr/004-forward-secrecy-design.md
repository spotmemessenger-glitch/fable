# ADR-004 — Forward secrecy: library selection and design

**Status: PROPOSED — awaiting approval. No production code has been written.**
**Date:** 2026-08-01 · **Follows:** ADR-001, ADR-003 · **Priority:** 1

Owner's constraint: **no AGPL-licensed code or dependencies.** That excludes
libsignal, whose licence was verified as AGPL-3.0 on 2026-08-01.

---

## 1. Audit — what exists now

| Layer | Today |
|---|---|
| Agreement | X25519 ECDH (P-256 fallback) → HKDF-SHA256, bound to roomId + both public keys |
| Content | AES-GCM-256, non-extractable `CryptoKey` |
| Identity | **Non-extractable** X25519 pair in IndexedDB. The private key is a handle the page can compute with but *cannot serialise* |
| Authentication | Safety numbers + verify screen (ADR-003) |
| Legacy | `e2e_v1` cyrb53 rooms, server-recomputable, labelled, unmigrated |

**The gap:** static pairs. One stolen device key opens that pair's entire v2
history. No forward secrecy, no break-in recovery, no asynchronous session setup.

## 2. The constraint that decides this

**A WASM crypto library cannot use a non-extractable `CryptoKey`.**

WASM operates on bytes in linear memory. Handing vodozemac or OpenMLS our
identity key means exporting it as raw bytes — which requires generating it
`extractable: true` in the first place. ADR-001 chose non-extractable
deliberately: *"the `false` is the whole point... no bug, no XSS and no
malicious build can upload it."*

So adopting a WASM ratchet **trades a property we have for a property we want.**
That trade is the real decision here, and it is not visible from the feature
list alone.

## 3. Options compared

All facts below were verified against upstream on 2026-08-01, not recalled.

| | **libsignal** | **vodozemac** | **OpenMLS** | **Own implementation** |
|---|---|---|---|---|
| **Licence** | **AGPL-3.0** ❌ excluded | Apache-2.0 ✅ | MIT ✅ | n/a ✅ |
| **Protocol** | Signal (X3DH + Double Ratchet) | Olm (Double Ratchet) + Megolm | MLS, RFC 9420 | Double Ratchet + X3DH |
| **Maintenance** | Active | Crate active | Active — Phoenix R&D + Cryspen, ~1,946 commits | Ours |
| **JS/WASM bindings** | Node native only, no WASM | **Official bindings UNMAINTAINED** — repo states "no longer actively maintained… you will need to extract and update them on your own". Third-party forks exist (`@towns-protocol/vodozemac`, `vodozemac-wasm-bindings`) | `openmls-wasm` in-tree | Native WebCrypto |
| **Security maturity** | Highest; the reference | Crate audited by Least Authority, no significant findings | No audit found | **None — this is the risk** |
| **Adoption** | Signal, WhatsApp-scale derivatives | Matrix ecosystem | Growing; RFC-backed, pre-mass-adoption | n/a |
| **Performance** | Native | Rust/WASM, fast | Rust/WASM, fast | WebCrypto is native code; ratchet steps are HMAC/HKDF — cheap |
| **Non-extractable identity key** | ❌ lost | ❌ lost | ❌ lost | ✅ **preserved** |
| **New toolchain** | Rust + native build | Rust + wasm-pack | Rust + wasm-pack | none |
| **Migration complexity** | n/a | High — fork and maintain bindings ourselves | High — different protocol model, group-first | Medium — new envelope, same transport |
| **Sustainability** | n/a | **We inherit maintenance of an unmaintained binding layer** | Upstream healthy | We own it forever |

### Why each rejected option is rejected

**libsignal** — AGPL-3.0. Excluded by the owner. Not negotiable.

**vodozemac** — the crate is the strongest candidate on paper: Apache-2.0,
audited, Double Ratchet, Matrix-proven. But the *only* thing Spot Me could
consume is the JavaScript/WASM binding layer, and upstream has declared that
layer unmaintained. Adopting it means either forking and maintaining WASM
bindings to a Rust crate — permanently, for a security-critical dependency, with
no Rust expertise on the project — or depending on a third-party fork whose
longevity is unknown. **An audited crate behind an unmaintained binding is not
an audited dependency.**

**OpenMLS** — MIT, healthy, RFC-backed, and genuinely the direction the industry
is moving. Rejected *for now* on three grounds: MLS is group-first and its 1:1
story is heavier than X3DH; no security audit was found; and it forfeits the
non-extractable key for a protocol change larger than the problem being solved.
**Worth revisiting for group encryption**, which Spot Me has not solved either.

## 4. Recommendation

**Implement the Double Ratchet ourselves on WebCrypto — with the scope
deliberately narrowed and the risk explicitly bought down.**

This is not the comfortable answer and it deserves stating plainly: **hand-rolled
ratchets are how projects ship crypto that looks correct and is not.** The
recommendation rests on four things being true here:

1. **It is the only option that preserves the non-extractable identity key.**
   Every WASM path trades our strongest existing property away.
2. **The dangerous parts are avoidable.** The classic ratchet failure modes —
   header encryption, skipped-key storage, out-of-order handling — are mostly
   driven by the *asynchronous group* case. Spot Me needs 1:1 first.
3. **The primitives are not ours.** X25519, HKDF-SHA256, AES-GCM and Ed25519 are
   all native WebCrypto. Verified today: `Ed25519` generates in this runtime, so
   signed prekeys need no polyfill. We write the *state machine*, not the maths.
4. **It is testable against published vectors.** The ratchet is deterministic
   given its inputs, so correctness can be pinned rather than hoped for.

**If the owner is not comfortable owning a ratchet, the honest alternative is to
ship nothing here and keep ADR-003's authentication as the Priority 1 outcome.**
Forward secrecy done wrong is worse than forward secrecy deferred.

### Risk mitigations, non-negotiable if this is approved

- **Differential test vectors** from a reference implementation, checked in.
- **Fuzz the message-ordering state machine** — drops, duplicates, reorders,
  and gaps larger than the skipped-key bound.
- **A hard bound on stored skipped keys**, with a documented drop policy. This
  is the memory-exhaustion vector.
- **Ship behind a flag, `e2e_v3`, defaulting off.** v1 and v2 continue untouched.
- **No group ratchet.** 1:1 only. Groups stay as they are.

## 5. Design

```mermaid
graph LR
  subgraph Device
    IK[Identity key<br/>X25519 non-extractable]
    SPK[Signed prekey<br/>Ed25519-signed]
    OPK[One-time prekeys]
    ST[(Ratchet state<br/>IndexedDB)]
  end
  subgraph Server
    KS[(PreKeyBundle store)]
  end
  IK -->|public| KS
  SPK -->|public + signature| KS
  OPK -->|public batch| KS
  KS -->|bundle| Peer[Peer device]
  Peer -->|X3DH| RK[Root key]
  RK --> CK[Chain keys] --> MK[Message keys]
  MK --> AES[AES-GCM payload]
```

```mermaid
sequenceDiagram
  participant A as Alice
  participant S as Server
  participant B as Bob (offline)
  B->>S: publish IK, SPK+sig, OPK batch
  A->>S: GET /api/v3/keys/:userId
  S-->>A: bundle (one OPK consumed)
  A->>A: X3DH -> root key; init sending chain
  A->>S: msg{header: EK, PN, N; ciphertext}
  Note over S: server stores ciphertext + header only
  B->>S: join / replay
  S-->>B: frames
  B->>B: X3DH from own keys -> same root
  B->>B: DH ratchet on header EK; derive message key
  Note over A,B: every message advances the chain;<br/>old keys are erased
```

## 6. Migration strategy

**Additive and versioned, exactly as ADR-001 was.** A room's `e2eVersion`
becomes one of `e2e_v1` (legacy) · `e2e_v2` (current, static ECDH) · `e2e_v3`
(ratchet). **Decided at creation, never migrated.** v1 and v2 rooms keep their
history and keep working, unchanged.

v3 is attempted only when: the flag is on, both devices publish a v3 bundle, and
agreement actually produces a session. Any failure falls back to v2 — visibly,
not silently, following the pattern already proven in `reach.js`.

## 7. Rollback

- **Before rollout:** delete the module and the flag. Nothing else references it.
- **After rollout:** set the flag off. New rooms resume at v2. Existing v3 rooms
  keep working, since their state is local and their code path stays in the
  bundle. **A v3 room cannot be downgraded to v2** — its history would be
  unreadable. Removing v3 code strands those rooms, so the flag is the rollback,
  not code removal.
- **Server:** the prekey tables are additive. Dropping them breaks new v3
  sessions only.

## 8. Changes required

**Database** — new tables, no changes to existing ones:
`SignedPreKey(userId, keyId, publicKey, signature, createdAt)` ·
`OneTimePreKey(userId, keyId, publicKey, consumedAt)` ·
`User.identityKeyEd25519` (nullable column).

**API** — new, versioned, additive:
`POST /api/v3/keys/bundle` (publish) · `GET /api/v3/keys/:userId` (fetch,
consuming one OPK atomically) · `GET /api/v3/keys/:userId/count` (replenishment).
**No existing endpoint changes.** OPK consumption must be a single transaction —
two callers must never receive the same one-time key.

**Client** — `lib/crypto/ratchet.js` (state machine) ·
`lib/crypto/x3dh.js` (session setup) · `lib/crypto/prekeys.js` (generation,
publication, replenishment) · a `sealForRoom`/`openForRoom` branch on
`e2eVersion` · ratchet state in IndexedDB beside the identity.

## 9. Testing strategy

| Layer | What |
|---|---|
| Unit | X3DH agreement, chain derivation, DH ratchet step, skipped-key handling |
| **Vectors** | Differential against a reference implementation's published vectors — the single most important test here |
| Property/fuzz | Random drop/reorder/duplicate/gap sequences; assert the transcript still decrypts or fails closed, never opens wrongly |
| Bounds | Skipped-key cap enforced; memory does not grow without limit |
| Integration | Two clients, real backend: async setup with the recipient offline, OPK exhaustion, concurrent sends both ways |
| Regression | Every existing suite green; v1 and v2 rooms unchanged |
| Benchmark | Per-message seal/open cost vs v2; session setup cost; **measured, not estimated** |
| Security | Old message keys erased after use; a stolen current key does not open earlier messages (that is the whole claim, so it gets a test) |

## 10. What this ADR does not decide

Multi-device sync · hardware-backed custody (no iOS project; Android is a
Capacitor WebView) · group forward secrecy · the MLS question, which should be
revisited on its own terms for groups.

---

**Awaiting approval on two questions:** (1) accept owning a ratchet
implementation, or defer forward secrecy and close Priority 1 at ADR-003?
(2) if accepted, is the additive `e2e_v3` migration shape agreed?
