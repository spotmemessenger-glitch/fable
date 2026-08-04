# 03 — Implementation Status (Six-State Model, G2)

**Every subsystem is in exactly one of six states, with evidence.** This is the
authoritative "what is real" map. Evidence is a merged commit / master file
path or an open PR + branch — **verified against the repository, never against
another document**. Full audit evidence:
[SPOTME-REPO-AUDIT-2026-08-03](../SPOTME-REPO-AUDIT-2026-08-03.md).

> Verified 2026-08-03 against `master` `9147485`
> (`Merge pull request #78` — G8 crypto train AND Platform Phase 1 (#72–#78)
> landed DARK) and the live open-PR list.
> *Implemented (Merged)* is on master and runs. *Implemented (Draft PR)* is
> built but lives only on a branch behind an open, unmerged PR — usually dark —
> and is **not** in the product.

## The six states

| State | Meaning |
|---|---|
| **Implemented (Merged)** | On `origin/master`. Runs (or ships dark on master). |
| **Implemented (Draft PR)** | Built, on a branch, open PR, not merged. Not in the product. |
| **In Progress** | Being worked; no complete/open PR yet. |
| **Planned** | Approved direction but not built. |
| **Deferred** | Deliberately not-now; blocked on a gate or decision. |
| **Retired** | Superseded/withdrawn; kept only as history. |

## Subsystem status

| Subsystem | Status | Evidence (repo-verified) |
|---|---|---|
| Messaging (1-1 chat, knocks, receipts, replay) | Implemented (Merged) | `spotme/web/src/lib/rooms.js`, `reach.js`; `spotme/backend/src/chat/` (gateway + controller) |
| Groups (roles, bans, grants) | Implemented (Merged) | `spotme/backend/src/groups/` (16 routes); `spotme/web/src/lib/groups-api.js`, `group-perms.js` |
| Media (attachments; IndexedDB → bucket) | Implemented (Merged) | PRs #18/#19; `web/src/lib/blobstore.js`, `media-transfer.js`; `backend/src/storage/media.controller.ts` |
| Voice notes | Implemented (Merged) | `web/src/views/chat.js:3904` (MediaRecorder), `web/src/lib/voice.js` |
| View-once media | Implemented (Merged) | Prisma `ViewOnce` model; `web/test/viewonce.test.js`; race fix in PR #20 |
| Disappearing messages | Implemented (Merged) | `msgTtl` in `web/src/lib/db.js` / `rooms.js` |
| Calls (P2P voice/video) | Implemented (Merged) | `web/src/lib/rooms.js:589,754` (`addStream` over Trystero/WebRTC); call UI in `views/chat.js`; STUN/TURN `web/src/net.js:54` |
| Push notifications | Implemented (Merged) | `web/src/lib/push.js`; `backend/src/push/push.service.ts` (web-push + FCM; APNs dependency). Vendor keys pending in Railway per `web/DEPLOY.md` |
| Translation (live, multi-provider) | Implemented (Merged) | `web/api/translate.js` (Google/Azure/Sarvam endpoints), `web/src/lib/translate.js`. Provider-abstraction **platform**: Implemented (Draft PR **#51**, `feat/translation-abstraction`) |
| Safety numbers + identity pinning | Implemented (Merged) | PRs #12/#14/#24–#28; `web/src/lib/crypto/{safety-number,identity-pin,identity-pin-store}.js`; QR via `qr-scan.js` |
| Send enforcement (A5) | Implemented (Merged — flag default OFF) | PR #31; `web/src/lib/crypto/identity-enforcement.js:77` (`enforcing = false`) |
| **Discovery coarse-location hotfix** | **Implemented (Merged)** | **PR #66**, merge `069905e`; `web/src/lib/discovery.js:49`; guard `web/test/discovery-coarse-broadcast.test.js`; [ADR-024](../adr/024-discovery-coarse-broadcast-hotfix.md) |
| Signing-key foundation + publication (executable rollback) | Implemented (Merged — DARK) | **PR #39**, merge `67bc221`; `web/src/lib/crypto/{signing-key-store,signing-key-publication}.js`, `backend/src/auth/signing-keys.*`. **merged DARK — activation pending a separate owner-authorised change** (`SIGNING_PUBLICATION_ENABLED = false`) |
| X3DH + prekeys | Implemented (Merged — DARK) | **PR #41**, merge `f9fe579`; `web/src/lib/crypto/x3dh.js`, `backend/src/auth/prekeys.*`, migration `20260801180000_x3dh_prekeys`. **merged DARK — activation pending a separate owner-authorised change** (behind `spotme.e2e3`) |
| Double Ratchet | Implemented (Merged — DARK) | **PR #42**, merge `288b8ca`; `web/src/lib/crypto/ratchet.js` (004b-oracle conformant, byte-for-byte). **merged DARK — activation pending a separate owner-authorised change** (behind `spotme.e2e3`) |
| Multi-device | Deferred | **#43 SKIPPED** pending the ADR-008 §BLOCKING multi-device safety-number decision (owner **NOT DECIDED**, 2026-08-03); branch `feat/multi-device` not merged |
| Camera suite CAM-1…4 | Implemented (Draft PR **#56/#58/#59/#55**, `feat/camera-engine` + stacked) | branches **frozen** by owner directive; dark flags |
| Discovery V2 map | Implemented (Draft PR **#60**, `feat/discovery-v2-map-foundation`) | dark, fence-tested; **rebase pending** after #66 (ADR-024) |
| Live Nearby Events | Implemented (Draft PR **#61**, `feat/live-nearby-events`, stacked on #60) | dark, fence-tested |
| Nearby Moments | Planned | no module, contract, or ADR; data/privacy-model ADR required before code |
| SpotMe Exchange | Planned | PRD draft in PR **#64** (`handbook/product/exchange/`), pending A5 ratification; **no code** |
| Live voice translation | Implemented (Draft PR **#49** scaffold + **#54** pipeline, `feat/live-voice-*`) | scaffolding; not on master |
| Adaptive transport + Bluetooth mesh | Implemented (Draft PR **#50**, `feat/adaptive-transport-scaffold`) | scaffolding; not on master |
| Centrifugo transport | Deferred | seam on master (`web/src/lib/transport/centrifugo-adapter.js`; backend `realtime.controller.ts:71` returns 503 unless configured); **no client dependency in any package.json**; `feature/centrifugo-transport` abandoned (49 behind). ADR-002 keeps the interface |
| Media platform (media-core contracts) | In Progress | branch `feat/media-core-contracts` pushed with **no open PR** (audit anomaly A1) — see `spotme/docs/handbook/DECISIONS.md` item 7 (owner decision sheet, on the PR #62 branch) |
| **Platform Phase 1A** — dev/CI compose (PG+PostGIS, Valkey; opt-in `search-benchmark` profile) + additive PostGIS migration | Implemented (Merged — DARK) | **PR #72**, merge `7df509a`; `spotme/docker-compose.dev.yml`, migration `20260803120000_enable_postgis` |
| **Platform Phase 1B** — `@spotme/contracts` shared TS domain types (boundary-fenced, declaration output) | Implemented (Merged — DARK) | **PR #73**, merge `aa97fce`; `spotme/packages/contracts` |
| **Platform Phase 1C** — BullMQ `{maintenance}` queue on ioredis (disabled without `REDIS_URL`; sanitized DLQ; manual smoke only) | Implemented (Merged — DARK) | **PR #74**, merge `7a8c124`; `backend/src/queue/` — `QueueModule` NOT imported by `AppModule` |
| **Platform Phase 1D** — search benchmark harness (reproducible manifest; recorded run) | Implemented (Merged — DARK) | **PR #75**, merge `69cbedd`; `spotme/packages/search-bench` |
| **Platform Phase 1E** — AI Gateway ports + deterministic baselines (fenced); ADR-026/027 | Implemented (Merged — DARK) | **PR #76**, merge `983712f`; `web/src/lib/ai/` — fence `ai-gateway-not-shipped` |
| **Platform Phase 1F** — `web-next` React strangler beachhead (inert; outside the Vercel root; isolation-fenced) | Implemented (Merged — DARK) | **PR #77**, merge `f59d0ec`; `spotme/web-next` |
| **Platform Phase 1G** — storage characterization tests + observability baseline (all legs no-op without env; redaction-fenced) | Implemented (Merged — DARK) | **PR #78**, merge `9147485`; `backend/src/observability/`, `test/storage-characterization.spec.ts` — `ObservabilityModule` NOT imported |
| Engineering Handbook (this document set) | Implemented (Draft PR **#62**, stack #63/#64/#65) | `docs/engineering-handbook-v1` → `docs/discovery-platform-architecture` |
| **Platform Phase 2A** — Discovery contracts v1 (`@spotme/contracts` discovery types, branded `CoarsePublicLocation`, compile-time negative tests) + programme doc + D9/D10 recorded + DPAS ch. 14 threat model | Implemented (Draft PR — DARK) | **PR #80**; `packages/contracts/src/discovery.ts`, `docs/architecture/discovery-platform/14-PRIVACY-ABUSE-THREAT-MODEL.md` |
| **Platform Phase 2B** — dark `DiscoveryModule` (policy/errors/ranking/service/controller), PostGIS models + hand-written migration, people query engine on real PostGIS | Implemented (Draft PR — DARK) | **PR #81**; `backend/src/discovery/`, migration `20260803190000_discovery_postgis` — `DiscoveryModule` NOT imported by `AppModule` |
| **Platform Phase 2C** — SearchPort + zero-dependency Typesense adapter (timeout/breaker/ceiling/exact-handle pin; live typo/prefix verification) + place/directions ports with deterministic adapters | Implemented (Draft PR — DARK) | **PR #82**; `backend/src/discovery/search/`, `backend/src/discovery/places/` — unconfigured by default, no credentials exist |
| **Platform Phase 2D** — deterministic intent router, closed-registry transparent ranking engine (safety hard gate), realtime contract (2 channel families, 60 s claims ≤4 channels, publish-time content guard, Disabled default) | Implemented (Draft PR — DARK) | **PR #83**; `backend/src/discovery/discovery.intent.ts`, `discovery.ranking.engine.ts`, `realtime/` |
| **Platform Phase 2E** — web-next Discovery UI (pure prop-driven components, SVG map, 12-state banner) + framework-free application layer behind 5 ports, on-device coarsening boundary, privacy mutation battery | Implemented (Draft PR — DARK) | **PR #84**; `web-next/src/discovery/` — NOT deployed, fixture ports only |
| **Platform Phase 2F** — dark integration fences (13 assertions incl. build-artifact scan), performance benchmarks (1M profiles achieved, PostGIS + Typesense), dark instrumentation (closed metric registry, redacted correlation logging), DPAS ch. 15/16/17 + doc set + 12-lens adversarial review repairs | Implemented (Draft PR — DARK) | **PR #85**; `backend/test/discovery-dark-fences.spec.ts`, `backend/test/discovery-benchmark.e2e-spec.ts`, `backend/src/discovery/discovery.observability.ts`, `docs/architecture/discovery-platform/17-ADVERSARIAL-REVIEW-PHASE-2.md` |
| **Platform Phase 3A** — Exchange versioned contracts (branded coarse location, 8-state lifecycle, closed match-signal registry, safety gate as a type property, opaque cursor, no payment/age/gender shapes) + policy + threat model (21 threats) | Implemented (Draft PR — DARK) | branch `feat/platform-phase-3a-exchange-contracts-policy`; `packages/contracts/src/exchange.ts`, `packages/contracts/test/exchange-negative.test.ts`, `docs/architecture/exchange-platform/01-CONTRACTS-POLICY-THREAT-MODEL.md` |

## Platform Phase 1 — landed decisions (2026-08-03, delegated approval)

- **ADR-026 Accepted** (realtime split-plane) and **ADR-027 Accepted**
  (mobile-native boundary) — statuses flipped in the ADRs and index (PR #76).
- **Search: Typesense selected** as the Phase 2 target from the committed
  benchmark (~12× faster warm p50/p95; Meilisearch documented fallback).
  **Not yet wired. Not yet active.** Mandatory production-hardware re-benchmark
  before wiring (tech-stack §14; `handbook/DECISIONS.md`).
- Everything in Phase 1 landed **DARK**: both crypto flags false throughout,
  no feature activation, no flag changes, no user-visible behaviour change.

## Retired

| Item | Replaced by |
|---|---|
| `.handoff/NEXT-SESSION.md` + `SESSION-*.md` pickup mechanism | This handbook + [00-BOOTSTRAP](00-BOOTSTRAP.md); RETIRED banner in the file |
| A1–A7 identity labels (where they conflict with Roadmap V2) | Roadmap V2 numbering + `14-ROADMAP-V1-TO-V2-MAPPING.md` |
| V1 migration plan (`MIGRATION-PLAN-V1.md`) | Roadmap V2 (historical; stricter V1 gates still bind per V2 Appendix B) |
| 2026-07-25 precise-broadcast decision | [ADR-024](../adr/024-discovery-coarse-broadcast-hotfix.md) (PR #66) |

**Needs owner clarification (not Retired):** the Vercel `/api/*` functions were
previously listed Retired per `09-TECH-STACK.md` ("vestigial"), but the
2026-08-03 audit found live vendor endpoints in them and `web/DEPLOY.md` notes
the same files are staged into the Railway image — treat as live until the
owner rules.

## Product framing

The three flagship pillars, the product loop, and the fixed Discovery order
live in the [product authority](product/README.md) and
[ADR-021](../adr/021-spotme-unified-product-ecosystem.md) /
[ADR-022](../adr/022-discovery-execution-sequence.md).
This page stays authoritative for *what is actually built*.
