# Priority 2 — Complete Engineering Build Report

**Date:** 2026-08-02 · **Author:** autonomous engineering session · **Status:** all
work delivered as **draft PRs**; nothing merged, activated, or wired in; Priority
1 remained frozen and immutable throughout.

This is the full record of the overnight mission: what was built, the exact
evidence, every constraint upheld, the deferred work, the risks, the owner
decisions that gate progress, and the recommended path once Priority 1 is
accepted.

---

## Part I — Executive overview

Two things happened this session, in strict order and isolation:

1. **Priority 1 was reviewed, cleaned, and re-verified to an APPROVED verdict** —
   and then left **frozen, awaiting your merge decision.** A formal review board
   found four HIGH blockers; a single owner-authorized HIGH-only cleanup fixed
   them; an independent re-verification confirmed all four closed (7-of-7
   owner-required checks); CI is green. Nothing was merged.

2. **Priority 2 was engineered** — first as a complete **planning package** (5
   workstream designs + cross-cutting synthesis, PR #47), then as **five isolated,
   additive, flag-gated, tested draft PRs** (#48, #52, #51, #49, #50) that build
   the real foundations without touching Priority 1, changing crypto, activating
   anything, or wiring into production.

**The project now waits on you** for a short list of decisions (Part VIII).
Everything else is done and reviewable.

### Every open PR at a glance

| PR | Title | Base | Kind | State |
|---|---|---|---|---|
| #45 | Priority 1 review board — verdict APPROVED | feat/multi-device | docs | green, awaiting review |
| #46 | HIGH-only cleanup (H1,H2,NEW-4,B1) | feat/multi-device | fix | green + re-verified |
| #47 | Priority 2 planning package (8 docs) | docs/platform-adrs | docs | green |
| #48 | Push SDKs (OneSignal + Novu) | master | deps | **CI fully green** |
| #52 | **PR A — Push platform** | feat/push-notification-sdks | impl | CI running |
| #51 | **PR B — Translation abstraction** | master | impl | green (local 1049/1049) |
| #49 | **PR C — Live voice scaffold** | master | scaffold | green (68 tests) |
| #50 | **PR D — Adaptive transport + Bluetooth** | master | scaffold | green (72 tests) |

Plus the unmerged Priority 1 stack: #39 (Phase 2B) → #41 (X3DH) → #42 (Double
Ratchet) → #43 (multi-device, needs ratification) → #44 (completion evidence).

---

## Part II — Priority 1 status (frozen, APPROVED, awaiting you)

### The review board
A formal engineering review board (Cryptography, Applied Cryptography,
Backend/Database/Reliability, Frontend/Storage/Networking, Testing/Security, +
coordinator) reviewed the entire e2e_v3 stack against the repository, ADRs, tests,
and vectors. **No confidentiality or forward-secrecy break was found.** The crypto
core (four-DH X3DH, the ratchet KDF ladder, wire framing, OPK single-use
atomicity) verified correct and byte-for-byte conformant to an independent
Signal-library oracle. Full report: `spotme/docs/18-PRIORITY-1-REVIEW-BOARD.md`.

### The four HIGH blockers and their fixes (Cleanup PR #46)
- **H1** — signing-key `≤1 active` invariant not concurrency-safe → per-user
  `pg_advisory_xact_lock` in all three mutating transactions + in-transaction
  reads + P2002-idempotent publish.
- **H2** — base64 malleability let a retired key return → canonicalize at ingress.
- **NEW-4** — `wipeDevice` self-blocked its own IndexedDB deletes → `onversionchange
  → close()` in all three stores.
- **B1** — a mis-generated, untested negative test vector → regenerated from the
  authoritative `messageStep`; `ratchet.js` unchanged.

### Re-verification (7-of-7)
An independent adversarial agent (which did **not** implement the fixes)
explicitly confirmed all seven owner-required closure points; the B1 key was
recomputed two independent ways; both shipping fences pass (20/20 + 10/10); the
diff is exactly the four findings + tests. **CI on #46 is fully green** (web +
backend-Postgres + e2e). Board verdict flipped **APPROVED WITH FIXES → APPROVED.**

