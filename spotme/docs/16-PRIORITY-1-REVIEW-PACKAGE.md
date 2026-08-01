# 16 — Priority 1 Final Review Package

**Status: IMPLEMENTATION COMPLETE — PENDING OWNER TECHNICAL REVIEW.**
**Repository state: Priority 1 review freeze.** No Priority 2 work, no
activation, only bug fixes found during review. Prepared 2026-08-01 for a
comprehensive owner + external-cryptographer review before Priority 1 is
formally closed.

This document is the single entry point for the review. It describes work that
is **implemented behind flags and not activated** — nothing in this programme
changes what a user experiences until the owner explicitly activates it.

---

## 1. Priority 1 architecture overview

Spot Me's zero-trust E2EE programme, layered from the bottom up:

```
 e2e_v2 (shipped)      X25519 ECDH → HKDF → AES-GCM, one room key per conversation
    │
 A1–A5 (shipped)       trust state machine (Unverified·Pinned·Verified·Changed·Revoked),
    │                  TOFU pinning, QR/safety-number verification, send enforcement (flag OFF)
    │
 A7 signing identity   Ed25519/ECDSA-P256 device signing key; length-prefixed transcripts;
 (#29 merged, #36)      non-extractable storage; publication + rollback lifecycle
    │
 e2e_v3 (this stack, flag OFF)
    ├── X3DH           asynchronous handshake seeding a per-session root
    ├── Double Ratchet forward secrecy + break-in recovery, per-message keys
    └── multi-device   device-set safety numbers (construction pending ratification)
```

**The server is the adversary** (ADR-001). Every design choice below assumes a
malicious or compromised server and asks what it can and cannot do.

## 2. Every PR in execution order

| # | PR | State | What |
|---|---|---|---|
| — | #29 | **merged** `a934e11` | A7 signing foundation + 6 review revisions |
| — | #30 | **merged** `d29c1b6` | A5 device matrix + loadIdentity race fix |
| — | #31 | **merged** `43fce9e` | A5 send enforcement (flag OFF) |
| — | #36 | **merged** `fb02b99` | ADR-008 signing-key storage |
| — | #35/#37 | **merged** | Roadmap V2 controlling + Owner Amendment 1 |
| 1 | **#38** | approved, **held** | Governance Amendment 2 (docs/control only) |
| 2 | **#34** | approved, **held** | Product audit corrections (rebuilt clean: single +358 doc) |
| 3 | **#40** | approved, **held** | Platform ADRs 009–012 (PLANNING ONLY) |
| 4 | **#39** | approved, **held** | Phase 2B — signing-key publication + rollback |
| 5 | **#41** | open (to be split) | Phase 3 — X3DH + prekeys |
| 6 | **#42** | open (**held** until X3DH merged) | Phase 4 — Double Ratchet |
| 7 | **#43** | open (**needs ratification**) | Phase 5 — multi-device safety numbers |
| 8 | **#44** | open | Phase 6 — completion evidence (`15-…`) |

**#38/#34/#40/#39 are owner-approved and ready to merge; they are HELD under the
review freeze, not auto-merged.** Per the owner's split directive, #41 is to be
divided into six smaller PRs; #42 does not proceed until X3DH is reviewed and
merged; #43/#44 are premature and their branches are preserved.

## 3. ADR dependency graph

```
001 e2ee-v19-fix ──► 003 safety-numbers ──► 005 pinning/trust ──► 007 send-enforcement
                                    │                     │
                     006 signing-identity ◄───────────────┘
                          │        │
                          ▼        ▼
              008 signing-key-storage   004 forward-secrecy ──► 004a envelope schema
                    │  (§12 rollback)          │                 004b vectors (Syndace oracle)
                    │  (§BLOCKING safety#)      │                 004c decision · 004d seams
                    ▼                           ▼
              013 multi-device ◄─────────  (X3DH + Double Ratchet)
              (safety-number decision)

Planning-only, no Priority 1 dependency: 009 push · 010 translation · 011 live-voice · 012 adaptive
```

**Load-bearing edges:** 004's forward secrecy depends on 006's signing identity
(SPK signatures) which depends on 008's storage and its §12 rollback (resolved
in #39). 013's multi-device depends on 008 §BLOCKING (the safety-number
decision, unresolved).

