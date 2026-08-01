# 15 — Priority 1 completion evidence

**Date:** 2026-08-01 · **Scope:** the zero-trust E2EE programme (V2 Priority 1)
· **Purpose:** the formal-review package the roadmap's completion gate (V2 §8)
requires before Priority 1 may be declared complete.

**This document does not declare Priority 1 complete.** It assembles the
evidence and states honestly what passes in-container, what is implemented but
awaiting the owner's review/merge, and what genuinely requires the owner
(hardware, scale, and one ratifiable design decision). Priority 1 closes when
the owner accepts this package — not before.

---

## 1. What was built, phase by phase (all behind flags, none activated)

| Phase | Deliverable | State | PR |
|---|---|---|---|
| 2B | Signing-key publication + executable rollback (publish/withdraw/supersede) | implemented, tested, benched | #39 |
| 3 | X3DH key agreement + prekey infrastructure | implemented, **byte-for-byte vs 004a vectors** | #41 |
| 4 | Double Ratchet | implemented, **byte-for-byte vs the 004b oracle** | #42 |
| 5 | Multi-device safety numbers (recommended construction) | implemented; **safety-number model awaits owner ratification** | #43 |

Every module is PURE and fenced: `signing-not-shipped.test.js` and
`e2e-v3-not-shipped.test.js` fail the build if any app module imports the
foundation or reads the `spotme.e2e3` rollout flag. **Enforcement and e2e_v3
are OFF by default.** Nothing in this programme changes what a user experiences
until the owner activates it.

## 2. Test evidence (reproducible in CI)

```
web       997 assertions, 0 failures   (node --test chain; lint + build clean)
backend   127 tests / 14 suites        (real Postgres; tsc + build clean)
e2e       15 real-browser specs        (Playwright, real backend)
```

Cryptographic conformance — the load-bearing claim — is against INDEPENDENT
oracles, not self-consistency:

- **X3DH** (`test/x3dh.test.js`, 13/13): the four DH, the 128-byte shared
  secret, and the HKDF root reproduce `004a-e2e-v3-vectors.mjs` exactly;
  initiator/responder convergence proven with and without a one-time prekey.
- **Double Ratchet** (`test/ratchet.test.js`, 13/13): Tier 1 reproduces the
  Syndace oracle's `header_hex`/`ratchet_pub`/`ciphertext_hex` for vectors
  01/03/05 byte-for-byte (the committed 004b JSON was re-verified against the
  pinned oracle in-container first); Tier 2 exercises out-of-order, skipped
  keys, duplicate/replay, tamper, room-binding, the DoS bound, serialization,
  forward secrecy and break-in recovery on the shipped seams.
- **Signing-key lifecycle** (`test/signing-keys.e2e-spec.ts`, 11/11 over real
  HTTP+Postgres): publish/supersede/withdraw, single-use OPK consumption under
  a ten-way concurrent race, tombstone semantics.
- **Multi-device** (`test/device-set.test.js`, 10/10): the commitment honesty
  property and version coexistence.

Mutation-checked throughout: e.g. swapping the ratchet's message-step output
order drops Tier 1 conformance 13→10, caught by exactly the byte-for-byte
vectors.

## 3. Benchmark report (V2 §8: environment, median AND tail)

All on `node v22 · Xeon 2.10GHz ×4 · WebCrypto`, shipped seams. Reproduce with
`node test/bench/<name>.bench.mjs`.

| Operation | median | p95 | p99 |
|---|---|---|---|
| X3DH initiator (4 DH + HKDF) | 0.60 ms | 1.00 ms | 1.42 ms |
| X3DH responder | 0.68 ms | 1.09 ms | 1.45 ms |
| Ratchet encrypt (steady state) | 0.29 ms | 0.67 ms | 1.06 ms |
| Ratchet decrypt (in order) | 0.23 ms | 0.47 ms | 0.99 ms |
| Ratchet decrypt (DH step) | 0.91 ms | 1.65 ms | 1.98 ms |
| Ratchet decrypt (50 skipped keys) | 7.08 ms | 11.5 ms | 14.8 ms |
| Signing store cold load | 0.32 ms | 1.10 ms | 10.7 ms |

