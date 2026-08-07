# Full Green Audit — Scope Coverage + Code Health (2026-08-04)

**Baseline:** `master` HEAD `64c9334` (Merge PR #108, docs phase-6 close).
Read-only audit; this report is the only commit. Nothing merged, no code changed.

---

## 0. RED FIRST (nothing hidden)

Two findings, neither a green-suite failure — every test suite is green (§1).

1. **Backend production-dependency vulnerabilities — 20 (5 high, 15 moderate).**
   `npm audit --omit=dev` in `spotme/backend`. High-severity chains:
   `lodash` (code injection via `_.template`), `multer` (DoS via incomplete
   cleanup), `brace-expansion` (DoS), `glob` CLI (command injection),
   `@nestjs/platform-express` (via `@nestjs/core`). These are in the **shipping
   backend**, not the dark platforms. Not blocking dark work; should be
   triaged before any activation deploy. (Legacy `web`: **0** vulnerabilities;
   `web-next`: react-only, clean.)
2. **A Google/Firebase API key is committed** at
   `spotme/web/android/app/google-services.json:18` (`AIzaSy…`). This is a
   **client-embedded Firebase config key** — designed to ship in the Android
   app and restricted by package name + SHA, *not* a private secret — but it is
   a real credential in git. Confirm it is key-restricted in the Firebase
   console; rotate if not. No private keys, no `.env` files, and no other
   secret patterns are tracked.

Everything else below is green or an honest gap, not a regression.

---

## 1. Everything ran — exact counts (master `64c9334`)

| Area | Command | Result |
|---|---|---|
| **Backend full suite** | `spotme/backend` `npm test` (jest) | **52/52 suites, 517 tests PASS**, 22 skipped |
| **Legacy web suite** | `spotme/web` `npm test` (node:test) | **1017/1017 PASS**, 0 fail |
| **Contracts** | `spotme/packages/contracts` `npm test` | boundary fence **6/6**, `tsc` + declaration build clean |
| **web-next** | `spotme/web-next` `npm test` | **105 tests PASS** + 4 skipped, isolation fence **6/6**, `tsc` + vite build clean |
| **Typechecks** | tsc across backend / contracts / web-next | all clean |
| **Production builds** | backend `nest build`, web-next `vite build`, contracts decl build | all clean |

**The 22 backend skips** are the documented env-gated opt-ins, not fences:
four `*-benchmark.e2e-spec.ts` + `s3-integration.spec.ts` (need Redis/Typesense
/S3 that aren't provisioned in CI). **The 4 web-next skips** are likewise
env-gated. No fence suite skips.

### 1a. Every dark-fence suite, enumerated by filename

Run explicitly (`spotme/backend`):

| Fence suite | Result |
|---|---|
| `test/discovery-dark-fences.spec.ts` | PASS |
| `test/exchange-dark-fences.spec.ts` | PASS |
| `test/events-dark-fences.spec.ts` | PASS |
| `test/moments-dark-fences.spec.ts` | PASS |
| `test/assistant-dark-fences.spec.ts` | PASS |
| `test/assistant-citation-observability.spec.ts` | PASS |
| **Total** | **72 tests PASS** |

Plus the web-next isolation fence (`scripts/check-boundaries.mjs`, 6/6) and the
contracts boundary fence (6/6). Every Discovery-programme layer (Discovery,
Exchange, Events, Moments, Assistant) has its own named dark fence, all green.

### 1b. Environment-free startup

Backend built and booted with **only** `DATABASE_URL` + `JWT_ACCESS_SECRET`
(no provider keys, no Redis, no metrics), `NODE_ENV=production`:

| Route | Expected | Got |
|---|---|---|
| `POST /api/v1/assistant/query` | 404 (dark) | **404** ✓ |
| `GET /api/v1/moments/feed` | 404 (dark) | **404** ✓ |
| `GET /api/v1/discovery/people` | 404 (dark) | **404** ✓ |
| `GET /api/v1/exchange/intents` | 404 (dark) | **404** ✓ |
| `GET /api/v1/events/browse` | 404 (dark) | **404** ✓ |
| `POST /api/auth/guest` | live (4xx class) | **400** ✓ |
| `GET /api/users/lookup` | live (4xx class) | **401** ✓ |

All five dark platforms 404 (unimported); live routes answer in their expected
auth/validation class. Nest boots "successfully started". No dark route leaks.

### 1c. Dependency / license posture

- **web-next production deps: `react`, `react-dom` only.** The camera engine
  bundle (MediaPipe/tesseract/jsQR) is devDependencies on the Stage 2A branch,
  never production.
- **contracts: zero runtime dependencies** (fence-asserted).
- Backend 27 prod deps (the vuln surface in §0); legacy web 7 prod deps
  (0 vulns).
- Vendored model assets (Stage 2A branch) are Apache-2.0 across the bundle,
  recorded in the committed `MODEL_ASSET_MANIFEST` with sha256 pins.

---

## 2. Draft-chain health — camera #109–#114

All six branches **merge cleanly against their stated base** (`git merge-tree`,
0 conflicts) and the chain tip's tests pass.

| PR | Branch | Base | Tip | Merge-clean |
|---|---|---|---|---|
| #109 | `feat/camera-stage1-contracts` | `master` | `e22a8a2` | ✓ 0 conflicts |
| #110 | `feat/camera-stage1-engine` | C1 | `fae2c7d` | ✓ 0 conflicts |
| #111 | `feat/camera-stage1-studio-vision-ar` | C2 | `c198a63` | ✓ 0 conflicts |
| #112 | `feat/camera-stage1-moments-wiring` | C3 | `a59d7a6` | ✓ 0 conflicts |
| #113 | `feat/camera-stage1-fences-perf-docs` | C4 | `6171743` | ✓ 0 conflicts |
| #114 | `feat/camera-stage2a-assets-harness` | C5 | `bc03a6c` | ✓ 0 conflicts |

**Chain tip (Stage 2A) tests: 190 PASS + 4 skipped** (isolation fence 6/6,
camera source fences 8/8, camera-lab-absent fence 4/4, src + lab typecheck,
flag-false build clean). The chain is linear, conflict-free, and self-consistent.

---

## 3. Scope coverage matrix

State legend: **Live** = on master AND imported by `AppModule` / mounted in a
shipping surface · **Merged-dark** = on master but unimported/unmounted/flag-off
· **Draft** = only on a feature branch · **NOT BUILT** = no code anywhere.

Ground truth for "wired": `backend/src/app.module.ts` imports Prisma, Auth,
Users, Chat, ChatRequests, Moderation, Admin, Audit, Groups, Stories, Rooms,
Realtime, Storage, Push — and imports **none** of Discovery/Events/Exchange/
Moments/Media/Assistant/Queue/Observability. `web-next/src/App.tsx` mounts
**Discovery only**, and web-next is not deployed.

| Capability | Pillar | State | Evidence |
|---|---|---|---|
| 1-1 messaging, knocks, receipts, replay | Communication | **Live** | `web/src/lib/rooms.js`; `backend/src/chat/` |
| Groups (roles/bans/grants) | Communication | **Live** | `backend/src/groups/` (in AppModule) |
| Media / attachments | Communication | **Live** | `web/src/lib/blobstore.js`; `backend/src/storage/` |
| Voice notes | Communication | **Live** | `web/src/lib/voice.js` |
| View-once / disappearing | Communication | **Live** | Prisma `ViewOnce`; `msgTtl` |
| Calls (P2P A/V) | Communication | **Live** | `web/src/lib/rooms.js` (WebRTC/Trystero) |
| Push notifications | Communication | **Live** | `backend/src/push/` (in AppModule) |
| Text translation (multi-provider) | Communication | **Live** | `web/api/translate.js` |
| **Voice-note translation + voice CLONE** | Communication | **Live** | `web/src/lib/voice.js` (`cloneVoice`/`ttsClone`, ElevenLabs); `web/src/views/profile.js` enroll, `chat.js:4112` consume |
| Translation provider-abstraction platform | Communication | **Draft** | PR #51 `feat/translation-abstraction` |
| **Live voice translation** (call captions/TTS) | Communication | **Draft (stranded)** | `feat/live-voice-scaffold` (#49), `feat/live-voice-platform` (#54) — §3a |
| Safety numbers + identity pinning | Communication | **Live** | `web/src/lib/crypto/{safety-number,identity-pin}.js` |
| Send enforcement (A5) | Communication | **Merged-dark** | `identity-enforcement.js` (`enforcing=false`) |
| Signing keys / X3DH / Double Ratchet | Communication | **Merged-dark** | PRs #39/#41/#42 (flags false / `spotme.e2e3`) |
| Multi-device | Communication | **Deferred (draft)** | `feat/multi-device` (#43, ADR-008 §BLOCKING) |
| **Adaptive transport / Bluetooth mesh** | Communication | **Draft** (UI placeholder Live) | §3b |
| Centrifugo transport | Communication | **Merged-dark / Deferred** | `realtime.controller.ts` 503 unless configured |
| Smart Nearby Discovery Map (platform) | Discovery | **Merged-dark** | `backend/src/discovery/` (Phase 2, not imported) |
| Nearby-people lobby (shipping) | Discovery | **Live** | `web/src/views/discovery.js` (ADR-024, PR #66) |
| SpotMe Exchange | Discovery | **Merged-dark** | `backend/src/exchange/` (Phase 3, not imported) |
| Live Nearby Events | Discovery | **Merged-dark** | `backend/src/events/` (Phase 4, not imported) |
| Nearby Moments | Discovery | **Merged-dark** | `backend/src/moments/` (Phase 5, not imported) |
| AI Interactive Map assistant | Discovery | **Merged-dark** | `backend/src/assistant/` (Phase 6, no LLM/SDK, not imported) |
| Review summaries / route advice | Discovery | **Merged-dark** | `assistant.review.ts`, `assistant.route.ts` (dark) |
| Voice map search | Discovery | **NOT BUILT** | disabled `VoicePort` seam only |
| AI recommendation feed | Discovery | **NOT BUILT** | no code |
| Personalization / preference profile | Discovery | **NOT BUILT** | no code |
| Photos / basic edit | Creation | **Live** | `web/src/lib/photos.js`, `photoedit.js` |
| Camera engine / AI vision / AR-beauty / studio (CAM-1..4) | Creation | **Draft** | PRs #56/#58/#59/#55 → migrated to **Stage 1/2A** (#109–#114) |
| Stories (24h messaging) | Creation/Comm | **Live** | `backend/src/stories/`; `web/src/views/stories.js` |
| Short-form Stories/Reels creation | Creation | **NOT BUILT** | no module |
| **SOS / emergency / panic** | Safety | **NOT BUILT** | §3c |
| Moderation / block / report | Safety | **Live (partial)** | `backend/src/moderation/` (in AppModule) + dark moments machine |
| Communities / Channels / Announcements | Communication | **NOT BUILT** | only Groups exist |
| Monetization suite (plans, sponsored, reservations, business pages, analytics, enterprise) | Business | **NOT BUILT** | only privacy *negations* ("no payment field") |
| Autonomous 24/7 agent org | Ops | **NOT BUILT** | no code |
| Global readiness (RTL/i18n/localized formats) | Platform | **NOT BUILT** | no i18n/RTL system |

### 3a. Live Voice translation — migration cost (assessed like camera got)

Stranded on `feat/live-voice-scaffold` (#49, ~2,189 lines vanilla JS:
streaming interfaces, session state machine listening→…→playing, <2.5 s
latency-budget accounting, frame schemas, orchestrator with barge-in +
caption fallback, stub adapters, 5 test suites, flag `LIVE_VOICE_ENABLED`
false, not imported) and `feat/live-voice-platform` (#54, +9 lines + docs;
its diff vs current master is **~471 files / −44k lines** — cut *before* the
platform migration, badly diverged, **cannot be rebased**).

**Effort:** **MEDIUM** to re-land dark as a camera-Stage-1-style cut (contracts
in `packages/contracts` + framework-free state machine behind ports — the
logic ports cleanly to TS). **LARGE** for anything runnable: it needs pieces
that don't exist today — a **backend NestJS module** (the whole thing is
client-side now) to own the plaintext-provider/consent boundary, **real
streaming STT/MT/TTS adapters** (only stubs exist), a **web-next mic/caption
surface**, and reconciliation with the already-live voice-note clone path so
the two don't duplicate ElevenLabs handling. Re-cut file-by-file, not rebased.

### 3b. Bluetooth / offline mesh — placeholder, real mesh is draft

The on-master `web/src/views/bluetooth.js` is a **shipping UI over the internet
discovery lobby** — its own header says *"this scan uses the internet; true
offline Bluetooth chat arrives with the native app."* Web-Bluetooth
`requestDevice` is informational only (no chat); `'BLUETOOTH'` in
`chat-request.dto.ts` is a source-label enum, not a transport. `transport/
select.js` is a **manual** `localStorage` flag — no automatic switching. The
genuine BLE-central mesh + adaptive supervisor (EWMA/battery/congestion,
durable outbox, ADR-012) exists **only** on `feat/adaptive-transport-scaffold`
(#50), not on master. **Verdict: placeholder confirmed; real mesh is a draft.**

### 3c. SOS / emergency — NOT BUILT (confirmed)

No panic button, duress alert, live-location-share, or emergency-contact code
in backend, web, web-next, or packages. The only string hits are incidental:
`exif-strip.ts` "SOS" = the JPEG Start-Of-Scan marker; `assistant.sensitive.ts`
carries a *"contact your local emergency services"* refusal disclaimer (dark
assistant copy), not a feature. **NOT BUILT.**

### 3d. NOT-BUILT list (scope-doc items with zero code)

Communities/Channels/Announcements · SOS/emergency · AI recommendation feed ·
personalization/preference profile · voice map search (disabled seam only) ·
the full monetization/revenue suite · autonomous agent organization ·
short-form Stories/Reels creation · global readiness (RTL/i18n).

> **Honesty note:** most surfaces absent from the *running product* are
> **Merged-dark, not NOT-BUILT** — the entire Discovery platform (Map,
> Exchange, Events, Moments, Assistant) is real, tested code on master,
> deliberately unimported. Camera is Draft (migrated to Stage 1/2A), not
> absent. Only the §3d items have no code anywhere.

---

## 4. Drift check — ledger vs reality (Governance G9)

**Verdict: the status ledger is HONEST.** Every "Implemented (Merged)" /
"Merged — DARK" row resolves to a real ancestor commit of `origin/master` with
a real evidence path, and every "DARK" assertion (module-not-imported /
surface-not-mounted / flag-off) is literally true in the code.

- **Moments #97–#101** (`bd94cf2`…`ba50e38`): all five merge SHAs are ancestors
  of master; `MomentsModule`/`MediaModule` absent from `app.module.ts`. ✓
- **Assistant #103–#107** (`0470217`…`629a4f1`): all five ancestors;
  `AssistantModule` absent; `App.tsx` mounts only Discovery. ✓
- Every other cited merge SHA (Phases 1–4, crypto, hotfix) verified an ancestor.
  No wrong/missing SHA. No doc claims a capability *live/done* while code is
  absent — the ledger repeatedly states dark code is "**not** in the product."
- **ADR index complete on master:** 001–008, 014–028 all present and listed;
  no unlisted ADR file, no dangling reference. ADR-028 status "Accepted" agrees
  across file/index/ledger.

**One currency gap (D1, not dishonesty):** `03-IMPLEMENTATION-STATUS.md:49`
still describes camera as "Draft PR #56/#58/#59/#55 … frozen." The Stage 1/2A
branches (#109–#114) and their status rows + ADR-029 exist **only on those
draft branches**, not on master — so master's ledger under-reports what the
repo now carries. The doc shows *less* than reality (a G9 currency lag), never
*more*. Fix: refresh row 49 when the camera chain lands, or note the Stage 1/2A
line now. (ADR-029 is correctly absent from master — camera is unmerged.)

---

## 5. Verdict — honest scorecard (no inflation)

| Area | Suites/fences green? | Score | Why |
|---|---|---|---|
| Contracts | 6/6 fence, build ✓ | **10/10** | zero deps, compile-time fences non-vacuous, nothing to fault |
| Legacy web (shipping) | 1017/1017, 0 vulns | **9/10** | comprehensive, clean; −1 only because it's the maturity bar others are measured against, not perfection |
| web-next (dark surfaces) | 105 + fence 6/6, react-only | **9/10** | disciplined isolation, privacy batteries; −1 nothing deployed/hardware-proven |
| Backend dark platforms | 517 + 72 fence tests green | **8/10** | five programme fences all green, env-free-dark proven; **−2 for 20 prod-dep vulns (5 high)** in the shipping backend |
| Camera draft chain (#109–#114) | clean merges, 190 tests | **8/10** | linear conflict-free stack, real vendored+digest-verified assets, lab-absent fence; −2 honestly unproven on hardware (that's Stage 2B, by design) |
| Docs / ledger honesty | — | **9/10** | ledger honest on every merged/dark row, ADR index complete; −1 for the D1 camera currency lag |
| Secret / credential hygiene | — | **8/10** | no private keys, no tracked `.env`; −2 for the committed Firebase client key (restricted-by-design, but present) |

**Overall code health: 8.5/10.** Every test suite and every dark fence is
green; the dark-platform discipline (unimported modules, env-free 404s,
privacy batteries, non-vacuous fences) is genuinely strong and consistently
applied across six programme phases. The two real deductions are mundane, not
architectural: **backend production-dependency vulnerabilities** (fixable with
a triaged `npm audit` pass) and a **committed Firebase client key** (verify
restriction / rotate).

### Coverage — two honest numbers, because they differ a lot

- **Built coverage** (Live + Merged-dark + Draft, i.e. code exists): **~70%**
  of named scope capabilities. The Discovery programme (5 layers) and camera
  are all built; only the §3d set has zero code.
- **Shipping coverage** (actually Live in the running product): **~35%** —
  Communication is largely live, plus the nearby-people lobby; **all of
  Discovery is dark, all of camera is draft**, and monetization/SOS/communities
  are absent. The gap between 70% built and 35% shipping is the deliberate
  dark-platform strategy: a large, tested, unactivated substrate awaiting
  owner-gated activation.

### Gap list, ranked by effort to close

1. **Backend dep vulns** — SMALL (triaged `npm audit` upgrade pass; watch the
   `_.template`/multer/lodash chains). *Do before any activation deploy.*
2. **Firebase key hygiene** — SMALL (confirm key restriction; rotate if open).
3. **Camera ledger currency (D1)** — SMALL (one row + land the chain).
4. **SOS / emergency** — MEDIUM–LARGE and **safety-critical**; nothing exists.
   Highest-value NOT-BUILT item given the product's safety framing.
5. **Live voice translation** — MEDIUM (dark re-cut) / LARGE (runnable): needs
   a new backend module + real STT/MT/TTS adapters + UI (§3a).
6. **Communities/Channels, recommendation feed, personalization, short-form
   Reels, global i18n/RTL** — each MEDIUM–LARGE greenfield.
7. **Monetization suite** — LARGE and owner-policy-gated (A3/payments), by
   design not started.
8. **Activation of the dark Discovery platform** — the largest *value* lever;
   engineering-ready, gated on owner activation + provider licensing (tracked
   in the phase activation checklists), not on new build.

---

*Read-only audit. Postgres (pgtest :5433) was started to run the backend
suite; no data written beyond test fixtures. No production surface touched.*