## 4. Cryptographic protocol flow

### X3DH (initiator Alice → offline Bob)

```
Alice fetches Bob's bundle {IK_B, SPK_B(+sig), OPK_B?}  ── verify sig(IK_B‖SPK_B) with Bob's signing key
Alice picks ephemeral EK_A
  DH1 = DH(IK_A, SPK_B)      DH2 = DH(EK_A, IK_B)
  DH3 = DH(EK_A, SPK_B)      DH4 = DH(EK_A, OPK_B)   [omitted if no OPK]
  SS  = DH1‖DH2‖DH3‖DH4
  root0 = HKDF(SS, salt=0^32, info="spotme/e2e_v3/root")
Bob reproduces SS from his private halves (DH is symmetric) → same root0
```

### Double Ratchet (per message)

```
DH/root step (on a new peer ratchet key):
  root', chain = HKDF(salt=root, ikm=DH(self, peerRatchetPub), info="spotme/e2e_v3/chain", 64)
Message step (per message in a chain):
  chain', msgKey = HKDF(salt=chain, ikm=0x01, info="spotme/e2e_v3/msg", 64)
Seal: payload = MAGIC‖VER‖HDRLEN‖HEADER‖IV‖AES-GCM(msgKey, plaintext, AAD)
  AAD = "spotme/e2e_v3"‖0x03‖roomId‖HEADER
```

Every derived value above is pinned byte-for-byte by the 004a/004b vectors.

### Signing-key supersession

```
old key signs transcript(domain, [userId, oldPub, newPub, newAlgo])
server verifies against the STORED old key before touching the chain
old row → superseded(+sig+pointer); new row → active
```

## 5. Database schema changes

Three new tables, all additive; **no existing table is modified**:

| Table | Migration | Purpose |
|---|---|---|
| `SigningKey` | `20260801170000_signing_keys` | published signing-key lifecycle (active/superseded/withdrawn tombstones; ≤1 active/user) |
| `SignedPreKey` | `20260801180000_x3dh_prekeys` | X3DH signed prekeys (≤1 active per user+device; `sig` opaque to server) |
| `OneTimePreKey` | `20260801180000_x3dh_prekeys` | X3DH one-time prekeys (deleted atomically on consumption) |

All three are child tables of `User` with `onDelete: Cascade`. CI applies them
via `prisma db push`; migration files are provided for a controlled deploy.

## 6. Migration sequence

Forward: apply `20260801170000_signing_keys` then `20260801180000_x3dh_prekeys`
(order independent — no cross-FK). Both are pure `CREATE TABLE`, no data
backfill, no lock on existing tables. Rollback: `DROP TABLE` in reverse —
breaks only new signing/v3 sessions, never existing v1/v2 rooms (§10).

## 7. Public API changes

New, all under `/api/v2/auth`, all JWT-guarded, all keyed off the principal:

| Route | Method | Purpose |
|---|---|---|
| `/v2/auth/signing-key` | PUT | publish my signing key (idempotent; 409 on silent replace) |
| `/v2/auth/signing-key/supersede` | POST | replace via old-key-signed statement |
| `/v2/auth/signing-key` | DELETE | withdraw (executable rollback) |
| `/v2/auth/signing-key/:userId` | GET | fetch a peer's key + supersession chain |
| `/v2/auth/prekeys` | PUT | publish/refill my device's prekeys |
| `/v2/auth/prekeys/count/:deviceId` | GET | my remaining OPK pool size |
| `/v2/auth/prekeys/bundle/:userId` | GET | fetch a peer bundle (consumes one OPK) |

**No existing route changes.** The message path (`roomId, type, payload, meta,
target, attachId`) is untouched — v3 changes only the opaque `payload` bytes.

## 8. Wire protocol changes

**Only the `payload` field of a v3 message changes** (004a §2). Structure:
`MAGIC(0x53) VER(0x03) HDRLEN(u16) HEADER IV(12) CT‖tag`. HEADER is 73 bytes
steady-state / 145 with X3DH prologue; only those two lengths are legal.
Everything is big-endian, raw keys (never base64/PEM inside the header),
length-checkable before any key material is touched. Overhead: +33 bytes/msg
steady state, +105 first message (accepted, 004c Q2). v1/v2 payloads are
unchanged and a v3 room refuses a v1/v2 frame (downgrade protection, 004a §8).