### What Priority 1 needs from you
1. Accept the APPROVED verdict and authorize merging the stack (#39 → #41 → #42 →
   #43 → #46).
2. Ratify (or amend) the **#43 multi-device safety-number construction** (ADR-008
   §BLOCKING) — the one design decision reserved for you.

---

## Part III — Priority 2 planning package (PR #47)

Eight documents, ~6,900 lines, planning-only, covering all five workstreams
(push, translation, live voice, adaptive network, AI platform) with API
contracts, sequence + state diagrams, DB proposals, benchmark/rollout/rollback
plans, ADR improvements, a consolidated risk register, an implementation-order +
dependency graph, and a production-readiness checklist. This package is the design
authority the build PRs implement against.

---

## Part IV — Priority 2 build (the five PRs, in full detail)

Common guarantees for **every** build PR: additive; isolated; compiles/loads
independently; flag defaults **OFF**; not imported by the running app; no Priority
1 or `crypto/` file touched; no existing test modified; no cryptographic behavior
changed; ADR addendum + rollback + tests included; committed with no
`Co-Authored-By` trailer.

### PR #48 — Provider SDKs (dependency-only)
- **Added:** `@onesignal/node-onesignal ^5.13.1` (MIT), `@novu/node ^2.6.6` (MIT).
- **Already present:** `firebase-admin` (FCM), `web-push`. So all four provider
  strategies' server SDKs now exist for the abstraction.
- **No-AGPL gate:** passed (both MIT). **Packages only** — nothing imports them.
- **CI:** fully green including the backend-Postgres job (deps install + build).
- **Flagged for you:** `npm audit` reports 33 advisories (8 high) from transitive
  deps — **not** auto-fixed (out of scope; forced fixes risk breakage). Review
  before any wiring.

### PR #52 — PR A — Enterprise Push Notification Platform (real implementation)
Base: `feat/push-notification-sdks`. **47 files, +4,483.** Module:
`spotme/backend/src/notifications/`.

- **Catalog** (`catalog/`) — class → policy (priority, collapse, TTL, channel,
  route, default) for message/knock/call/mention/group/story/security/login/
  verification/silent. message/knock preserve today's behaviour; everything else
  defaults OFF.
- **State machine** (`state/`) — `queued→sending→sent→delivered→opened/dismissed`
  plus suppressed/collapsed/failed/abandoned/expired; illegal transitions throw.
- **Transport abstraction** (`transport/`) — `INotificationTransport` with real
  **FCM** (`firebase-admin`) and **Web Push** (`web-push`) via injectable seams;
  **OneSignal** and **Novu** as interface-conformant stubs that never activate on
  the default path; per-class priority mapping; per-transport batching.
- **Outbox** (`outbox/`) — `FOR UPDATE SKIP LOCKED` claim (CTE + `UPDATE…RETURNING`),
  exponential backoff + **full jitter**, transient/permanent error taxonomy,
  server-side coalescing, FCM multicast batching, `@Cron` worker with the
  `storage-cleanup` overlap-guard shape.
- **Preferences** (`preferences/`) — server-side quiet-hours/mute/DND/priority,
  timezone-correct (built-in `Intl`, midnight-crossing, call-override); formatter
  caching cut evaluation ~30× (62→2.1 µs/op).
- **Metrics** (`metrics/`) — `prom-client` counters/histograms/gauges on their own
  registry (the first `/metrics` consumer) + a `/metrics` controller.
- **Receipts** (`receipts/`) — delivered/opened/dismissed, idempotent, content-free.
- **Migration** — additive `20260802120000_notifications_v2_platform`: 4 new tables,
  **no existing table altered** (`schema.prisma` +85/−0), drop-script rollback.
- **E2EE:** content-less by construction (fence-asserted: no type/table has a
  message-content field). The cleartext `tag:roomId` leak is closed with an
  **opaque SHA-256 collapse id** (a hash, not a key).
