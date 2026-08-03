# 03 — Implementation Status (Six-State Model, G2)

**Every subsystem is in exactly one of six states, with evidence.** This is the
authoritative "what is real" map. Evidence is a merged commit / master file
path or an open PR + branch — **verified against the repository, never against
another document**. Full audit evidence:
[SPOTME-REPO-AUDIT-2026-08-03](../SPOTME-REPO-AUDIT-2026-08-03.md).

> Verified 2026-08-03 against `master` `069905e`
> (`Merge pull request #66`) and the live open-PR list.
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
| X3DH + prekeys | Implemented (Draft PR **#41**, `feat/x3dh-prekeys`) | gated by ADR-008 §12 |
| Double Ratchet | Implemented (Draft PR **#42**, `feat/double-ratchet`) | gated by ADR-008 §12 |
| Multi-device | Implemented (Draft PR **#43**, `feat/multi-device`) | gated by ADR-008 §12 + safety-number question (ADR-008 §BLOCKING) |
| Camera suite CAM-1…4 | Implemented (Draft PR **#56/#58/#59/#55**, `feat/camera-engine` + stacked) | branches **frozen** by owner directive; dark flags |
| Discovery V2 map | Implemented (Draft PR **#60**, `feat/discovery-v2-map-foundation`) | dark, fence-tested; **rebase pending** after #66 (ADR-024) |
| Live Nearby Events | Implemented (Draft PR **#61**, `feat/live-nearby-events`, stacked on #60) | dark, fence-tested |
| Nearby Moments | Planned | no module, contract, or ADR; data/privacy-model ADR required before code |
| SpotMe Exchange | Planned | PRD draft in PR **#64** (`handbook/product/exchange/`), pending A5 ratification; **no code** |
| Live voice translation | Implemented (Draft PR **#49** scaffold + **#54** pipeline, `feat/live-voice-*`) | scaffolding; not on master |
| Adaptive transport + Bluetooth mesh | Implemented (Draft PR **#50**, `feat/adaptive-transport-scaffold`) | scaffolding; not on master |
| Centrifugo transport | Deferred | seam on master (`web/src/lib/transport/centrifugo-adapter.js`; backend `realtime.controller.ts:71` returns 503 unless configured); **no client dependency in any package.json**; `feature/centrifugo-transport` abandoned (49 behind). ADR-002 keeps the interface |
| Media platform (media-core contracts) | In Progress | branch `feat/media-core-contracts` pushed with **no open PR** (audit anomaly A1) — see `spotme/docs/handbook/DECISIONS.md` item 7 (owner decision sheet, on the PR #62 branch) |
| Engineering Handbook (this document set) | Implemented (Draft PR **#62**, stack #63/#64/#65) | `docs/engineering-handbook-v1` → `docs/discovery-platform-architecture` |

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