## 9. Feature flags

| Flag | Default | Gates |
|---|---|---|
| `ENFORCING` (identity-enforcement.js) | **false** | whether an A5 verdict *blocks* (verdict always computed) |
| `SIGNING_PUBLICATION_ENABLED` (signing-key-publication.js) | **false** | client signing-key publication |
| `spotme.e2e3` (localStorage, 004a §12) | **absent** | e2e_v3 session formation |
| multi-device (device-set.js) | **unwired** | pending safety-number ratification |

**All OFF/absent.** The source-level fences (`signing-not-shipped.test.js`,
`e2e-v3-not-shipped.test.js`) fail the build if any app module imports the
gated crypto or reads the flags — so "off" cannot be silently undone.

## 10. Rollback strategy

| Layer | Rollback |
|---|---|
| A5 enforcement | disable the flag (NOT revert — reverting strands a `Changed` peer, ADR-007) |
| Signing publication | `SIGNING_PUBLICATION_ENABLED=false`; post-publication, `DELETE` withdraws (ADR-008 §12, executable) |
| e2e_v3 | the `spotme.e2e3` flag is the rollback; removing v3 *code* strands existing v3 rooms, so flag-off is the supported path (004a §12) |
| Prekey/signing tables | additive; `DROP TABLE` breaks only new sessions |
| Multi-device | unwired; delete `device-set.js` (nothing depends on it) |

## 11. Performance summary

WebCrypto, shipped seams, median / p99 (full tables in `15-…` §3):

| Op | median | p99 |
|---|---|---|
| X3DH initiator | 0.60 ms | 1.42 ms |
| Ratchet encrypt | 0.29 ms | 1.06 ms |
| Ratchet decrypt (in order) | 0.23 ms | 0.99 ms |
| Ratchet DH-step decrypt | 0.91 ms | 1.98 ms |
| 50 skipped keys | 7.1 ms | 14.8 ms |

Steady-state messaging is sub-millisecond CPU. The one attacker-influenced path
(skipped keys) is linear and hard-bounded at 1000. **Hardware/phone numbers are
NOT yet measured** (owner matrix).

## 12. Security assumptions

1. WebCrypto is a correct, side-channel-resistant implementation of X25519,
   Ed25519, HKDF-SHA256 and AES-256-GCM. No primitive is hand-rolled.
2. Non-extractable `CryptoKey` in IndexedDB genuinely prevents export
   (verified on Chromium; **UNPROVEN on Safari** — the store fails closed to
   `ephemeral` if a write does not stick).
3. The signing key's authenticity is established out-of-band (safety numbers);
   the whole downgrade defence rests on it (004a §8).
4. The message key is used exactly once — the precondition that makes the
   ratchet's random-IV AEAD safe.
5. Postgres transactions are atomic (single-use OPK consumption relies on it).

## 13. Threat model

| Adversary | Can | Cannot |
|---|---|---|
| Malicious server | substitute bundles (→ caught by SPK sig + safety numbers), see routing metadata + arrival times, deny service | read plaintext, forge a signature, silently replace a signing key, reissue an OPK, downgrade a v3 room |
| Network attacker | drop/reorder/replay frames | decrypt, tamper undetected (GCM AAD), replay a consumed message |
| Device thief | read what an unlocked device shows | export a private key (non-extractable), decrypt past messages after a wipe |
| Compromised peer key | read messages until one healthy round trip | keep reading after break-in recovery, read pre-compromise messages (forward secrecy) |

Full attack→defence→evidence table: `15-PRIORITY-1-COMPLETION-EVIDENCE.md` §4.

## 14. Remaining known limitations

- **Multi-device safety-number construction is a proposal**, not ratified (§16 / ADR-013).
- **TOFU at first contact** — an unverified first conversation is only as safe
  as the user checking the number (R2, accepted).
- **Reinstall is indistinguishable from an attacker** substituting a key — the
  safety number is the human check.