- **Deferred (by design):** rich decrypted native content + the notification key —
  `envelope/encrypted-envelope.seam.ts` **throws and generates no key** (gated on
  your ADR-008 §12 security review); calls producer (P5); PresencePort/Centrifugo
  publish-gap; mention cleartext-routing decision; `/metrics` producer wiring +
  admin guard; on-device benchmarks (P10).
- **Tests:** `tsc`/`nest build` green; **84 notification tests pass** (catalog,
  state machine, backoff, routing, preference matrix, transport-vs-mocked
  integration, outbox reconciliation, default-off inertness, isolation +
  content-less fences). The 6 pre-existing DB-backed suites + the `SKIP LOCKED`/
  coalescing SQL are **CI-gated** (no Postgres in the build worktree).
- **Not wired:** `NotificationsModule` is **not imported by `AppModule`** — no
  provider constructs, no `@Cron` schedule runs, no route mounts.

### PR #51 — PR B — Translation Platform abstraction (real implementation)
Base: `master`. **23 files, +3,051.** Module: `spotme/web/src/lib/translation/`.

- **`TranslationProvider` contract** — checkable interface (`capabilities`/`health`/
  `priceSignal` required; `translate`/`detectLanguage`/`detectScript`/`transliterate`/
  `comprehend`/`adjudicate` optional) with a **forbidden-secret surface** (adapters
  carry no key/endpoint/fetch).
- **Registry + capability matrix** as data; `pairFitness()` (e.g. Sarvam 1.0 into
  Indic, 0 into French).
- **Routing engine** — `score(provider, request)` over fit/quality/latency/cost/
  privacy; **accuracy/latency/cost** weight profiles (each summing to 1.0); the
  five hard gates (supports/pair/circuit/allow-list/privacy) in the design's
  order; returns a `RoutingDecision`.
- **Circuit breaker** — `closed→open→half-open` (defaults 5/60s/30s/1),
  deterministic via injected clock.
- **Confidence/quality** — 5-band taxonomy + rolling EWMA feedback skeleton.
- **Detection pipeline** — English-guard → script-detect → provider-detect,
  reusing the engine's `scriptOk` (imported, not copied).
- **Adapters** — thin adapters for google/azure/sarvam/gemini/openai/anthropic/
  elevenlabs/device/gtx/mymemory that **delegate** to the existing engine (one
  port, inert by default) — registration, not rewrite, zero duplicated logic.
- **Deferred:** server-execution wiring, DB persistence + server cache (owner
  decision), `/metrics` surface, batch/admin endpoints, PII redaction.
- **Tests:** 5 new pure-logic suites (113 assertions) + a `translation-v2-not-shipped`
  fence; **full `npm test` green: 1,049 PASS / 0 FAIL.** The existing engine
  (`api/translate.js`, `src/lib/translate.js`, `src/lib/english.js`) is
  **byte-identical to master** (`git diff --quiet` verified).
- **Benchmark:** routing decision over 11 providers **p50 6.17µs / p95 10.66µs /
  p99 29.13µs**; `score()` p50 0.44µs.

### PR #49 — PR C — Live Voice Translation (scaffolding)
Base: `master`. **16 files, +2,189.** Module: `spotme/web/src/lib/live-voice/`.

- **Streaming interfaces** — `IStreamingStt/Mt/Tts` (partial results, first-token,
  cancel).
- **Session/utterance state machine** — `listening→transcribing→translating→
  (correcting)→synthesizing→playing` + `interrupted`/`dropped`; illegal transitions
  throw.
- **Latency budget** — the `<2.5 s` accounting type (per-stage allocation summing
  to the total, breach detection, injectable clock).
- **Wire frames** — audio-in / partial-caption / translated-audio-out / control
  (audio pinned as base64 text; unknown control signals rejected).
- **Orchestrator skeleton** — STT→MT→(LLM)→TTS→playback, drives the machine,
  accounts the budget, **captions-before-speech**, barge-in, over-budget
  fallback-to-captions — on deterministic **stub adapters**.
- **Voice clone** — documented to reuse the existing consented per-profile
  ElevenLabs `voiceId`; **no new voice, no cloning from call audio.**
- **Deferred:** real streaming providers + quality/failover routing; mic + WebRTC
  + VAD; the frame network transport; jitter-aware playback; consent/quota.
