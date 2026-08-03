# 03 — Implementation Status (Six-State Model, G2)

**Every feature is in exactly one of six states, with evidence.** This is the
authoritative "what is real" map. Evidence is a merged commit on `origin/master`
or an open PR/branch — verify it (see [00-BOOTSTRAP](00-BOOTSTRAP.md)) rather
than trusting the label.

> Verified 2026-08-03 against `master` `31e1894` and the open PR list.
> **The critical distinction:** *Implemented (Merged)* is on master and runs.
> *Implemented (Draft PR)* is built but lives only on a branch behind an open,
> unmerged PR — usually **dark** (flag-gated, fenced, tree-shaken) — and is
> **not** in the product.

> **Product framing** for these surfaces (the three flagship pillars, the loop,
> the fixed Discovery execution order, and the Creation-pillar status vocabulary
> Built / Draft PRs / Built-off / Not active) is in the
> [product authority](product/README.md) and
> [ADR-021](../adr/021-spotme-unified-product-ecosystem.md). This page remains
> authoritative for *what is actually built*.

## The six states

| State | Meaning |
|---|---|
| **Implemented (Merged)** | On `origin/master`. Runs (or ships dark on master). |
| **Implemented (Draft PR)** | Built, on a branch, open PR, not merged. Not in the product. |
| **In Progress** | Being worked; no complete/open PR yet. |
| **Planned** | Approved direction (Roadmap V2) but not built. No module/ADR. |
| **Deferred** | Deliberately not-now; blocked on a gate or decision. |
| **Retired** | Superseded/withdrawn; kept only as history. |

---

## Implemented (Merged) — on `master`

### Messaging core & identity
| Feature | Evidence |
|---|---|
| Proximity messenger: Meet / Nearby / Bluetooth chat, no-accept-gate knock | PRD §1 (Shipped); `web/src/views/*`, `reach.js`, `api/knock.js` |
| Language: split-bubble translation + 10-language transliteration | `web/src/lib/translate.js`, `core/translit.js` |
| Groups + permissions | `backend/src/groups`, `web/src/lib/groups-api.js` |
| Safety numbers + verify screen | #12 `33b1e25`, #14 `1776051` |
| Identity trust state machine (A1) | #24 `08e3c0a` |
| Changed peer key **proposed, never adopted** (A2+A3) | #25 `a7235d1` |
| Scanned safety number **bound before believed** (A4) | #26 `0fa467b` |
| QR scanner wired into verify | #28 `8fc603b` |
| Server availability axis only (A6a) | #27 `6f0fd15` |
| Signing identity + proof-of-possession bindings (A7) | #29 `a934e11` |
| Send enforcement — computed always, **flag OFF** (A5) | #31 `43fce9e`, matrix #30 `d29c1b6` |
| Signing-key **storage** (ADR-008 Phase 2, first half) — dark | #36 `fb02b99` |

### Platform & infrastructure
| Feature | Evidence |
|---|---|
| Transport authorisation seam (Phase A) | #17 `90cf503` |
| Media in IndexedDB, 2.5 MB cap lifted (Phase B) | #18 `347f1e2` |
| Client→bucket storage seam (Phase C) | #19 `b0423b2` |
| IndexedDB / media baseline | #22 |
| S3 integration test (MinIO in CI) | #23 `8f3cebc` |
| CI that runs real assertions | #20 `29ee50d` |
| Web lint gate (ESLint) | #21 `dd03671` |
| Playwright e2e foundation | #32 `ad36a37` |

### Documents (merged)
| Doc | Evidence |
|---|---|
| Master Roadmap V2 (controlling) + V1→V2 mapping | #35 `7f78a11` |
| Owner amendment — execution order + AI-provider principle | #37 `31e1894` |
| ADR-004 forward secrecy; PR2 migration audit; Priority 0 audit | #15 `842287f`, #16 `eca151e`, #13 `6eda88d` |

---

## Implemented (Draft PR) — built, dark, NOT on master

