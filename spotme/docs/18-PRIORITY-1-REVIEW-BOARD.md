# 18 — Priority 1 Final Engineering Review Board

**Status: REVIEW COMPLETE — VERDICT: APPROVED WITH FIXES.** Review-only exercise;
no code modified, nothing merged. Convened 2026-08-01 to determine whether
Priority 1 is genuinely production-ready, assuming an external cryptography audit
will follow. All five specialist reviews and the coordinator have reported; the
consolidated Final Review Board Report and the single evidence-based verdict are
at the end of this document.

**Owner directive (2026-08-01, incorporated):** every HIGH finding carries a full
twelve-axis engineering analysis (below); findings are cross-verified, de-duped,
and merged into one consolidated risk register and one dependency-ordered cleanup
plan. **Revised merge plan:** the crypto stack does *not* merge as-is — one
focused cleanup iteration (HIGH-only first: H1, H2, NEW-4, B1) lands and is
re-verified by the board *before* merge, after which the verdict is expected to
flip to APPROVED. The board remains in review-freeze — no code modified, nothing
merged, Priority 2 not begun — until the owner authorizes the cleanup iteration.

**Method (owner-mandated):** independent, evidence-based specialist reviews
grounded in the repository, ADRs, tests, vectors, and review documents (`15`,
`16`, `17`). No fabricated consensus — disagreements are recorded and the
stronger position is recommended with evidence. Every finding is classified and
carries evidence, root cause, security + operational impact, reproduction, a
recommended fix, and whether it blocks Priority 1.

**Reviewers (all real code-grounded passes, not personas):**
1. Cryptography (X3DH + Double Ratchet) — **complete** (findings in `16` §21 Pass B)
2. Applied Cryptography / signing lifecycle / device-set / backend crypto — **complete** (`16` §21 Pass A)
3. Backend / Database / Reliability — **complete** (report folded in below)
4. Frontend / Storage / Networking — **complete** (report folded in below)
5. Testing / Security synthesis — **complete** (report folded in below)
6. Coordinator (Executive, Performance, Documentation, Operations) — below

**All reviews reported. Verdict issued: APPROVED WITH FIXES** (Final Review Board
Report, §10).

---

## Coordinator sections

### Executive Technical Review