- **Tests:** 5 suites, **68 checks green**, deterministic (incl. an e2e orchestrator
  test); existing suite green.

### PR #50 — PR D — Adaptive Communication Network + Bluetooth (scaffolding)
Base: `master`. **19 files, +2,217.** Module: `spotme/web/src/lib/transport-supervisor/`.

- **`ITransport`** — generalized contract; re-asserts ADR-002's `FORBIDDEN_KEY_SURFACE`
  (INV-1).
- **Capability matrix** — range/needs-internet/offline/bandwidth/latency/battery
  (`bleMesh` = the offline row).
- **Selection engine** — weighted scoring + hard-constraint disqualification +
  **hysteresis** (margin/dwell/stickiness); pure, injected clock; the user never
  picks.
- **`SealedEnvelope` + `envelopeId` dedup** and a **3-tier `OrderingToken`**
  (serverSeq → ratchetPos → senderClock) + reorder buffer — exactly-once/order
  across transports over opaque ciphertext.
- **Bluetooth mesh** — `MeshFrame` + seen-set/TTL/hopcount bounded flooding as
  **pure functions, no native BLE**; relays forward ciphertext bit-identically.
- **Store-and-forward outbox** generalizing `reach.js`.
- **Six encryption invariants (INV-1..6)** as executable predicates.
- **Seal-lift — HARD-DEFERRED:** the boundary **throws**;
  `SEAL_LIFT_STATUS.implemented === false`; a test asserts it stays deferred (gated
  on P1 activation + rollback-after-publication, ADR-008 §12).
- **Deferred:** native BLE radio (P10 native app), real `ITransport` impls,
  `ratchetPos` computation (P1 crypto), all wiring.
- **Tests:** **72/72 new** pure-logic tests + full suite green; `npm run build`
  tree-shakes the supervisor out (proving it's unreferenced).
- **Docs:** ADR-012 + `012a-bluetooth-mesh-threat-model.md`.

---

## Part V — Risks (detailed)

| # | Risk | PR | Likelihood | Impact | Mitigation / status |
|---|---|---|---|---|---|
| R1 | Seal-lift regresses the live crypto path | D | — | High | **Deferred**; throws; gated on P1 activation + full ADR-002 test battery when built |
| R2 | `<2.5 s` live-voice budget missed on real networks | C | Med | High | Unproven until real streaming providers replace stubs; degradation ladder + benchmark gate designed |
| R3 | On-device AI runtime infeasible (WebGPU/WASM) | (P2 AI) | Med | High | Not in this build; spike-first per #47 |
| R4 | iOS blocks native BLE / constrains background | D | High | Med | Mesh scoped to Android/native (P10); web stays relay/WebRTC |
| R5 | Cost blowout (cross-verify/adjudication/TTS fan-out) | B/C | Med | High | Needs the cost-governance layer (F0); worth-it predicates designed |
| R6 | Blind rollout without observability | A/B/C | Med | Med | A wired the first `/metrics`; producer wiring + full OTel deferred |
| R7 | Notification-encryption key vs ADR-008 §12 | A | — | High | Deferred; seam throws, generates no key; needs your security review |
| R8 | `npm audit` highs from new SDK transitive deps | #48 | — | Med | Flagged; not auto-fixed; review before wiring |
| R9 | Per-instance shared state ceiling at enterprise volume | B | Med | Med | Redis/Dragonfly is Priority 3; documented |

---

## Part VI — Assumptions

- The `priority-2/` design docs live on the unmerged `docs/priority-2-planning`
  branch; PR B/C/D branched off `master` (which lacks them), so each agent captured
  its design in an **ADR addendum** referencing those docs — references resolve
  once #47 merges.
- CI's `prisma db push` applies the new notifications tables additively (validated:
  schema change is +85/−0, no table altered).
- The Priority 1 stack merges before the P2 features are wired (the P2 PRs are
  additive and don't depend on P1 internals, but the encrypted/seal-lift halves
  do).

---

## Part VII — Benchmark results (measured, node v22)