**Steady-state messaging cost is sub-millisecond.** The one attacker-influenced
path (skipped-key derivation) is linear and bounded at
`MAX_SKIP_PER_CHAIN=1000` — worst case ~140 ms of HKDF, then a hard refusal, so
it is not a remote-DoS surface. Existing IndexedDB/media benchmarks (PR #23
era) are unaffected — v3 changes only the message payload, not storage.

**Not yet measured (needs hardware — owner):** the same operations on a
mid-range phone and on the Android System WebView, and the real IndexedDB read
of the ratchet private key. The numbers above isolate CPU cost; a device adds
storage and (for X3DH) one network round trip.

## 4. Adversarial security review

The dedicated adversarial pass the owner asked for. Threat model: **the server
is the adversary** (ADR-001), plus a network attacker and a device thief. Each
row is the attack, the defence, and where it is proven.

| Attack | Defence | Evidence |
|---|---|---|
| Server substitutes a peer's prekey bundle | SPK signed by the device's signing key (Ed25519 over IK‖SPK); the FETCHER verifies against the peer's PUBLISHED signing key, never the server | `x3dh.test.js` swap/wrong-key tests; server carries `sig` opaquely |
| Server substitutes a signing key silently | replacement exists only as supersession, signed by the OLD key; a different key while one is active is a 409 | `signing-keys.e2e-spec.ts` |
| Server replays / reissues a one-time prekey | atomic single-use consumption in one transaction | ten-way concurrent race, zero collisions |
| Passive read of past traffic after a key compromise | Double Ratchet: a fresh message key per message; forward secrecy | `ratchet.test.js` forward-secrecy vector |
| Continued read after compromise | DH ratchet heals on one healthy round trip (break-in recovery) | `ratchet.test.js` |
| Remote DoS via a forged huge `N` | skipped-key derivation bounded, fails closed with a defined error, never auto-resets | `ratchet.test.js` DoS vector |
| Frame replayed into another room | roomId bound into the AAD; GCM tag fails | `ratchet.test.js` room-binding vector |
| Message tampered in flight | header + version + room authenticated by GCM AAD | `ratchet.test.js` tamper vector |
| Duplicate / replay of a delivered message | message keys deleted on use; replay hits a consumed-key drop | `ratchet.test.js` duplicate vector |
| Device thief extracts the identity/ratchet key | all private keys non-extractable CryptoKeys; no export path (fence proves it) | `signing-not-shipped`, `e2e-v3-not-shipped` §3 |
| Downgrade a v3 room to v1/v2 | local room state authoritative; version in AAD; monotonic `e2eVersion` (004a §8) | design; enforced at activation |
| **A hidden device the user never approved** | the device-set safety number changes when the set changes — visible to every contact (option 3) | `device-set.test.js` honesty property |

**Residual, stated not hidden:** (a) TOFU at first contact — an unverified
first conversation is only as safe as the user checking the safety number;
this is R2 in the P0 audit and is why pinning/verification (A1–A5) ship BEFORE
v3 activates (004a §8a). (b) A peer who genuinely reinstalls is
indistinguishable from an attacker substituting a key — the safety number is
the human check that closes it. (c) The multi-device authenticity of the
device *list* is made visible by option 3 but prevention requires device
approval, which is the Phase 5 follow-up gated on ratification.

## 5. Performance review

- Steady-state send/receive is sub-millisecond CPU; the ratchet adds one HKDF
  and one AES-GCM over e2e_v2's single AES-GCM — negligible.
- Wire overhead is +33 bytes/message steady state, +105 on the first (004a §2a),
  accepted (004c Q2).
- No operation runs on the render path; the safety-number fingerprint (5200
  iterations, ~750 ms) is computed on the verify screen open and cached — a
  rule carried from `safety-number.js` and repeated for `device-set.js`.