**Architecture — strong.** Cleanly layered (e2e_v2 → A1–A5 trust → A7 signing
identity → e2e_v3 X3DH+ratchet → multi-device), every layer's dependency
explicit, "server is the adversary" applied consistently. Delivered as a small
stacked set of PRs (#39→#41→#42→#43) plus docs, each independently reviewable.
No feature was rewritten; no existing behavior changes with flags off.

**Migration strategy — clean.** Three new tables (`SigningKey`, `SignedPreKey`,
`OneTimePreKey`), all additive, no existing table touched, no data backfill,
FK-cascade to `User`. Order-independent.

**Rollback — real, layered.** Flag-off per layer; the post-publication case has
an *executable* rollback (withdraw), which was the ADR-008 §12 precondition and
is the reason Phase 2B shipped as it did.

**Maintainability — good, with debts.** Heavy inline "why" comments, a complete
ADR trail (13 ADRs), reproducible test vectors, and build-enforced fences make
this unusually legible for a crypto layer. Debts: `dh()`/`toB64`/`fromB64`
duplicated across three modules (deliberate purity, but three copies to keep in
sync); a duplicated IndexedDB fake across two suites; `chat.js` at ~4600 lines
(pre-existing, not this stack).

**Long-term evolution — well-positioned.** SDEV/RDEV pre-wired in the v3 header
for multi-device; `SAFETY_VERSION` versioned and coexisting; AEAD/keygen are
injected seams; the supersession chain is the hook for a future revocation
ledger.

**Executive score: 8.5/10** — architecture and reversibility are the strengths;
the two HIGH backend findings (H1/H2) and the vector-13 defect (B1) are the
reasons it is not a 10 before fixes.

### Performance Review

Measured on WebCrypto, shipped seams (median / p99): X3DH initiator 0.60 / 1.42
ms; ratchet encrypt 0.29 / 1.06 ms; decrypt in-order 0.23 / 0.99 ms; DH-step
0.91 / 1.98 ms; 50 skipped keys 7.08 / 14.8 ms; signing store cold 0.32 ms.
**Steady-state messaging is sub-millisecond CPU.** The one attacker-influenced
path (skipped-key derivation) is linear and hard-bounded at 1000 (~140 ms worst
case, then a refusal) — not a remote-DoS surface (the testing reviewer is
checking the 2× pn+n amplification noted in `16` §21 B4). Bundle retrieval is
one round trip + one atomic delete. **Not measured (owner hardware):** phone /
WebView CPU, IndexedDB latency, memory under 2000 skipped keys, battery.
**Performance score: 8/10** (in-container strong; hardware numbers outstanding).

### Documentation Review

**Consistency — high.** ADRs 001–013 form a coherent trail; the "Implementation
status" addenda bridge as-designed vs as-implemented. `16` (review package),
`17` (crypto implementation guide, for a future engineer), and `15` (completion
evidence) are new and cross-referenced. Activation is documented end-to-end
(`16` §17, `17` §10) and is deliberately a separate future PR.
**Gaps:** (a) the 004b vector-13 inconsistency is a documentation/vector defect
(B1) — the guide's §12 vector-generation process is correct but the committed
vector is not; (b) ADR-013's multi-device device-registration/fan-out is design
only (expected — gated on ratification); (c) no runbook yet for the observability
metrics an activated rollout needs. **Documentation score: 8.5/10.**

### Production Operations Review

**Deployment/flags — safe posture.** All flags OFF/absent (`ENFORCING=false`,
`SIGNING_PUBLICATION_ENABLED=false`, `spotme.e2e3` absent), fence-enforced.
Activation sequence + rollout checklist exist (`16` §17–18).
**Observability — a real gap.** No `/metrics` or `/health` wiring and no
metrics emission in `backend/src` (prom-client is a dead dependency); the
activation checklist calls for undecryptable/fallback/bound-hit counters that do
not yet exist. This does not block the *frozen* state but **must exist before
e2e_v3 is activated**.
**Disaster recovery — by-design constraint.** No key backup/recovery (ADR-008
§6, stated cost); storage loss is identity loss. Railway remains blocked.
**Operations score: 7.5/10** — safe to hold; observability is the pre-activation
gap.

---

## Specialist review 3 — Backend / Database / Reliability (complete)

Independent pass over source, schema, migrations, tests, ADR-008, and `16`
§5/6/7/21. Verified isolation/locking/index reality against the code and
**empirically reproduced** the base64 malleability and the CI schema path. No
code modified.

**Confirms both HIGH findings and adds one HIGH process finding (NEW-1).**

- **H1 — CONFIRMED, extended.** `publish()` is a read-modify-write *inside* a
  txn with no row lock (`signing-keys.service.ts:77→94`); `supersede()` reads
  the active row *outside* its write txn (`:108-110` vs `:137-156`);
  `prisma.service.ts` sets no `isolationLevel` (Postgres default READ
  COMMITTED); there is **no** partial unique index on `(userId) WHERE
  status='active'` in schema or migration; P2002 is **not** caught in
  `publish` (though `groups.service.ts:217,563` proves the team knows the
  pattern). Three reachable failure modes: split-brain (two active rows),
  **withdraw-clobber** (a committed withdrawal silently reverted by a racing
  supersede — the dangerous one, it races away the ADR-008 §12 incident
  rollback), and an uncaught-P2002 → HTTP 500 on a concurrent same-key
  publish.
- **H2 — CONFIRMED empirically.** For a random 32-byte key, **four distinct
  base64 strings** (`…IZcNs/t/u/v=`) all pass the regex + 32-byte length check
  and decode byte-identical; identity is compared on the *string*
  (`:79,86-88,114,138-139` + `@@unique([userId,publicKeyB64])`), so a retired
  key re-encoded as a sibling string re-activates. Also breaks PUT idempotency
  the other way (409 on a non-canonical re-publish of one's own active key).
- **M1 — CONFIRMED.** Server P-256 supersession-verify branch
  (`signing-transcript.ts:62-65,90-102`) has zero e2e coverage (suite is
  Ed25519-only). Fails closed but silently.
- **M2 — CONFIRMED.** `fetchBundle` has no per-requester cap
  (`prekeys.service.ts:140-183`) — any authed user can drain a peer's OPK pool.
- **L2 — CONFIRMED.** OPK `keyId` bounded below but not above
  (`prekeys.service.ts:74-84`) — a self-published `0xFFFFFFFF` reads as the
  wire "no OPK" sentinel.

New findings from this pass:

- **NEW-1 (HIGH, process/infra) — the prescribed H1 DB backstop is not
  applicable under this repo's CI.** CI provisions the DB with `npx prisma db
  push --skip-generate` (`ci.yml:117` and `:207`), **not** `migrate deploy`
  — *independently verified in this board*. Prisma `^5.22.0` (`package.json`)
  cannot express a partial/filtered unique index, so the `(userId) WHERE
  status='active'` backstop can only live as raw SQL in a migration — which
  `db push` never applies. Consequence: a migration-only index is silently
  absent in CI and any `db push`-provisioned env, and a concurrency test would
  run against a schema *without* the index (false green). **Board assessment
  (recorded disagreement):** the DB reviewer rates this as blocking because it
  makes the *index* fix un-verifiable. The coordinator + applied-crypto
  position is that the **advisory lock is the primary fix, is application-level
  (`$executeRaw pg_advisory_xact_lock`), and IS CI-verifiable today** — it is
  behavioral, independent of how the schema was provisioned — so H1 *can* be
  closed under current CI with lock + P2002-catch + a concurrency regression
  test. The partial index is recommended **defense-in-depth** that additionally
  requires moving CI to `migrate deploy` + a schema/migration parity guard.
  Net: NEW-1 does **not** independently block P1 *if* the advisory lock is the
  accepted primary fix; the CI-to-migrations change is a strong MEDIUM
  follow-up, not a P1 gate. (Facts are undisputed and verified; only the
  blocking classification differs, and the stronger evidence-backed position
  is recorded here.)
- **NEW-2 (LOW).** SignedPreKey "exactly one active per device" has the same
  H1-class race (`prekeys.service.ts:90-98`, no partial unique index on
  `(userId,deviceId) WHERE retiredAt IS NULL`). Self-inflicted (a device racing
  itself), tolerated by `fetchBundle` picking newest. Same root cause as H1 —
  fix together.
- **NEW-3 (INFORMATIONAL).** `opksStored` is counted *after* the write txn
  commits (`prekeys.service.ts:108`) — an approximate refill hint, not a
  guarantee. Acceptable; worth a comment.
- **L3 (LOW).** OPK fetch contention wastes the pool
  (`prekeys.service.ts:165-173`): on a delete race the loser returns null
  instead of retrying the next candidate, so under N simultaneous fetchers
  N-1 get no OPK though N-1 remain. Liveness only — single-use still holds.

**Genuinely CLEAN (with evidence):** OPK single-use atomicity
(`findFirst→deleteMany→serve iff count===1` in one txn — the second deleter
matches 0 rows, so no double-issue; matches the passing 10-way test);
in-transaction crash atomicity (every multi-write path wrapped in `$transaction`
— a mid-txn crash rolls the whole unit back); indexes match hot queries;
migrations purely additive (leaf tables, FK-to-`User` only, order-independent
reverse-drop); schema↔migration parity has no drift *today* (which is exactly
what makes NEW-1 latent — the first raw-SQL-only constraint introduces silent
drift nothing checks). **Reversibility caveat (LOW):** no down-migrations;
rollback is prose ("DROP TABLE"), a manual runbook step, never scripted/tested.

**Scores — Backend 6/10, Database 5/10, Reliability 6/10.** Clean structure,
strict principal-keying, correct transaction *usage* for writes, excellent
crypto-boundary discipline (server verifies only as a coherence check); dragged
down by two real correctness bugs in the trust-anchor path, an invariant with no
DB enforcement that CI can't even apply (NEW-1), permissive READ COMMITTED with
no locking, and unscripted rollback. **Disposition: the backend blocks Priority
1** — H1 + H2 must be fixed (lock + canonicalization + concurrency test) before
`SIGNING_PUBLICATION_ENABLED` is turned on, and Priority-1 completion *is*
turning it on. Nothing is exploitable in production today only because the whole
path is flag-gated off.

---

## Specialist review 5 — Testing / Security synthesis (complete)

Static review **plus read-only execution** of the shipped modules and all 10
client crypto suites (backend e2e read statically — needs live Postgres). No
code/git/config modified. **Corroborates §21 and reviewer 3, and adds executed
evidence.**

**Confirmed by execution (the strongest evidence class in this board):**

- **B1 — CONFIRMED BY EXECUTION.** Fed vector 13's `chain_key` through the
  *shipped* `messageStep` (via an injected capturing `aead` seam): the shipped
  message key is `3850d161…52481`, matching **neither** the vector's
  `correct_message_key` (`77ab6651…` = `HMAC(ck,"…/msg/0")`) **nor** its
  `off_by_one` (`HMAC(ck,"…/msg/1")`). Grep: **no test references** vector 13's
  fields. Worse, the superseded 004a `.mjs` sketch carries a **third** divergent
  formula (`HKDF(ck, info="msg/0")`), imported by no test, only cited in a
  comment. The real off-by-one *is* caught byte-for-byte by tested vector 03
  (ran green) — so shipped code is fine — but the flagship negative vector gives
  **zero** assurance and is a live trap (an engineer who "fixes" `messageStep`
  to match vector 13 would *break* real conformance). Repro:
  `scratchpad/verify_b1.mjs`.
- **H2 — CONFIRMED BY EXECUTION.** Two distinct base64 strings decoding to
  identical bytes both pass the server regex — the retired-key-returns bypass is
  real, not theoretical.
- **B2 — CONFIRMED BY EXECUTION (elevated from hypothesis).** A forged frame
  with an all-zero/low-order `ratchetPub` throws a **`DOMException`**
  (`instanceof RatchetError === false`) from `dhRatchet`'s DH *before* `open()`;
  a second path, `messageStep(null)` in the initiator's pre-first-receive
  window, throws `TypeError`. Fails closed (no plaintext leak) but breaks the
  module's error contract — a receive loop switching on `RatchetError.code`
  mishandles it, and an unhandled rejection can DoS the receive path on
  attacker-supplied bytes.
- **B3 — CONFIRMED BY EXECUTION.** `encrypt(session, {secret:'…'})` → peer
  decrypts `""` (`ratchet.js:242` coerces non-string to `''`). Fail-silent data
  loss.

**Concurred statically:** H1 (no `FOR UPDATE`/`Serializable`/`isolationLevel`/
advisory lock anywhere in `backend/src/auth`; supersede reads active via
`this.prisma` not `tx`), M1, M2, L2, and B4–B8 + L1–L6. **Elevated as most
security-relevant:** **B7** (verify-then-establish is convention-only — nothing
binds `verifyBundleSpk`'s checked bytes to the CryptoKeys passed to
`x3dhInitiator`; the session layer must enforce a single safe entry point) and
**B6** (`deserializeSession` trusts a supplied `selfKeyPair` without checking
`pub === plain.selfPub` or the `v:1` tag → a silently-undecryptable session).

**Side-channel / timing — CLEAN (with evidence).** No non-constant-time
comparison of *secret* material anywhere: `ratchet.eq()` is XOR-accumulate over
**public** ratchet pubkeys; skipped-key `Map` lookups key on **public**
`(ratchetPub:n)`; AEAD tag/signature checks are inside WebCrypto; message/chain/
root keys are **never compared**, only used as KDF/AEAD inputs.

**Memory lifecycle — INFORMATIONAL.** No zeroization of secret `Uint8Array`s
(replaced-not-wiped, GC-lingering); buffered *skipped* message keys persist to
IndexedDB as plaintext until consumed/evicted. Standard for Signal-style
persisted ratchets; weakens FS against a memory-scraping / disk-access
adversary. Largely untestable in JS.

**Systematic testing gaps (28 itemized).** Highlights: no concurrency test for
the signing-key lifecycle (while OPK single-use *got* a 10-way race test — a
glaring asymmetry); the negative vector 13 assertion is absent; `decrypt`
totality (B2), non-string reject (B3), `parsePayload` FLAGS bit (B5),
`deserializeSession` mismatch (B6), server P-256 verify (M1), rotate-EPHEMERAL /
publish-UNREADABLE refusal branches, `MAX_SKIPPED_STORED` FIFO eviction, the
`pn`-path skip bound (B4), OPK sentinel/upper-bound (L2). **No property/fuzz
tests exist** (all example-based), and **mutation-testing claims in comments are
not reproducible** (no mutation config in `package.json`) — a documentation
overreach to correct. Reviewer 5 also proposes concrete property/differential
tests (e.g. a differential KDF check against an independent HKDF impl "would
have caught vector 13's inconsistency at authoring time").

**Scores — Test-coverage 6/10, Security 7/10.** Excellent independent-oracle
positive conformance (byte-exact 01/03/05), real-concurrency OPK atomicity, full
lifecycle e2e, correct/constant-time/non-extractable shipped core, genuinely
fenced risk surface; held down by the broken+untested flagship negative vector,
the missing signing-key concurrency test, two confirmed-real error-contract bugs
(B2/B3), several uncovered refusal branches, and no property/fuzz/mutation
testing. **Disposition:** ship the current fenced build; regenerate + test vector
13 before signing off the 004b package; **#39 is NOT merge-ready until H1 and H2
are fixed** — Priority 1 crypto cannot be declared complete until the
concurrency, negative, and base64-canonicalization tests exist.

---

## Specialist review 4 — Frontend / Storage / Networking (complete)

Independently re-derived every wire offset and traced the wipe/IndexedDB
lifecycle end-to-end across `ratchet.js`, `x3dh.js`, `signing-key-store.js`,
`signing-key-publication.js`, `db.js`, `identity-pin-store.js`, `reach.js`,
`socket-transport.js`. No code modified. **Found one HIGH and one MEDIUM the
crypto-focused §21 passes did not cover** — both in the storage/lifecycle
dimension — and confirmed the networking findings against the actual bytes.

- **NEW-4 (HIGH) — `wipeDevice` self-blocks its own IndexedDB deletes; the
  honest-failure contract is defeated, invisibly to tests.** *Independently
  verified in this board:* `identity-pin-store.js:33,41-45,74` caches the
  `spotme-identity-pins` connection at module level (`dbPromise`) and never
  closes it; **no `onversionchange` handler and no `.close()` for any IndexedDB
  connection exists anywhere in `src/`** (grep returns only AudioContext /
  Notification); `db.js:193` `req.onblocked = () => done(name)` and `done(name)`
  resolves to the DB *name* = failure (`onsuccess` resolves `null`). Per the
  IndexedDB spec, `deleteDatabase` fires `versionchange` at every open
  connection and **blocks until they close**; a connection with no handler never
  closes, so the app blocks its own delete. `rooms.js:43` opens the pin
  connection on room join, so in any real session `wipeDevice()` returns
  `{ok:false, failures:['spotme-identity-pins', …]}` on a real browser, and if
  the wipe UX does not force a reload the pin store ("who this device talked to
  and when") **survives on disk**. This directly undercuts ADR-008 §5
  ("`wipeDevice` must delete `spotme-signing`") and the §13 device-thief claim,
  strictly enforced on Safari/WebView — the exact unverified platform. The
  `wipe-device.test.js:127-231` mock fires `onsuccess`/`onblocked` on command
  and never models a still-open handle, so CI is green over a real bug.
  **Reviewer's fix:** set `db.onversionchange = () => db.close()` in each
  store's `openDb()`, and/or sequence explicit `close()` of every store
  *before* `dropDatabase` (not concurrently); add a connection-blocking mock.
  **Blocks P1: recommend YES** (storage claim — fix before P1 is declared
  complete and before #39 activates on Safari/WebView). *This is shipped app
  code, not fenced* — it affects the existing device-wipe feature today.
- **NEW-5 (MEDIUM) — signing-key in-session read-back ≠ cross-launch
  persistence; the publication gate can fail OPEN on Safari/WebView.**
  `signing-key-store.js:170-185` writes the key then reads it back on the *same*
  connection, sets `persisted=true`, and `signingKeyStatus()` returns `'ok'`;
  `publishSigningIdentity` gates solely on `status==='ok'`. A same-session
  read-back proves the write *committed*, not that it *survives a restart* —
  Safari ITP / 7-day IndexedDB eviction / private-mode memory backing can accept
  and read back a CryptoKey in-session yet drop it before next launch. Then
  `loadOnce` sees an empty store, regenerates a **different** key, and (if
  read-back succeeds) could publish it — peers pinned key A now see key B, the
  exact ADR-008 §4 identity-change catastrophe. This is fail-**open**, contradicting
  the review package's "fails closed to ephemeral" claim (§2, §12.2) — **a
  documentation correction**, not just a bug. **Fix:** boot-time re-verification
  on the launch *after* publication (confirm the stored key still matches the
  published `publicKeyB64`; if absent, surface identity-loss, do **not** silently
  regenerate-and-republish). **Blocks P1: not while publication is OFF; must be
  resolved before #39 is activated on Safari/WebView.**
- **NEW-6 (LOW) — a message lost to `MAX_SKIPPED_STORED` eviction is
  misclassified as `DUPLICATE` (silent).** `ratchet.js:333-338` evicts the
  oldest skipped key FIFO; if it later arrives, `decrypt` throws
  `RatchetError('DUPLICATE')` — indistinguishable from a consumed-replay, so a
  genuine loss is hidden where 004a §5 requires loss to be surfaced. An attacker
  forcing eviction (heavy reorder) can silently disappear a real message.
  Belongs to #42 / activation. **Blocks P1: no.**

**Confirmed §21 items against the bytes:** **B2** (traced both non-total paths —
`messageStep(null)` in the pre-first-receive window throws `TypeError`;
`dhRatchet` raises `OperationError` on a low-order `ratchetPub` before `open()`);
**B4** (2× unauthenticated skip amplification, bounded ≤2000 KDFs/frame — CPU
only; only the n-path bound is tested); **B5** (`parsePayload` masks FLAGS `&
0xfe`, accepting the prologue bit — not exploitable, FLAGS is in the AAD, but
deviates from 004a §7); **B6** (`deserializeSession` binds nothing — no
`selfKeyPair.pub === plain.selfPub` or `v:1` check); **L6** (sign-before-rotate
is comment-only ordering).

**Affirmatively clean (re-derived):** wire framing offsets byte-correct
(FLAGS@0, SDEV@1, RDEV@17, DH@33, PN@65, N@69 = 73 bytes; frame
MAGIC/VER/HDRLEN/HEADER/IV/CT; min length `4+73+12+16=105`, no off-by-one, no OOB
read at the minimum); **rejection happens before any key material** (length →
magic → version → hdrlen → reserved-FLAGS all run before the first
`messageStep`/`dh`); only a 73-byte header is accepted (145/other rejected as
`MALFORMED`); `DataView(payload.buffer, payload.byteOffset, …)` is subarray-safe;
AAD binds version+room+full header; replay/duplicate/state-copy semantics sound
(decrypt-once-then-delete only on successful `open`; forged frame cannot corrupt
live state).

**Activation-layer requirements flagged (e2e_v3 not yet wired into
`reach.js`/`socket-transport.js`):** `e2eVersion` monotonicity is specified but
**unimplemented** — `db.upsertConvo` (`db.js:280-288`) merges with no guard, so a
lower `e2eVersion` silently overwrites (004a §8(2) requires a monotonic guard
before activation); version-mismatch→cursor mapping, the 145-byte X3DH prologue
parser, base64-text wire encoding, and extending `wipeDevice` to the future v3
session store are all hard activation gates. Live v1/v2 is currently protected
by the duplicate check + no-password provider; a malicious server can cause
undecryptable messages but **not** a silent plaintext downgrade today.

**Scores — Frontend/Storage 7/10, Networking 8/10.** Rigorous storage design
(promise-cached load, aborted-read-≠-empty, write-then-read-back,
unreadable-≠-absent, cache-clear on wipe) and byte-correct wire framing that
rejects hostile frames before key material; deducted for the HIGH
self-blocking-wipe defect (real, reachable, mock-masked), the MEDIUM
read-back-≠-persistence fail-open, B2's error-contract non-totality, and the
unbuilt activation glue that must land correctly.

---

## Consolidated findings (all reviews complete)

Full detail in `16` §21 and the specialist sections above. The board's
classification, with the confirmation status each finding reached:

| ID | Sev | Area | Blocks P1? | Confirmation | One-line |
|---|---|---|---|---|---|
| H1 | HIGH | backend (signing lifecycle) | **YES** | Pass A + R3 + R5 | ≤1-active invariant not concurrency-safe; supersede reads active outside its txn; withdrawal clobberable |
| H2 | HIGH | backend (signing lifecycle) | **YES** | Pass A + R3 + R5, **executed ×2** | retirement keyed on base64 string not bytes → a retired key can return |
| NEW-4 | HIGH | client storage (wipe) | **YES** | R4 + verified here | `wipeDevice` self-blocks its own IndexedDB deletes; honest-failure contract defeated; mock-masked; shipped code |
| B1 | HIGH (assurance) | vectors | fix before activation | Pass B + R5, **executed** | conformance vector 13 mis-generated (illustrative HMAC form) + untested; `ratchet.js` itself correct |
| NEW-1 | HIGH (process) | db/CI | see note | R3 + CI verified here | H1 partial-index backstop not applicable under CI's `db push`; advisory-lock primary fix IS CI-verifiable (recorded disagreement) |
| B2 | MED | ratchet | before activation | Pass B + R4 + R5, **executed** | `decrypt()` throws raw non-`RatchetError` on two hostile-frame paths |
| B3 | MED | ratchet | before activation | Pass B + R5, **executed** | non-string plaintext silently encrypted as empty |
| NEW-5 | MED | client storage (persist) | before #39 activation | R4 | read-back ≠ cross-launch persistence; publication gate can fail OPEN on Safari/WebView (+ doc correction) |
| M1 | MED | tests | recommend | Pass A + R3 + R5 | server P-256 supersession verify untested |
| M2 | MED | backend | no (hardening) | Pass A + R3 + R5 | OPK pool has no depletion throttle |
| B6 | LOW→watch | ratchet | before activation | Pass B + R4 + R5 | `deserializeSession` binds nothing (no `selfPub`/`v:1` check) → silently undecryptable session |
| B7 | LOW→watch | x3dh | before activation | Pass B + R5 | verify-then-establish is convention-only; session layer must enforce one safe entry |
| NEW-2 | LOW | backend | no | R3 | SignedPreKey per-device active has same H1-class race |
| L3 | LOW | backend | no | R3 | OPK fetch contention wastes pool (loser returns null vs retry) |
| NEW-6 | LOW | ratchet | no | R4 | evicted skipped message misclassified as `DUPLICATE` (silent loss) |
| NEW-3 | INFO | backend | no | R3 | `opksStored` counted after txn commit (approximate refill hint) |
| L1–L6, B4/B5/B8, nits | LOW/INFO | various | no | Pass A/B + R4/R5 | see `16` §21 and specialist sections |

*Confirmation key: Pass A/B = the two §21 crypto audits; R3/R4/R5 = specialist
reviewers 3/4/5; "executed" = reproduced by running shipped code, this board's
strongest evidence class.*

**Load-bearing fact carried into the verdict:** *no confidentiality or
forward-secrecy break was found by any of the five specialist reviews.* The
crypto core (four-DH X3DH, the ratchet KDF ladder, constant-time comparisons on
secret-free material, OPK single-use atomicity, wire framing that rejects hostile
frames before touching key material) verified correct and byte-for-byte
oracle-conformant. Every HIGH is a bounded, well-understood defect with an
identified minimal fix: two are in the signing-key *backend lifecycle* (H1, H2),
one is a *client storage-lifecycle* bug in the shipped wipe path (NEW-4), and one
is a mis-generated *negative vector* that never gated shipped code (B1). All are
reachable only by an authenticated principal or a local adversary — none is a
remote break of the messaging confidentiality guarantee. **The entire e2e_v3 and
publication surface remains fenced/flag-off, so nothing here is exploitable in
production today.**

---

## HIGH / CRITICAL findings — full engineering analysis

Per the owner directive (2026-08-01), each HIGH is given a structured
engineering analysis on twelve axes. **CRITICAL: none** — no finding reached
CRITICAL; the worst are HIGH, all authenticated-principal or local-adversary,
none a remote break of messaging confidentiality. Cross-verification is folded in
per finding; disagreements are preserved, not averaged (NEW-1).

### H1 — signing-key lifecycle concurrency / withdrawal clobber (HIGH)

- **Root cause.** The "≤1 active row per user" invariant is a read-modify-write
  with no serialization. `publish()` reads the active row inside a txn but takes
  no row lock; `supersede()` reads the active row *outside* its write txn.
  `prisma.service.ts` sets no `isolationLevel`, so interactive txns run at
  Postgres default READ COMMITTED. There is no DB-level partial unique index and
  no P2002 catch.
- **Affected modules.** `backend/src/auth/signing-keys.service.ts` (publish
  :74-99, supersede :108-156, withdraw :166-183); `backend/src/prisma.service.ts`
  (no isolationLevel); `backend/prisma/schema.prisma` :592-593; migration
  `20260801170000_signing_keys`.
- **Security impact.** Two simultaneously-valid trust anchors (split-brain
  identity); an incident-response withdrawal (ADR-008 §12 rollback) silently
  reverted by a racing supersede — in the exact module whose purpose is a
  tamper-evident anchor.
- **Operational impact.** Nondeterministic key served to peers (`fetch` picks
  whichever sorts first); HTTP 500 on a concurrent same-key PUT (uncaught P2002)
  where the contract promises an idempotent 200; the rollback tool cannot be
  trusted to stick under load.
- **Reproduction conditions.** Two concurrent `PUT /v2/auth/signing-key` with
  *different* keys for one principal → two active rows. `DELETE` (withdraw)
  concurrent with `POST /supersede` → active key resurrected. Two identical
  first-publishes → one 500. Authenticated-principal only (self-racing one's own
  account).
- **Why tests did / did not catch it.** Did **not**: the signing-keys e2e suite
  is fully sequential — there is *no* concurrency test for the signing lifecycle,
  while OPK single-use *did* get a 10-way race test (the asymmetry reviewer 5
  flagged). Confirmed by inspection + schema by reviewers 3 and 5.
- **Minimal safe fix.** Per-user transaction-scoped advisory lock
  `pg_advisory_xact_lock(hashtext(userId))` as the first statement in *all three*
  mutating txns; move the active-row read inside the txn; catch Prisma P2002 in
  `publish` as the idempotent path. Application-level, CI-verifiable today.
- **Regression risk introduced by the fix.** LOW. Advisory locks serialize only
  per-user lifecycle writes (rare, administrative) — never the message path or
  any read — and auto-release on commit/rollback. Risk to watch: the lock must
  be in *all three* paths or it protects nothing.
- **Additional tests required after the fix.** publish/supersede/withdraw
  concurrency race incl. the withdraw-vs-supersede clobber; P2002→idempotent-200.
  (Both run against the `db push` schema — the lock is behavioral.)
- **Blocks Priority 1?** **YES.**
- **Affects backward compatibility?** No. No wire/schema/API contract change; the
  lock is invisible to clients and P2002-catch returns the 200 the contract
  always specified. No stored-data migration.
- **Affects e2e_v3 activation?** Indirectly — it gates the signing-key
  publication trust anchor e2e_v3 builds on, so it must be fixed before
  `SIGNING_PUBLICATION_ENABLED` is turned on. Does not touch the ratchet/X3DH
  wire.

### H2 — base64 malleability lets a retired signing key return (HIGH)

- **Root cause.** `Buffer.from(b64,'base64')` ignores the final quantum's unused
  bits, so ~4 strings decode to one key; retirement / idempotency / uniqueness
  compare the *string* (and the DB `@@unique` is on the string) while identity is
  really the decoded bytes — a many-to-one string→identity mapping treated as
  one-to-one.
- **Affected modules.** `backend/src/auth/signing-keys.service.ts` (`validKey`
  :47-68 returns the original string; comparisons :79, :86-88, :114, :138-139);
  `schema.prisma` `@@unique([userId, publicKeyB64])` :592. Cross-module
  inconsistency with `web/src/lib/crypto/device-set.js`, which commits over
  *bytes*.
- **Security impact.** Defeats ADR-008's "a retired key never returns":
  re-encode a withdrawn/superseded key's bytes as a sibling string and
  `publish()` re-activates it (retired-lookup misses, create succeeds). Also
  breaks PUT idempotency the other way (409 on a non-canonical re-publish of
  one's own active key), and lets `supersede` "rotate" to a byte-identical key.
- **Operational impact.** Polluted chain (same key, two rows, divergent status) a
  string-keyed client could mis-render; 409s on innocent retries.
- **Reproduction conditions.** Publish + withdraw key S1; publish S2 (a sibling
  encoding of the same bytes) → 200 active, guard bypassed. App-layer,
  independent of DB, reachable in CI today.
- **Why tests did / did not catch it.** Did **not**: no base64-malleability /
  retired-key-returns test exists; the e2e suite exercises only canonical
  client-generated keys. **Reproduced by execution twice** — reviewer 3 (four
  distinct strings decode byte-identical for a 32-byte key) and reviewer 5 (two
  variant strings both pass the server regex, decode identical).
- **Minimal safe fix.** Canonicalize at ingress
  (`Buffer.from(b64,'base64').toString('base64')`); store / compare / constrain
  on the canonical form.
- **Regression risk introduced by the fix.** VERY LOW. Canonicalization is
  idempotent on already-canonical input; honest clients emit canonical base64, so
  no stored key changes and no migration is needed.
- **Additional tests required after the fix.** publish→withdraw→republish-as-
  variant must refuse (409/blocked); non-canonical re-publish of one's own active
  key → idempotent 200.
- **Blocks Priority 1?** **YES.**
- **Affects backward compatibility?** No for honest clients (already canonical). A
  malicious non-canonical string is now normalized/rejected — that *is* the fix.
  No migration (verify no stored key is non-canonical — true for all
  client-generated keys).
- **Affects e2e_v3 activation?** Same as H1 — gates the publication trust anchor;
  fix before enabling publication.

### NEW-4 — `wipeDevice` self-blocks its own IndexedDB deletes (HIGH)

- **Root cause.** IndexedDB `deleteDatabase` fires `versionchange` at every open
  connection and blocks until they close; the stores never set
  `db.onversionchange` and never `.close()`, and `identity-pin-store.js` caches
  its connection at module level (`dbPromise`) for the module lifetime — so the
  app blocks its own delete.
- **Affected modules.** `web/src/lib/crypto/identity-pin-store.js` (:33,41-45,74
  module-cached connection); `web/src/lib/crypto/signing-key-store.js` (loadOnce
  local-var connection); `web/src/lib/crypto/identity-store.js`
  (loadIdentityOnce); `web/src/lib/db.js` (:139-147 forget+drop fired
  concurrently; :173-195 `dropDatabase` treats `onblocked` as failure);
  `web/test/wipe-device.test.js` (:127-231 mock cannot model blocking).
- **Security impact.** `wipeDevice()` returns `{ok:false, failures:[…]}` whenever
  a chat was opened; if the wipe UX does not force a reload, `spotme-identity-pins`
  ("who this device talked to and when") **survives on disk**. Undercuts ADR-008
  §5 ("`wipeDevice` must delete `spotme-signing`") and the §13 device-thief claim
  — on real browsers, strictly enforced on Safari/WebView.
- **Operational impact.** Trains users/UI to ignore a wipe failure and thus hides
  a *real* one; the certain damage is the broken `{ok, failures}` contract, the
  data-survival conditional on no-reload.
- **Reproduction conditions.** Real browser: open a chat (populates `dbPromise`),
  call `wipeDevice()`, observe `onblocked` on `spotme-identity-pins` and
  `ok:false`. The signing/e2e connections (local vars) block non-deterministically
  by GC.
- **Why tests did / did not catch it.** Did **not**: `wipe-device.test.js`'s
  hand-rolled `indexedDB` mock fires `onsuccess`/`onblocked` on command and never
  models a still-open handle blocking the delete → CI is green over a real bug.
  Single-specialist dimension (crypto passes didn't cover storage lifecycle);
  **re-verified against the source in this board** (no `onversionchange`/`.close()`
  anywhere in `src/`; `db.js:193` reports `onblocked` as failure).
- **Minimal safe fix.** Set `db.onversionchange = () => db.close()` in each
  store's `openDb()`; sequence explicit `close()` of cached connections *before*
  `dropDatabase` (not concurrently); add a wipe-test mock that models a still-open
  handle blocking the delete.
- **Regression risk introduced by the fix.** LOW–MEDIUM. `onversionchange→close()`
  is the standard idiom and fires only during delete/upgrade; risk to watch is a
  live read/write in flight when the close lands — sequence closes after in-flight
  ops settle (stores already serialize through a promise cache). Without the new
  mock the fix is unverified.
- **Additional tests required after the fix.** A wipe test whose mock models a
  still-open handle blocking the delete, asserting `wipeDevice()` returns
  `ok:true` *and* the pin DB is actually gone.
- **Blocks Priority 1?** **YES** — shipped code, ADR-008 §5/§13 guarantee.
- **Affects backward compatibility?** No — `onversionchange`/`close()` is internal
  lifecycle; no data format, wire, or API change. It *improves* wipe correctness.
- **Affects e2e_v3 activation?** Yes, forward-looking: when e2e_v3 ships,
  `wipeDevice` must also drop the v3 session store (root/chain/skipped keys); that
  new delete would hit the *same* block, so NEW-4 must be fixed before the v3
  session store is added to the wipe path.

### B1 — conformance vector 13 mis-generated + untested (HIGH, assurance)

- **Root cause.** Vector 13's message keys were hand-computed with the
  *illustrative* `HMAC(ck, LABEL+"/n")` form (copied from the superseded 004a
  `.mjs` sketch, itself a *third* divergent `HKDF(ck, info="msg/0")` formula), not
  the authoritative ratchet step `HKDF(salt=ck, ikm=0x01, info="…/msg", 64)[32:64]`
  that vectors 01/03/05 and `ratchet.js` use. Never wired into any test.
- **Affected modules.** `spotme/docs/adr/004b-e2e-v3-ratchet-vectors.py`
  (generator ~:358-373); the committed vectors JSON (group 13 only); the stale
  `spotme/docs/adr/004a-e2e-v3-vectors.mjs` sketch (:90). **NOT `ratchet.js`** —
  it is correct.
- **Security impact.** None on shipped code — the real off-by-one *is* caught
  byte-for-byte by tested vector 03. The flagship *negative* vector provides zero
  assurance.
- **Operational impact.** A live trap: an engineer who "wires up vector 13," sees
  it fail against correct code, and "fixes" `messageStep` to match would **break**
  real conformance.
- **Reproduction conditions.** Feed vector 13's `chain_key` through the shipped
  `messageStep` → result matches neither `correct_message_key` nor `off_by_one`
  (executed by reviewer 5, `scratchpad/verify_b1.mjs`); grep → no test references
  the vector's fields.
- **Why tests did / did not catch it.** Did **not**: the vector was never
  consumed by an assertion (data with no test), and the `.mjs` sketch is imported
  by no test (only cited in an `x3dh.test.js` comment). A differential-KDF test
  would have caught it at authoring time.
- **Minimal safe fix.** Regenerate vector 13's `correct_message_key` /
  `off_by_one` from the real construction (`correct = messageStep(ck).messageKey`,
  `off_by_one = messageStep(messageStep(ck).chainKey).messageKey`); add a
  `ratchet.test.js` assertion feeding vector 13's `chain_key` through `messageStep`
  (`=== correct && !== off_by_one`); delete or wire the stale `.mjs` sketch.
- **Regression risk introduced by the fix.** NONE to shipped code — only the
  vector file and a new test assertion change.
- **Additional tests required after the fix.** The vector-13 assertion itself;
  optionally the differential-KDF property (`messageStep`/`rootStep` vs an
  independent HKDF implementation).
- **Blocks Priority 1?** NO for the shipped build (ratchet.js correct, vector
  unused); **YES for 004b vector-package sign-off** — the owner has elected to
  correct it inside this cleanup iteration so the negative vector actually guards
  before the stack merges.
- **Affects backward compatibility?** No — vectors/tests only; no shipped code or
  wire touched.
- **Affects e2e_v3 activation?** Yes as an assurance gate — the negative vector
  must guard before e2e_v3 is trusted in production; does not change the wire or
  behavior.

### NEW-1 — H1 DB-backstop not applicable under CI's `db push` (HIGH, process — recorded disagreement)

- **Root cause.** CI provisions the DB with `npx prisma db push` (`ci.yml:117`,
  `:207`), not `migrate deploy`; Prisma `^5.22.0` cannot express a partial/filtered
  unique index — so the `(userId) WHERE status='active'` backstop can only live as
  raw SQL in a migration that `db push` never applies.
- **Disagreement, preserved.** The Database reviewer (R3) rates this as *blocking*
  because it makes the *index* fix un-verifiable in CI. The coordinator +
  applied-crypto position: the **advisory lock is the CI-verifiable primary fix**
  (application-level, behavioral, `db push`-independent), so H1 is closable now;
  the partial index is *deferred defense-in-depth* that additionally requires
  moving CI to `migrate deploy` + a schema/migration parity guard. **Board
  conclusion (stronger evidence):** NEW-1 does *not* independently block Priority
  1 given the advisory lock; the CI-to-migrations change is a MEDIUM follow-up.
  Facts undisputed and verified in this board; only the blocking classification
  differed.
- **Blocks Priority 1?** No (as a standalone) — folded into H1's fix as the
  primary-vs-defense-in-depth split.
- **Backward compatibility / e2e_v3 activation.** None / none directly.

### NEW-5 — read-back ≠ cross-launch persistence; publication gate can fail OPEN (MEDIUM)

Kept here for continuity with NEW-4 (same storage/Safari surface). Same-session
read-back proves *commit*, not *survival across a restart*; Safari ITP / 7-day
eviction can drop the key before next launch, after which `loadOnce` regenerates
a *different* key and could republish it (the ADR-008 §4 identity-change
catastrophe) — **fail-open**, contradicting the review package's "fails closed to
ephemeral" claim (§2, §12.2, a documentation correction). **Blocks P1:** no while
publication is OFF; **YES before #39 is activated on Safari/WebView.** **Fix:**
boot-time re-verification that the stored key matches the published
`publicKeyB64`; on absence surface identity-loss, never silently
regenerate-and-republish. **Backward compat:** none. **e2e_v3 activation:** a
Safari/WebView activation gate.

## Consolidated risk register

**This is the single canonical risk register**, de-duplicated and merged across
all five specialist passes (severity + likelihood + impact + confirmation +
blocks-P1). Final Report §3 is the *same* rows presented as a mitigation/action
view (R-1..R-5 align exactly); where the two differ in tail numbering, this table
governs. No two rows describe the same defect (H1 and NEW-2 share a *root cause*
but are distinct sites; NEW-1 is a process caveat on H1's fix, not a second
defect).

| # | Finding | Sev | Likelihood | Impact | Confirmation | Blocks P1 |
|---|---|---|---|---|---|---|
| R-1 | H1 signing concurrency / withdraw-clobber | HIGH | Med (self-race) once published | High | Pass A + R3 + R5 (3-way) | YES |
| R-2 | H2 base64 malleability → retired key returns | HIGH | Med once published | High | Pass A + R3 + R5, executed ×2 | YES |
| R-3 | NEW-4 `wipeDevice` IndexedDB self-block | HIGH | High on Safari/WebView today | High | R4 + verified here | YES |
| R-4 | B1 broken+untested negative vector 13 | HIGH (assurance) | Med (latent trap) | Med | Pass B + R5, executed | Sign-off |
| R-5 | NEW-5 read-back ≠ persistence (fail-open) | MED | Med on Safari when active | High | R4 | At activation |
| R-6 | B2 `decrypt` not total (raw non-RatchetError) | MED | Low (fenced) | Med | Pass B + R4 + R5, executed | At activation |
| R-7 | B3 non-string plaintext → silent empty | MED | Low (fenced) | Med | Pass B + R5, executed | At activation |
| R-8 | M1 server P-256 supersede verify untested | MED | — | Med (silent lockout) | Pass A + R3 + R5 | Recommend |
| R-9 | M2 OPK depletion no throttle | MED | Med when active | Low–Med | Pass A + R3 + R5 | No |
| R-10 | NEW-1 H1 index unenforceable under `db push` | HIGH (process) | n/a | Med | R3 + CI verified | No (see H1) |
| R-11 | B6/B7 session-restore/verify binding gaps | LOW→watch | Low | Med | Pass B + R4 + R5 | At activation |
| R-12 | L2 OPK sentinel `keyId` not excluded | LOW | Low | Low | Pass A + R3 + R5 | No |
| R-13 | NEW-2/L3/NEW-6/NEW-3 + L1/L4/L5/B4/B5/B8 | LOW/INFO | Low | Low | various | No |
| R-14 | No observability for an activated rollout | — | n/a until activation | Med | Coordinator | At activation |
| R-15 | No secret zeroization (memory/disk residue) | INFO | Low | Low | R5 | No |

## Consolidated cleanup plan (implementation-ready, dependency-ordered)

Per the owner's revised merge plan (2026-08-01): **one focused cleanup iteration
before the crypto stack merges**, containing *only* confirmed review findings —
no refactoring, no new features, no ADR expansion, no "while we're here." Grouped
by severity; within each PR, findings that fixed the same file are done together.
Each PR carries the seven required fields.

**These PRs are authorized to be *written* only after the owner accepts the
verdict and lifts the freeze for the cleanup iteration.**

### Cleanup PR-1 — CRITICAL
**None.** No finding reached CRITICAL. This slot is intentionally empty; the
iteration begins at PR-2.

### Cleanup PR-2 — HIGH (H1, H2, NEW-4, B1) — the Priority-1 gate
- **Scope.** Exactly the four HIGH fixes. Nothing else.
- **Files affected.** `backend/src/auth/signing-keys.service.ts` (H1 locks +
  in-txn reads + P2002 catch; H2 canonicalization); `web/src/lib/crypto/`
  `identity-pin-store.js` + `signing-key-store.js` + `identity-store.js` and
  `web/src/lib/db.js` (NEW-4 `onversionchange`/`close` + close-before-drop
  sequencing); `spotme/docs/adr/004b-e2e-v3-ratchet-vectors.py` + the vectors
  JSON (group 13) + remove/wire `004a-e2e-v3-vectors.mjs` (B1).
- **Tests to update / add.** Backend: signing publish/supersede/withdraw
  concurrency race incl. withdraw-vs-supersede clobber; base64-malleability
  retired-key-returns; canonical-idempotency; P2002→idempotent-200; server
  ECDSA-P-256 supersede verify (M1, adjacent to H1/H2 in the same file — folded
  in). Web: `wipe-device.test.js` with a connection-blocking mock;
  `ratchet.test.js` vector-13 assertion.
- **Benchmarks required.** None. The fixes touch rare administrative paths
  (signing lifecycle) and the wipe path — neither is a steady-state hot path.
  Per the owner's earlier ruling, a supersession/lifecycle microbenchmark is not
  required; the existing ratchet/X3DH benchmarks are unaffected (no ratchet code
  changes). If the advisory lock is suspected to serialize under load, a one-off
  lifecycle-latency check suffices — not a gate.
- **Rollback strategy.** Clean `git revert` of the PR. No data migration, no wire
  change, no schema change (advisory lock is runtime SQL; canonicalization is
  idempotent; wipe lifecycle is internal; vectors are test data), so revert is
  immediate and lossless. All flags remain OFF throughout.
- **Expected regression risk.** H1 LOW, H2 VERY LOW, NEW-4 LOW–MEDIUM, B1 NONE
  to shipped code. Aggregate LOW.
- **CI validation required.** Full green CI (backend Postgres suite incl. the new
  concurrency test; web suite incl. wipe + vector-13; e2e). The fence tests
  (`signing-not-shipped.test.js`, `e2e-v3-not-shipped.test.js`) must still pass —
  flags stay OFF, nothing gets wired into the app.

### Cleanup PR-3 — MEDIUM (B2, B3, NEW-5; M2 optional)
- **Scope.** Pre-activation error-contract + fail-open fixes. B2, B3, NEW-5;
  M2 (OPK throttle) may ride along or defer.
- **Files affected.** `web/src/lib/crypto/ratchet.js` (B2 wrap DH + step-3 to
  `RatchetError`; B3 throw on non-string); `web/src/lib/crypto/signing-key-store.js`
  (NEW-5 post-publication re-verify); `backend/src/auth/prekeys.service.ts` (M2,
  if included). Correct the "fails closed to ephemeral" text in doc `16` §2/§12.2.
- **Tests to update / add.** `decrypt` totality (low-order `ratchetPub`,
  pre-first-receive `messageStep(null)`) raises `RatchetError`; non-string
  plaintext rejected; post-publication persistence re-verify; (M2) OPK-depletion
  throttle.
- **Benchmarks required.** None — B2/B3/NEW-5 are guard clauses on
  already-benchmarked paths; confirm the ratchet encrypt/decrypt medians are
  within noise of the existing numbers (Final Report §Performance).
- **Rollback strategy.** `git revert`; all e2e_v3 code is fenced/flag-off, so a
  revert has no production effect.
- **Expected regression risk.** LOW — added guard clauses and a gated boot check.
- **CI validation required.** Full green CI + fence tests still passing.

### Cleanup PR-4 — LOW + documentation
- **Scope.** LOW findings + documentation corrections. No behavior change to hot
  paths.
- **Files affected.** `backend/src/auth/prekeys.service.ts` (L2 sentinel/upper
  bound; L3 contention retry); `web/src/lib/crypto/ratchet.js` (B4 pn-path bound
  test; B5 FLAGS bit; B6 `deserializeSession` binding); `web/src/lib/crypto/`
  `device-set.js` (L4 duplicate-id); docs (remove non-reproducible
  mutation-testing comment claims; NEW-3 `opksStored` comment; NEW-6
  evicted-vs-duplicate note).
- **Tests to update / add.** `rotateSigningIdentity` EPHEMERAL-refusal;
  `publishSigningIdentity` UNREADABLE-refusal; device-set duplicate-id;
  `MAX_SKIPPED_STORED` FIFO eviction; pn-path skip bound; `deserializeSession`
  mismatch.
- **Benchmarks required.** None.
- **Rollback strategy.** `git revert`; documentation and low-risk guards only.
- **Expected regression risk.** VERY LOW.
- **CI validation required.** Full green CI + fence tests still passing.

**Deferred beyond the cleanup iteration (activation-layer, own future PRs):** the
H1 defense-in-depth partial unique index (requires CI `db push`→`migrate deploy`
+ parity guard, NEW-1); `e2eVersion` monotonicity guard; version-mismatch cursor
mapping; the 145-byte X3DH prologue parser; extending `wipeDevice` to the v3
session store; observability/metrics wiring; and the property/fuzz/mutation test
suite (reviewer 5's proposal, a recommended follow-up). None of these is a
Priority-1 gate; all land with the future e2e_v3 wire-up.

## Board re-verification protocol (post-cleanup)

The verdict below is **APPROVED WITH FIXES**. Per the owner's revised plan, after
Cleanup PR-2 (HIGH) lands the board re-convenes to verify — not assume — closure
before the verdict is allowed to flip to APPROVED:

1. **Rerun CI** on the fixed stack — full backend/web/e2e green.
2. **Rerun vector validation** — the 13-group conformance suite green, *including*
   the newly-wired vector-13 assertion (B1).
3. **Rerun wipe tests** — with the connection-blocking mock in place, `wipeDevice`
   returns `ok:true` and the pin DB is gone (NEW-4).
4. **Rerun concurrency tests** — the signing publish/supersede/withdraw race +
   withdraw-clobber hold the ≤1-active invariant (H1); base64-malleability refused
   (H2).
5. **Confirm the fences still pass** — flags OFF, nothing wired in.

Only if all four HIGH findings verify resolved **and no new HIGH/CRITICAL
finding appears** does the board issue **APPROVED**. If any HIGH remains open or a
new HIGH surfaces, the verdict stays APPROVED WITH FIXES and the iteration
repeats. **No verdict flip is issued on the promise of a fix — only on re-verified
evidence.**

# Final Review Board Report

All five specialist reviews and the coordinator have reported. Every HIGH was
independently confirmed (H1 three ways; H2 by execution twice; B1 by execution;
NEW-4 re-verified against the code in this board). What follows is the single
consolidated report the owner directive requires.

## 1. Executive summary

Priority 1 delivers a coherent, well-layered end-to-end encryption foundation —
e2e_v2 → A1–A5 trust → A7 signing identity → e2e_v3 (X3DH + Double Ratchet) →
multi-device — built as a small, individually-reviewable stack of PRs, with a
complete ADR trail, reproducible independent-oracle test vectors, and
build-enforced fences that keep the entire e2e_v3 and publication surface
unreachable from the shipped app until the owner authorizes activation. **No
specialist found a confidentiality or forward-secrecy break.** The crypto core
(four-DH X3DH, the ratchet KDF ladder, the wire framing, OPK single-use
atomicity) verified correct and byte-for-byte conformant to an independent
Signal-library oracle, with constant-time handling of all secret material.

It is **not** finished. Five specialist passes converged on **four confirmed
HIGH defects** — two in the signing-key backend lifecycle (H1 concurrency, H2
base64 malleability), one in the shipped client wipe path (NEW-4 IndexedDB
self-block), and one broken-and-untested negative test vector (B1) — plus a set
of MEDIUMs that must be fixed before the publication path is activated. Every one
is bounded, well-understood, and has an identified minimal fix with low
regression risk; none requires an architectural change. That is the signature of
a sound design with a real, finite fix list — **APPROVED WITH FIXES**, not
approval, and emphatically not rejection.

## 2. Scores

Aggregated from the specialist passes (each score is evidence-backed in its
section above; disagreements are recorded, not averaged away).

| Dimension | Score | Basis |
|---|---|---|
| **Overall engineering** | **7 / 10** | Strong architecture + disciplined stacked delivery; dragged by H1 concurrency, NEW-4 storage lifecycle, permissive READ COMMITTED with no locking, B2/B3 error-contract non-totality, and the signing-vs-OPK test asymmetry |
| **Overall cryptography** | **8 / 10** | Core correct, oracle-conformant, constant-time, non-extractable, well domain-separated, no confidentiality/FS break; held down by H2 (string-keyed identity), B1 (broken negative vector), and absent negative/property tests |
| **Production-readiness** | **6 / 10** | Safe *frozen* posture (all flags off, fenced, verified); **not** ready to activate — H1/H2/NEW-4 unfixed, observability unbuilt, Safari/WebView persistence unproven (NEW-5), CI on `db push` not migrations (NEW-1), no property/fuzz/mutation tests |
| **Maintainability** | **8 / 10** | Heavy "why" comments, complete ADR trail, reproducible vectors, build-enforced fences, injected AEAD/keygen seams; debts: `dh()`/`toB64` triplication, duplicated IDB fakes, `chat.js` ~4600 lines (pre-existing), non-reproducible mutation-testing comment claims |
| Architecture (coordinator) | 8.5 / 10 | Clean layering, explicit dependencies, server-as-adversary throughout, reversible per-layer |
| Cryptographic design (Pass B) | 8 / 10 | X3DH + ratchet correct and conformant; the assurance artifacts (vector 13) let it down, not the code |
| Applied crypto / signing lifecycle (Pass A) | 6.5 / 10 | Sound design; H1 + H2 live here |
| Backend architecture (R3) | 6 / 10 | Clean NestJS, strict principal-keying; two correctness bugs in the trust-anchor path |
| Database engineering (R3) | 5 / 10 | Thoughtful modeling, no drift; central invariant has no DB enforcement CI can even apply |
| Reliability (R3) | 6 / 10 | Atomicity + OPK single-use solid; concurrency fails on the incident-response path |
| Frontend / storage (R4) | 7 / 10 | Rigorous storage design; the HIGH wipe self-block + MEDIUM fail-open |
| Networking (R4) | 8 / 10 | Byte-correct framing, rejects hostile frames before key material; B2 + unbuilt activation glue |
| Security (R5) | 7 / 10 | Correct, fenced, constant-time core; two real HIGH lifecycle bugs, no zeroization |
| Testing / coverage (R5) | 6 / 10 | Excellent positive oracle conformance; broken negative vector, no signing concurrency test, no property/fuzz |
| Performance (coordinator) | 8 / 10 | Sub-millisecond steady-state CPU in-container; phone/WebView numbers outstanding |
| Documentation (coordinator) | 8.5 / 10 | Coherent ADR + package trail; B1 vector defect + missing observability runbook |
| Production operations (coordinator) | 7.5 / 10 | Safe hold posture; observability is the pre-activation gap |

## 3. Risk register

*Mitigation/action view of the single canonical register (see "Consolidated risk
register" above, which governs on severity, confirmation, and blocks-P1). R-1..R-5
align exactly.*

| # | Risk | Likelihood | Impact | Current mitigation | Required action |
|---|---|---|---|---|---|
| R-1 | Two simultaneously-valid signing keys, or an incident-response withdrawal silently reverted (H1) | Med once published (self-race) | High (split trust anchor; rollback defeated) | Path is flag-off; single-writer in practice | Advisory lock + in-txn read + P2002 catch + concurrency test |
| R-2 | A retired/withdrawn signing key returns via base64 re-encoding (H2) | Med once published | High (breaks ADR-008 "retired never returns") | Flag-off; honest clients emit canonical b64 | Canonicalize at ingress; store/compare canonical |
| R-3 | `wipeDevice` reports failure and/or leaves pin data on disk on real browsers (NEW-4) | **High on Safari/WebView today** | High (wipe guarantee + honest-failure contract) | None effective; masked by test mock | `onversionchange→close()` + sequence closes before delete + real mock |
| R-4 | Flagship negative vector gives zero assurance; a future engineer "fixes" correct code to match it (B1) | Med (latent trap) | Med (could break real conformance) | Shipped code is correct; vector unused by tests | Regenerate vector 13 + add assertion; remove stale `.mjs` |
| R-5 | Published key is ephemeral across launches on Safari → identity-change alarms (NEW-5) | Med on Safari when activated | High (§4 catastrophe) | Flag-off | Post-publication boot re-verification; fix the doc claim |
| R-6 | `decrypt` crashes the receive loop on hostile bytes (B2) | Low (fenced) | Med (receive-path DoS) | Fenced; fails closed | Wrap DH + step-3 to `RatchetError` |
| R-7 | Silent data loss on non-string plaintext (B3) | Low (fenced, caller-controlled) | Med | Fenced | Throw on non-string |
| R-8 | OPK pool drained → forced no-OPK fallback for a peer (M2) | Med when activated | Low–Med (visible downgrade) | Fallback is visible/functional | Per-(requester,peer) throttle |
| R-9 | H1 DB-backstop unenforceable under CI's `db push` (NEW-1) | n/a (process) | Med (index fix unverifiable) | Advisory lock is the real fix, CI-verifiable | Move CI to `migrate deploy` + parity guard (deferred) |
| R-10 | No observability for an activated rollout | n/a until activation | Med (blind rollout) | prom-client present but unwired | Build undecryptable/fallback/bound-hit counters before activation |
| R-11 | Memory/disk residue of secret keys (no zeroization) | Low | Low (local adversary) | Standard JS limitation; consumed keys deleted | Accept + document; INFORMATIONAL |

## 4. Remaining blockers (must clear before Priority 1 is declared complete / #39 merges)

- **H1** — signing-key lifecycle concurrency (three-way confirmed).
- **H2** — base64 malleability (executed twice).
- **NEW-4** — `wipeDevice` IndexedDB self-block (verified here; shipped code).
- **B1** — negative vector 13 broken + untested (executed) — blocks 004b-package
  sign-off, not the shipped build, but must be cleared before activation.

## 5. Every HIGH / MEDIUM / LOW finding

Full table in "Consolidated findings" above. HIGH: H1, H2, NEW-4, B1, NEW-1
(process). MEDIUM: B2, B3, NEW-5, M1, M2. LOW/watch: B4, B5, B6, B7, L1–L6,
NEW-2, NEW-6, L3. INFO: NEW-3, memory-lifecycle. Each carries evidence, root
cause, impact, reproduction, minimal fix, and regression risk in the sections
above.

## 6. Deferred improvements (documented, non-blocking)

CI `db push`→`migrate deploy` + partial-index backstop (NEW-1); OPK throttle
(M2); OPK contention retry (L3); SignedPreKey per-device race (NEW-2);
`opksStored` comment (NEW-3); evicted-vs-duplicate signal (NEW-6); property/fuzz/
mutation test suite; the `dh()`/`toB64` de-duplication; secret zeroization where
JS permits.

## 7. Documentation gaps

- B1 vector defect: the 004b vector-13 values are wrong and a stale 004a `.mjs`
  sketch carries a third divergent formula — correct both.
- The review package's "fails closed to ephemeral" claim (§2, §12.2) is wrong for
  the Safari cross-launch eviction case (NEW-5) — correct it.
- Mutation-testing claims in code comments are not reproducible (no config) —
  remove or make real.
- No observability/rollout runbook for an activated e2e_v3 (metrics, cursor
  mapping, negotiation) — write before activation.
- ADR-013 multi-device fan-out is design-only (expected — gated on the
  safety-number ratification, which remains an owner decision).

## 8. Missing tests (the concrete list to add)

Signing backend: publish/supersede/withdraw concurrency + withdraw-clobber (H1);
base64-malleability resurrection (H2); server P-256 supersede verify (M1);
P2002→idempotent-200. Client storage: wipe with a connection-blocking mock
(NEW-4); post-publication persistence re-verify (NEW-5). Ratchet: vector-13
assertion via `messageStep` (B1); `decrypt` totality on low-order/`null`-chain
(B2); non-string reject (B3); `deserializeSession` mismatch (B6); FLAGS bit
(B5); `MAX_SKIPPED_STORED` FIFO eviction; the `pn`-path skip bound (B4). X3DH:
establish-over-unverified-bundle prevented (B7); low-order peer keys; P-256
`verifyBundleSpk`. Cross-cutting: **no property/fuzz/mutation tests exist** —
add the differential-KDF and metamorphic-ratchet properties reviewer 5 specified.

## 9. Required cleanup before merge

Per the owner's revised merge plan (2026-08-01): **the crypto stack does not
merge until one focused cleanup iteration lands and the board re-verifies it.**
The full plan is in "Consolidated cleanup plan" above — severity-grouped and
dependency-ordered, containing *only* confirmed review findings (no refactoring,
no new features, no ADR expansion, no "while we're here"):

- **Cleanup PR-1 (CRITICAL):** none.
- **Cleanup PR-2 (HIGH — the Priority-1 gate):** H1, H2, NEW-4, B1 — and nothing
  else. M1 folds in (same file as H1/H2).
- **Cleanup PR-3 (MEDIUM):** B2, B3, NEW-5 (+ M2 optional).
- **Cleanup PR-4 (LOW + docs):** L2/L3/B4/B5/B6/L4/NEW-2/NEW-3/NEW-6 + doc
  corrections.

Each carries Scope / Files affected / Tests / Benchmarks / Rollback / Regression
risk / CI validation (above). No behavior of the shipped app changes with flags
off; the fixes are localized to the signing backend, the wipe path, the fenced
ratchet, and test vectors. After PR-2 lands, the **Board re-verification protocol**
(above) runs before the verdict is permitted to flip to APPROVED.

## 10. Priority 1 verdict

# ✅ APPROVED WITH FIXES

**Reasoning, from the evidence — not from any prior expectation.** The
architecture is sound and reversible, the cryptographic core is correct and
independently oracle-conformant, all secret-material handling is constant-time,
and the entire risk surface is fenced/flag-off so nothing is exploitable in
production today. Against that, five independent specialist passes converged on a
**finite, fully-enumerated set of real defects** — four HIGH (H1, H2, NEW-4, B1)
and five MEDIUM — each confirmed (several by execution, the rest cross-checked or
re-verified in this board), each with a minimal fix and a low-to-moderate
regression risk, and **none** requiring a redesign or exposing a confidentiality/
forward-secrecy break.

- Not **APPROVED**: there are confirmed HIGH defects in shipped and merge-
  candidate code (the wipe self-block ships today; H1/H2 gate #39). Priority 1
  cannot be declared *complete* over them.
- Not **REJECTED**: no architectural flaw, no confidentiality break, no
  systemic problem. The design held up under five adversarial passes; the fix
  list is bounded and cheap relative to the work already done.

**Revised merge plan (owner directive, 2026-08-01) — the path to APPROVED.** The
crypto stack does **not** merge as-is. Instead:
1. Land **Cleanup PR-2 (HIGH)** — H1, H2, NEW-4, B1 only — each with its named
   test and full green CI, each reviewed, none merged without review.
2. Run the **Board re-verification protocol** (rerun CI, vector validation, wipe
   tests, concurrency tests; confirm the fences still pass).
3. If all four HIGH verify resolved **and no new HIGH/CRITICAL appears**, the
   board issues **APPROVED** — the stronger place to begin Priority 2 from. If any
   HIGH remains open or a new one surfaces, the verdict stays APPROVED WITH FIXES
   and the iteration repeats. *No flip on the promise of a fix — only on
   re-verified evidence.*
4. Cleanup PR-3 (MEDIUM) and PR-4 (LOW+docs) land before activation; they are not
   the P1-complete gate. Activation of `e2e_v3` / `SIGNING_PUBLICATION_ENABLED`
   remains a **separate** future step behind its own gates (observability,
   negotiation, monotonicity, prologue parsing, Safari persistence
   re-verification), unchanged by this verdict.

**The freeze holds until the owner authorizes the cleanup iteration.** This board
modified no code and merged nothing. The cleanup PRs are authorized to be
*written* only on the owner's authorization, and only as scoped in §9 / the
Consolidated cleanup plan — confirmed review findings, nothing more.

---

*Board complete 2026-08-01. Reviewers: Cryptography (Pass B), Applied
Cryptography (Pass A), Backend/Database/Reliability (R3), Frontend/Storage/
Networking (R4), Testing/Security synthesis (R5), Coordinator. Evidence lives in
this document, `16` §21, and the reproductions cited inline.*