- **Safari non-extractable-key round-trip unproven**; fails closed if it fails.
- **e2e_v3 is not wired into the send path** — session persistence, the
  prologue-carrying header, attachment per-message keys (004d), and version
  negotiation are the activation PRs, deliberately deferred (§15).
- **Crypto-module audit findings** (independent review): see §21.

## 15. Items intentionally deferred

- e2e_v3 activation wiring (`reach.js`/`socket-transport.js` negotiation,
  IndexedDB session persistence, attachment keys) — a deliberate, separately
  reviewed activation change.
- Multi-device registration endpoints, fan-out session management, device UI —
  held until the safety-number construction is ratified (§BLOCKING).
- E2E scenarios 2–12 + the test seam — approved, queued.
- Hardware device matrix, Firefox/Safari/WebView compatibility, load testing —
  owner/infra executed.
- Scheduled/automated signing-key rotation (explicit-only rotation exists).

## 16. Safety-number decision (BLOCKING — owner)

ADR-013 §1: four candidate constructions; option 3 (a hash commitment to the
active device set) is recommended and implemented behind the flag as
`device-set.js` (`SAFETY_VERSION` 1, coexisting with single-device 0.0) so
there is running, tested code to ratify. **No further multi-device work
proceeds until the owner ratifies a construction.** The proposal is fully
reversible (delete one pure module) and nothing depends on it.

## 17. Exact activation sequence to enable e2e_v3

**Do not run any of this until the owner authorizes activation.** Recorded so
the activation is a single, reviewable change, not a discovery.