- Memory: skipped keys bounded at 2000/session, FIFO-evicted; no unbounded
  structure exists in the crypto path.

## 6. Compatibility matrix

| Surface | Status |
|---|---|
| WebCrypto X25519 (agreement + ratchet DH) | ✅ Chromium/Node; **P-256 fallback path exists** (`negotiateAlgo`) for older WebViews |
| WebCrypto Ed25519 (signing, SPK sig) | ✅ Chromium/Node; recorded per-identity so a device without it uses ECDSA-P-256 |
| HKDF-SHA256, AES-256-GCM | ✅ universal |
| IndexedDB CryptoKey storage (non-extractable) | ✅ Chromium; **Safari round-trip UNPROVEN** — the store's write-then-read-back detects failure and reports `ephemeral` rather than shipping a key that evaporates |
| Real-browser e2e | ✅ Chromium in CI (Playwright) |
| **Firefox / Safari / real Android WebView** | ❌ **not run — owner/hardware matrix** |

## 7. Production-readiness and rollback

- **Every phase is flag-gated and reversible.** e2e_v3: the `spotme.e2e3` flag
  is the rollback (removing v3 *code* strands existing v3 rooms — the flag,
  not code removal, is the supported rollback, 004a §12). Signing publication:
  `SIGNING_PUBLICATION_ENABLED=false`; withdraw is the executable
  post-publication rollback (ADR-008 §12, resolved in #39). Multi-device:
  unactivated pending ratification.
- **Prekey and signing tables are additive** — dropping them breaks only new
  v3/signing sessions, never existing rooms.
- **GitHub CI is the merge authority** (V2 §2); each PR carries its own green
  run, displayed-diff verification, and this evidence.

## 8. Priority 1 checklist — honest status

| Item | Status |
|---|---|
| Compile / lint / unit / integration / no regressions | ✅ 997 web + 127 backend + 15 e2e, all green in CI |
| X3DH (prekeys, bundle publish/fetch, session establishment) | ✅ implemented, vector-validated (#41) |
| Double Ratchet (FS, break-in recovery, skipped keys, replay) | ✅ implemented, oracle-validated (#42) |
| Signed/one-time prekeys, bundle verification | ✅ (#41) |
| Secure signing-key storage + publication + executable rollback | ✅ (#36 merged, #39) |
| Multi-device | 🟡 **safety-number construction awaits owner ratification** (#43); registration/fan-out/UI follow |
| Benchmarks | ✅ in-container (§3); 🟡 hardware numbers pending (owner) |
| Adversarial security review | ✅ §4 (owner sign-off pending) |
| Performance review | ✅ §5 |
| Rollback documented + executable | ✅ §7, ADR-004/006/007/008 |
| Browser compatibility matrix | 🟡 Chromium ✅; Firefox/Safari/WebView pending (owner) |
| Mobile device matrix | ❌ **hardware — owner executes** |
| Load testing | ❌ **infra — owner executes** |
| E2E through real product paths | ✅ scenario 1 in CI; scenarios 2–12 approved, queued |
| Formal review + merge of the phase stack | ❌ **owner reviews #39→#41→#42→#43** |

## 9. What remains before Priority 1 can be declared complete

1. **Owner ratifies the multi-device safety-number construction** (§4 of
   ADR-013 / #43) — the one design decision reserved to the owner.
2. **Owner reviews and merges the phase stack** #39 → #41 → #42 → #43 (V2 §2:
   never merge without review). CI is green on each; this document is the
   review package.
3. **Hardware + scale items the container cannot run:** the mobile device
   matrix, Firefox/Safari/WebView compatibility, and load testing.
4. **Activation, later and separately:** flip `spotme.e2e3` and the signing
   publication flag once the above pass — a deliberate change whose subject is
   the activation, per the fence discipline every phase shipped under.

Until 1–3 are done, Priority 1 is **feature-complete in code and ready for
formal review**, which is the state this package establishes — not closed.