| Feature | PR | Head | Base | Dark/fenced |
|---|---|---|---|---|
| **Discovery V2 map foundation** + precise-GPS privacy fix | **#60** | `3e2c709` | master | Yes — `discovery-v2-not-shipped` fence |
| **Live Nearby Events** foundation | **#61** | `a6baf318` | #60 (stacked) | Yes — `live-events-not-shipped` fence |
| Camera Engine (CAM-1) | #56 | `c7c8020` | master | Behind disabled flags |
| AI Vision (CAM-2) | #58 | `44da9ff` | camera-engine | Behind disabled flags |
| AR & Beauty (CAM-3) | #59 | `97aebee` | camera-engine | Behind disabled flags |
| Creative Studio (CAM-4) | #55 | `d7ef3fa` | master | Dark cloud-AI legs |
| Translation provider abstraction | #51 | `839dd1e` | master | Routing/scoring/failover, dark |
| Push platform foundation | #52 | `642ed18` | push-notification-sdks | Additive & inert |
| Push notification SDKs (packages only) | #48 | `62adff1` | master | No wiring |
| Live voice — streaming scaffolding + interfaces | #49 | `3e6d6b7` | master | Scaffolding |
| Live voice translation platform (streaming pipeline) | #54 | `4c60717` | live-voice-scaffold | Scaffolding |
| Adaptive transport supervisor + Bluetooth mesh | #50 | `a9c7b5f` | master | Scaffolding |
| X3DH key agreement + prekeys (e2e_v3 Phase 3) | #41 | `e8376bb` | signing-key-publication | **Gated — see Deferred** |
| Double Ratchet (e2e_v3 Phase 4) | #42 | `c48369a` | x3dh-prekeys | **Gated — see Deferred** |
| Multi-device safety numbers + ADR-013 (Phase 5) | #43 | `fc26de4` | double-ratchet | Needs owner ratification |

Planning/documentation PRs also open: #57 (handoff rewrite), #47 (Priority 2
planning), #45/#44 (Priority 1 review/completion), #40 (platform ADRs 009–012),
#38 (owner amendment 2), #34 (product audit), #53 (research reports).

---

## In Progress

| Item | Note |
|---|---|
| **Engineering Handbook v1.0** | This documentation PR. Becomes *Implemented (Draft PR)* on creation, *Merged* on owner approval. |
| **Media-core contracts** | Branch `feat/media-core-contracts` is pushed, but **no open PR was found** (verified 2026-08-03). Recorded as an anomaly in [10-CONTRADICTIONS-AND-GAPS](10-CONTRADICTIONS-AND-GAPS.md). |

---

## Deferred — deliberately not-now, gated

| Item | Gate |
|---|---|
| **Signing-key generation / publication** | **ADR-008 §12 hard stop:** no key generation, prekeys, X3DH, ratchet, or multi-device until rollback-after-publication is executable or separately authorised. PR **#39** (publication + rollback) and the crypto stack #41/#42/#43 sit behind this. |
| Key-authentication (ADR-001) | Explicitly deferred at the safety-numbers stage (#12 title). Superseded by the identity-trust sequence + ADR-004/006. |
| iOS client | No Xcode project; not scheduled. |

---

## Planned — approved direction, not built (no module/ADR yet)

From `spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md §5`. **Do not implement
without an approving ADR.**

- **Social platform:** Nearby Moments, Stories, Reels, Communities & Channels.
- Voice & video platform beyond current scaffolding (Priority 5).
- AI Communication platform — **interface-only constraint stands**; no LLM,
  no assistant (Priority 6).
- Observability/SRE (P9), Mobile/multi-platform (P10), Business/enterprise/
  moderation (P11), Developer platform (P12), Final production validation (P13).

**Out of scope for current foundations (no code, do not build):** ticketing/
reservations, business promotions, heat maps, personalization, PostGIS/H3,
Redis/DragonflyDB, realtime-gateway redesign, Camera↔other-surface integration.

---

## Retired

| Item | Replaced by |
|---|---|
| `.handoff/NEXT-SESSION.md` + `.handoff/SESSION-*.md` pickup mechanism | This handbook + [00-BOOTSTRAP](00-BOOTSTRAP.md). The file carries a RETIRED banner. |
| A1–A7 identity labels (where they conflict with Roadmap V2) | Roadmap V2 numbering + `14-ROADMAP-V1-TO-V2-MAPPING.md` (per `CLAUDE.md`). |
| V1 migration plan (`MIGRATION-PLAN-V1.md`) | Roadmap V2 (historical; V2 Appendix B keeps stricter V1 gates). |
| Vercel `/api/*` serverless functions | Railway-served API (vestigial; keys removed 2026-07-31 — `09-TECH-STACK.md §1`). |