1. Confirm A1–A5 identity pinning/verification is live and enforcing as desired
   (v3's downgrade defence rests on it — 004a §8a).
2. Merge the reviewed X3DH split (PRs) and Double Ratchet (#42) onto master.
3. Build the activation PR (separate, its own review): session persistence to
   IndexedDB (`spotme-e2e` considerations, 004a §5c), the prologue-carrying
   header, attachment per-message keys (004d), and version negotiation in
   `reach.js`/`socket-transport.js` with **visible** (never silent) fallback.
4. Add the `e2eVersion` monotonicity guard in `db.upsertConvo` (004a §8, a
   required change before activation).
5. Ship with `spotme.e2e3` **absent**; enable for internal accounts first.
6. Monitor: undecryptable-frame rate, fallback-to-v2 rate, skipped-key bound
   hits — all as counts/timings, never keys or content.
7. Widen the flag by cohort; keep v2 as the permanent negotiated fallback.

## 18. Production rollout checklist

- [ ] Owner + external-cryptographer review of this package complete
- [ ] Safety-number construction ratified
- [ ] X3DH split reviewed + merged; Double Ratchet reviewed + merged
- [ ] Activation PR reviewed (session persistence, negotiation, attachment keys)
- [ ] `e2eVersion` monotonicity guard added
- [ ] Rotated, least-privilege secrets in GitHub Actions / approved store only
- [ ] Hardware device matrix + browser matrix green
- [ ] Load test at target concurrency
- [ ] Observability: undecryptable/fallback/bound-hit metrics wired
- [ ] Rollback rehearsed (flag-off restores v2; withdraw rehearsed)
- [ ] Railway remains blocked until separately authorized

## 19. Backward compatibility matrix

| Existing | With this stack (flags OFF) | On activation |
|---|---|---|
| e2e_v1 rooms | unchanged, readable | unchanged (never upgraded, 004a §5d) |
| e2e_v2 rooms | unchanged, readable | stay v2; new rooms may negotiate v3 |
| A1–A5 trust/enforcement | unchanged (flag OFF) | unchanged; v3 depends on it |
| existing message path | unchanged | only `payload` bytes differ for v3 rooms |
| single-device accounts | unchanged | stay on safety-number v0.0 |

**No existing conversation is migrated or broken.** The upgrade path is a *new*
conversation between two v3-capable peers.

## 20. Browser & 21. Device compatibility matrix

| Surface | Chromium | Firefox | Safari | Android WebView |
|---|---|---|---|---|
| X25519 / Ed25519 (WebCrypto) | ✅ | ❓ untested | ❓ | ❓ (P-256/ECDSA fallback exists) |
| HKDF-SHA256, AES-256-GCM | ✅ | ✅ expected | ✅ expected | ✅ expected |
| Non-extractable CryptoKey round-trip | ✅ | ❓ | ⚠️ historically fails; **fails closed** | ❓ |
| IndexedDB CryptoKey storage | ✅ | ❓ | ❓ | ❓ |
| Real-browser e2e (Playwright) | ✅ CI | ❌ | ❌ | ❌ |

**Device matrix (real hardware) is NOT run — owner-executed.** ❓ = must be
verified on the owner's matrix before activation. The algorithm negotiation
(`negotiateAlgo`/`negotiateSigningAlgo`) records the curve per identity so a
device lacking X25519/Ed25519 uses P-256/ECDSA rather than failing.

---

## 21. Cryptographic module audit — findings

*Independent adversarial review of every crypto module by two reviewers acting
as external cryptographers. **No code has been changed** — this is the
documentation pass; fixes are for the owner-directed cleanup iteration. Findings
ranked; each names file, impact, and reachability.*

> **REVIEW-GATING RESULT: #39 (signing-key publication) is NOT merge-ready as
> is.** Two HIGH findings (H1, H2) are real security/correctness bugs in
> `signing-keys.service.ts`. My earlier "approved-and-ready" on #39's backend is
> retracted pending these fixes. The X3DH/ratchet client crypto and the OPK
> atomicity reviewed clean on the load-bearing properties.

### Pass A — signing lifecycle, publication, device-set, backend

**HIGH**

- **H1 — `signing-keys.service.ts`: the "≤1 active row per user" invariant is
  not concurrency-safe, and `supersede` reads the active row OUTSIDE its
  transaction (TOCTOU).** Under Postgres READ COMMITTED (no isolation level
  set), two concurrent `PUT`s of different keys both read "no active" and both
  `create` → **two active rows**; a `withdraw` committing between supersede's
  out-of-transaction read and its in-transaction update is **silently clobbered**
  back to active — and withdrawal is the incident-response rollback (ADR-008
  §12). Also: concurrent same-key first publish hits `@@unique` (P2002)
  uncaught → 500 instead of an idempotent 200. **Fix:** read the active row
  inside the transaction with a row lock (`SELECT … FOR UPDATE` / advisory
  lock), add a Postgres **partial unique index `(userId) WHERE
  status='active'`**, and catch P2002 as idempotent. Reachability: needs the
  authenticated principal; harm is identity-splitting + rollback-clobber, not
  remote forgery.
- **H2 — `signing-keys.service.ts`: retirement/idempotency/uniqueness are keyed
  on the base64 STRING, not the decoded bytes, so base64 malleability lets a
  withdrawn/superseded key return.** `Buffer.from(b64,'base64')` is lenient (the
  final quantum's unused bits are ignored), so ~4 strings decode to the same
  key; re-encoding a retired key's bytes as a different string defeats the
  "retired key never returns" guard (ADR-008's load-bearing guarantee).
  Compounding: `device-set.js` commits over decoded **bytes** while the server
  keys identity on **strings** — an undocumented, inconsistent identity model
  across modules. **Fix:** canonicalize (`Buffer.from(b64,'base64')
  .toString('base64')`) before store/compare, or constrain on raw bytes.

**MEDIUM**

- **M1 — server-side ECDSA-P-256 supersession verification is untested.** The
  e2e spec uses only Ed25519; the live P-256 verify branch in
  `signing-transcript.ts` has zero coverage. A regression fails closed but
  silently blocks legitimate P-256 users. **Fix:** add a P-256 supersession test.
- **M2 — OPK depletion has no throttle** (`prekeys.service.ts`): any
  authenticated user can drain any peer's one-time-prekey pool, forcing the
  weaker no-OPK fallback. By-design fallback is visible/functional, but there is
  no per-requester cap. **Recommend** a rate limit (hardening, not a merge
  blocker).

**LOW** (fix opportunistically in the cleanup iteration)

- **L1** — TS `transcript()` omits the normative `MAX_TRANSCRIPT_BYTES` (256 KiB,
  ADR-006 §3a) that the JS version enforces, and accepts only strings; for real
  4-string supersession inputs the bytes are identical (pinned vector verified),
  so no reachable divergence today — latent drift.
- **L2** — prekey `keyId` has no upper bound and does not exclude the wire
  sentinel `0xFFFFFFFF`; a self-published OPK with that id would be read as "no
  OPK" by the recipient → session mismatch. Self-inflicted; validate it.
- **L3** — OPK consumption is single-use-correct but losers `return null`
  instead of trying the next row, wasting the pool under contention (liveness,
  not security).
- **L4** — `device-set.js` commits over a multiset (no dedup by `deviceId`) and
  uses `String()` coercion; callers must pass a deduplicated string-keyed set
  (undocumented precondition; fail-safe — spurious re-verify, never a false
  match).
- **L5** — `signing-key-store.js` `load`'s write-proof (`readable(readBack)`) is
  weaker than `rotate`'s (also checks the key matches); justified for a
  first-write but the asymmetry is undocumented.
- **L6** — the sign-before-rotate ordering in `signing-key-publication.js` is
  enforced only by a comment (owned by the activation PR; flag for it).

**Clean (verified):** constant-time — no non-constant-time comparison of secret
material anywhere (all equalities are on public keys / public base64, sorts over
public keys, or WebCrypto `verify`); cross-implementation transcript
serialization (the pinned vector parsed byte-by-byte, identical in JS and TS for
all real inputs); **OPK single-use atomicity** (SELECT-then-DELETE-by-PK with a
count guard, confirmed under the ten-way concurrency test); ephemeral/unreadable
publication correctly fails closed.

**Coverage gaps to close:** base64-malleability test (H2), signing-key
publish/supersede concurrency test (H1), server P-256 verify (M1),
`rotateSigningIdentity` EPHEMERAL-refusal branch, `publishSigningIdentity`
UNREADABLE-refusal branch, device-set duplicate-deviceId, OPK sentinel keyId.

### Pass B — X3DH + Double Ratchet

**Overall: the crypto core is correct and conformant — no confidentiality or
forward-secrecy break.** The four X3DH DH are exactly Signal order and reproduce
the 004a hex; the ratchet KDF ladder reproduces the oracle's positive vectors
(01/03/05) byte-for-byte; timing is clean (constant-time `eq`, all comparisons
on public values); serialization offsets are correct. The findings are
robustness/error-contract and one vector-package defect.

**HIGH (assurance, not a code flaw)**

- **B1 — conformance vector 13 (the off-by-one guard) is inconsistent with the
  shipped KDF and is never asserted by any test. ROOT-CAUSED and confirmed.**
  The generator (`004b-…ratchet-vectors.py:361-363`) derives vector 13's
  `correct_message_key` as `HMAC(ck, "spotme/e2e_v3/msg/0")` — the *illustrative*
  form from the old `004a` sketch — NOT the authoritative ratchet step
  `HKDF(salt=ck, ikm=0x01, info="spotme/e2e_v3/msg", 64)` that the real vectors
  01/03/05 use (and that `ratchet.js` reproduces byte-for-byte). So the
  "must_hold" negative vector cannot be reproduced by the correct
  implementation, provides ZERO assurance, and is a live trap: a future engineer
  who "wires up vector 13", finds it failing, and "fixes" the KDF to match would
  BREAK real conformance. **`ratchet.js` itself is correct** — 01/03/05 are
  byte-exact and do catch an off-by-one. **Fix (cleanup iteration):** regenerate
  vector 13 from the real construction (`correct = messageStep(ck).messageKey`;
  `off_by_one = messageStep(messageStep(ck).chainKey).messageKey`) and add an
  explicit test asserting it.

**MEDIUM (robustness / error contract)**

- **B2 — `ratchet.decrypt()` is not total: two injected-frame paths throw raw
  non-`RatchetError` exceptions**, violating the module's own contract (all
  failures should be *defined* so a caller can't swallow one into "accepted").
  (a) `messageStep(null)` → `TypeError` in the initiator's pre-first-receive
  window when a forged frame carries the peer's known initial ratchet pub with
  `n=0`; (b) a low-order `ratchetPub` → WebCrypto `OperationError` in `dhRatchet`
  BEFORE `open()`. Both fail closed (no plaintext; state is on the discarded
  session copy), but a receive loop switching on `RatchetError.code` mishandles
  them and an unhandled rejection could take down the receive path. **Fix:** wrap
  `dhRatchet`'s DH and the step-3 `messageStep` to raise `RatchetError`.
- **B3 — non-string plaintext is silently encrypted as empty** (`encrypt`,
  ratchet.js:242: `typeof plaintext === 'string' ? plaintext : ''`), and
  `open()` decodes non-fatally (U+FFFD on non-UTF-8). Fail-silent data loss.
  **Fix:** throw on non-string input; the ratchet is UTF-8-only and should say
  so.

**LOW**

- **B4** — skipped-key derivation runs on unauthenticated input and is 2×
  amplified (both `pn` at step 1 and `n` at step 3 derive before `open()`);
  bounded by MAX_SKIP so CPU-burn only, but only the `n`-path bound is tested.
- **B5** — `parsePayload` accepts `FLAGS` bit0=1 with a 73-byte header (ignores
  the prologue flag); mitigated because FLAGS is in the AAD, but this module
  can never carry a prologue so bit0 should be required 0.
- **B6** — no boundary validation on `sdev`/`rdev` (16 B) or `ratchetPub`/`pub`
  (32 B) at init/encode; `deserializeSession` doesn't verify `selfKeyPair.pub ===
  plain.selfPub` or the `v:1` tag → a wrong restored keypair yields silently
  undecryptable output.
- **B7 (x3dh)** — verify-then-establish is opt-in: nothing binds the bytes
  `verifyBundleSpk` checked to the CryptoKeys passed to `x3dhInitiator`; a caller
  who skips verification or mixes bundles establishes over a substituted bundle
  (the §8(4) attack). Delegated to the future session layer by design — flag it
  as convention-not-enforced and give the session layer a single safe entry
  point.
- **B8** — `MAX_SKIPPED_STORED` FIFO eviction is untested (the one spot 004a
  calls out as Spot Me's own decision where LRU would diverge while looking
  correct); serialization *does* preserve insertion order (verified).

**NITS:** counter wrap at 2³² (unreachable, unguarded — Signal has the same);
`buildAad` roomId has no length prefix (safe only because the header is a
fixed-width suffix); `defaultAead.makeIv` ignores its `messageKey` arg;
`dh()`/`toB64`/`fromB64` duplicated across three modules (deliberate purity).

**Clean (verified by executing the shipped code):** KDF/DH/label/ordering
(byte-for-byte on 01/03/05), honest-party convergence, timing/constant-time,
serialization round-trip, session immutability (copy-and-discard is load-bearing
and holds — it contains B2/B4 safely).

**Per-file verdict:** `x3dh.js` — correct, constant-time-safe, conformant; only
note is verify-is-convention (B7). `ratchet.js` — cryptographically correct and
conformant; exposure is robustness/contract (B2/B3) + the broken vector 13 (B1);
no confidentiality or forward-secrecy break.

### Consolidated disposition

| Finding | Severity | Belongs to | Merge-blocking? |
|---|---|---|---|
| H1 concurrency / withdrawal-clobber | HIGH | #39 backend | **YES — fix before #39 merges** |
| H2 base64 malleability (retired key returns) | HIGH | #39 backend | **YES** |
| B1 vector 13 inconsistent + untested | HIGH (assurance) | 004b vectors | fix in cleanup; not a code flaw |
| B2 decrypt error-contract (raw throws) | MEDIUM | #42 ratchet | recommend before activation |
| B3 non-string plaintext silent-empty | MEDIUM | #42 ratchet | recommend before activation |
| M1 P-256 supersession verify untested | MEDIUM | #39 tests | recommend before merge |
| M2 OPK depletion no throttle | MEDIUM | #41 backend | hardening, not blocking |
| L1–L6, B4–B8, nits | LOW/NIT | various | cleanup iteration |

**Nothing found is a confidentiality or forward-secrecy break.** The two HIGH
code findings (H1, H2) are in the signing-key *backend lifecycle*, are reachable
only by an authenticated principal, and are fixable with a partial unique index
+ in-transaction row lock + base64 canonicalization. The X3DH/ratchet *client*
crypto is correct; its findings are robustness and one mis-generated negative
vector.