- **Push (A):** route ~1.5µs · collapse-id ~1.0µs · envelope.build ~1.5µs ·
  preference.evaluate ~2.1µs · backoff ~0.28µs; full-jitter spread uniform (no
  stampede).
- **Translation (B):** routing decision **p50 6.17µs / p95 10.66µs / p99 29.13µs**;
  `score()` p50 0.44µs — the router is never the latency cost; the vendors are.
- **Live voice (C) / Adaptive (D):** pure-logic paths (no I/O); real provider and
  transport benchmarks are deferred with their implementations. The `<2.5 s` budget
  is instrumented but uses placeholder constants until real providers are measured.

---

## Part VIII — Blockers / owner decisions (the gate)

**Priority 1**
1. Accept the APPROVED verdict; authorize merging the stack (#39→#41→#42→#43→#46).
2. Ratify or amend the **#43 multi-device safety-number construction** (ADR-008 §BLOCKING).

**Priority 2 — the P0 cluster (from #47's decision register), all on the E2EE boundary**
3. **ADR-008 §12 security review** for the **notification-encryption key** (A) and
   the **seal-lift** (D) — both gate their encrypted halves.
4. **Provider plaintext boundary + consent model** (B/C) — translation and live
   voice are plaintext at the provider; ratify the boundary + consent.
5. **Server translation cache** on/off/opt-in (B) — defaults OFF.
6. **Cost-governance policy + numbers** (B/C) — 8 metered vendors, no caps today.
7. **Live-voice scope** — group (>2) calls vs the ADR-011 1:1-MVP non-goal.

**Housekeeping**
8. Review the `npm audit` highs on #48 before the push abstraction is wired.

---

## Part IX — Test & CI status

| PR | Local tests | CI |
|---|---|---|
| #48 | — (deps) | **fully green** (web + backend-Postgres + e2e) |
| #52 (A) | 84 pass; DB suites CI-gated | **running** (backend-Postgres is the real gate) |
| #51 (B) | **1,049 / 0** | web green (expected) |
| #49 (C) | 68 pass | web green (expected) |
| #50 (D) | 72 pass | web green (expected) |
| #45/#46/#47 | — | green |

Every branch also carries a not-shipped / isolation fence proving the new code is
unreachable from the app.

---

## Part X — Recommended implementation order after Priority 1 is approved

0. **Shared foundations** — finish `/metrics` producer wiring (A added the first
   `/metrics`) + a cost-governance layer. Cheapest, widest payoff.
1. **Push** — merge #48 (SDKs) → #52 (platform); wire producers; run the §12
   security review to unlock encrypted-native content.
2. **Translation** — #51; wire execution; settle server-cache + cost-cap decisions.
3. **Live voice** — #49; swap stubs for real streaming providers (flagship, largest
   lift).
4. **Adaptive/Bluetooth** — #50; the **seal-lift after P1 activation**, then real
   transports, then native BLE (P10 native app).

In parallel: #43 multi-device ratification; the AI-platform + cross-device features
from the #47 package.

---

## Part XI — Constraints upheld (compliance record)

- **Priority 1 never modified** — every P2 branch is additive; the only existing-file
  edits were `package.json` test scripts and one purely-additive `schema.prisma`
  (+85/−0). Verified per branch.
- **Nothing merged, nothing activated, nothing wired** — all PRs are drafts; all
  flags default OFF; all new modules are unimported by the app (build tree-shakes
  the client ones out; `NotificationsModule` is not in `AppModule`).
- **No cryptographic behavior changed, no key generated** — the two crypto-adjacent
  pieces (notification-encryption key, seal-lift) are throwing seams gated on your
  §12 review; isolation fences assert zero crypto imports / key primitives.
- **E2EE preserved** — push is content-less by construction; the transport mesh
  carries opaque ciphertext; keys never cross the transport boundary (typed
  invariants).
- **Every PR compiles independently, is tested, has rollback, benchmarks where
  sensible, and ADR/doc updates** — per the engineering standard.
- **No AGPL dependencies** — the two added SDKs are MIT.
- **Review freeze honored** — the only Priority-1-touching work was the
  owner-authorized HIGH-only cleanup (#46).
