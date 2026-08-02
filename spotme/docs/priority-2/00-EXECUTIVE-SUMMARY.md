# Priority 2 — Engineering Preparation Package (Executive Summary)

**Status: PLANNING ONLY. Priority 1 remains in review-freeze and is treated as
immutable.** Nothing in this package modifies runtime code, changes a schema,
activates a feature flag, or merges any PR. Produced autonomously (2026-08-01) so
that Priority 2 implementation can begin immediately once the owner accepts the
Priority 1 APPROVED verdict.

The Priority 2 execution order follows the **Owner Amendment** in
`MASTER-ENGINEERING-ROADMAP-V2.md`: ① Push notifications → ② Translation platform
→ ③ Live voice translation (flagship) → ④ Adaptive communication network → ⑤ AI
communication platform. This package delivers one implementation-ready design
document per workstream plus the cross-cutting synthesis below.

> **Numbering caution (flagged by four of five workstreams).** This
> `priority-2/` directory is the *Owner-Amendment execution bucket*, not roadmap
> §5 "Priority 2 — Production Hardening." The renumbering is **not** an unblock of
> anything: the ADR-008 §12 publication hard stop, the Priority-1-completion gate,
> and (for cross-device features) the multi-device §BLOCKING decision all still
> hold.

---

## 1. Package index

| Doc | Workstream | Lines | Grounded in |
|---|---|---|---|
| `01-push-notifications.md` | ① Push Notification Platform | ~1,600 | `PushService`, `rooms.gateway`, `DeviceToken`/`PushSubscription` |
| `02-translation-platform.md` | ② Translation Platform | ~1,300 | `web/api/translate.js` (902 LOC engine), `lib/translate.js` |
| `03-live-voice-translation.md` | ③ Live Voice Translation (flagship) | ~1,370 | WebRTC path in `socket-transport.js`, `rooms.js`, ElevenLabs proxy |
| `04-adaptive-communication-network.md` | ④ Adaptive Communication Network | ~1,210 | `transport/room.js`, `socket-transport.js`, `reach.js` |
| `05-ai-communication-platform.md` | ⑤ AI Communication Platform | ~1,060 | `translate.js` legs, `voice.js` clone lifecycle |
| `90-IMPLEMENTATION-ORDER-AND-DEPENDENCIES.md` | cross-cutting | — | dependency graph, backlog, readiness checklist |
| `91-ENGINEERING-RISK-REGISTER.md` | cross-cutting | — | consolidated risk + owner-decision register |

Every workstream doc follows the required engineering standard (motivation,
architecture, alternatives, trade-offs, security, privacy, scalability, latency,
observability, testing, deployment, rollback, future evolution), and carries API
contracts, Mermaid sequence + state diagrams, planning-only DB proposals,
benchmark/rollout/rollback plans, and concrete ADR-009…012 improvements (proposed
in-doc, not applied in place).

## 2. The through-line: every design extends the shipped system

None of these is a greenfield rewrite. Each agent mapped its design onto real
code by file and symbol. The consistent posture:

- **Formalize, don't rebuild** (WS2): the organically-grown translation engine
  becomes a typed `TranslationProvider` interface + a routing/breaker/cache layer;
  the existing provider legs become registrations.
- **Generalize an existing seam** (WS1 outbox from the `storage-cleanup` cron
  shape; WS4 transport supervisor from `transport/room.js`).
- **Add a dedicated subsystem only where the product genuinely needs one** (WS3's
  Live Translation Media Service — explicitly *not* an extension of the async
  voice-note pipeline, per the roadmap).

## 3. Recommended implementation order (with the dependencies that shape it)

The Owner-Amendment order holds, with two cross-cutting foundations pulled early
because three workstreams depend on them:

0. **Shared foundations (pull first, ~M):** wire the already-installed
   `prom-client` into a minimal `/metrics` + a cost-governance layer (per-provider
   budgets/caps). WS1, WS2, WS3, WS5 all flag "no observability" and "eight
   metered vendors, no caps" as blockers-at-scale. Cheap now, expensive to retrofit.
1. **① Push notifications** — largely independent; ship **reliability-first
   (Phase 2a)** now; rich decrypted native content (Phase 2b) is coupled to the
   Capacitor native app (Priority 10).
2. **② Translation platform** — defines the **provider abstraction** that WS3 and
   WS5 both reuse; mostly a formalization of shipped behavior, so low risk, high
   leverage.
3. **③ Live voice translation (flagship)** — depends on ②'s provider adapters +
   streaming variants and on the shared foundations; introduces the LTMS.
4. **④ Adaptive communication network** — its linchpin (the "seal-lift" refactor)
   is **crypto-adjacent and must be sequenced with/after Priority-1 e2e_v3
   activation** with e2e-version negotiation + visible v2 fallback; the transport
   supervisor follows; native Bluetooth **mesh is a later, separately-ADR'd,
   native-app deliverable**.
5. **⑤ AI communication platform** — extends ②'s abstraction; **on-device by
   default**; cross-device search is **gated on the multi-device design**; meeting
   mode is downstream of ③.

See `90-…` for the dependency graph and phased backlog.

## 4. Estimated implementation effort by workstream

Rough planning estimates for a small senior team (S≈1–2 wk, M≈3–5 wk, L≈6–10 wk,
XL≈10 wk+). These are *engineering* estimates for the designed scope, not
commitments; the largest uncertainty bands are called out.

| Workstream | MVP scope | Effort | Full scope | Effort | Dominant uncertainty |
|---|---|---|---|---|---|
| Shared foundations | `/metrics` + cost caps | **M** | + dashboards/alerts | +S | overlaps Priority 9 (OTel) |
| ① Push | reliability (2a) | **M** | + rich native (2b) | **L** | native app (P10), iOS NSE/PushKit |
| ② Translation | typed abstraction + routing | **M** | + cross-provider verify + adjudication + cache | **L** | server-cache privacy decision; cost caps |
| ③ Live voice | 1:1 LTMS, <2.5 s | **XL** | + N-way multilingual + expressive prosody | **XL+** | latency budget on real networks; provider zero-retention |
| ④ Adaptive net | seal-lift + supervisor (relay/WebRTC/Socket.IO) | **L** | + BLE mesh / Wi-Fi Direct / offline | **XL** | native BLE (iOS blocks); mesh trust ADR |
| ⑤ AI platform | on-device summaries/replies/search | **L** | + assistants + meeting mode | **XL** | on-device runtime feasibility UNPROVEN |

**Critical-path read:** ② is the cheapest high-leverage unlock (feeds ③ and ⑤);
③ is the single largest and riskiest build (the flagship); ④'s seal-lift is small
in code but high in blast radius (crypto path). The shared foundations are the
cheapest thing with the widest downstream payoff.

## 5. Risks requiring owner decisions (consolidated — full register in `91-…`)

The workstreams surfaced these as decisions, deliberately **not** resolved. The
highest-stakes cluster around the E2EE trust boundary:

- **Provider plaintext boundary (②③⑤).** Translation, live voice, and any cloud
  AI over content are *inherently plaintext at the provider* — the "server is the
  adversary" invariant cannot hold there. Each doc scopes this as an explicit,
  per-direction, consented exception with the E2E path preserved as fallback; the
  owner must ratify the boundary and the consent model.
- **Server-side memory of content (②⑤).** A server translation cache (WS2 C1) or
  any server-side plaintext index/summary/embedding of history (WS5 Tier 3)
  breaks ADR-010/the E2EE posture. Both default **OFF / forbidden**; enabling
  either is an owner-level threat-model change.
- **Notification wrapping key (①).** A dedicated per-device X25519 key seals rich
  push envelopes, isolated from the messaging/signing keyspace. Needs a
  security-review ruling that this is **not** "key publication" under ADR-008 §12
  (fallback: content-less-only native, platform still ships).
- **Cost governance (②③⑤).** Eight metered vendors, no caps in code today;
  cross-verification, adjudication, and TTS fan-out multiply spend. Owner must set
  the enforcement policy (hard-block vs degrade-to-cheaper vs alert-only) and the
  numbers.
- **Native-app coupling (①④).** Rich decrypted push content and native
  Bluetooth/mesh both require the Capacitor native app (Priority 10); **iOS blocks
  Web Bluetooth entirely** and severely constrains background BLE.
- **Live-voice scope (③).** Group (>2) calls conflict with ADR-011's MVP non-goal
  (recommend design-N-way / ship-1:1-first); ratify the LTMS as the sole media
  plaintext boundary and the MVP emotion-fidelity/latency-measurement bar.
- **Multi-device coupling (⑤).** Cross-device conversation search is gated on the
  still-open multi-device §BLOCKING design; it does not unblock it.

## 6. Architecture conflicts discovered (consolidated)

- **The seal-lift is on the Priority-1 crypto path (④).** Lifting AES-GCM
  seal/open above the transport (the enabler for transport interchangeability, and
  the fix for Centrifugo "would send plaintext") touches `socket-transport.js` and
  folds into e2e_v3 activation per `17-CRYPTO` §10 — so ④ must sequence
  with/after Priority-1 crypto and carry the full ADR-002 test battery. **Not a
  Priority-2-only change.**
- **Observability is unbuilt (①②③).** `prom-client` is installed but no
  `/metrics` exists; three workstreams are "first consumers" of a stack that does
  not yet exist. Minimal metrics now, full OpenTelemetry deferred to Priority 9.
- **Shared-state ceiling (②).** Rolling health/quality/breaker/rate-limit state
  wants Redis/Dragonfly, but that selection is Priority 3 — enterprise volume
  needs an authorized scoped exception or acceptance of the per-instance ceiling.
- **Client storage must join the wipe path (⑤).** A new on-device AI index (a 4th
  IndexedDB) must be added to `wipeDevice` (now correct after NEW-4) and honor
  disappearing-message TTLs.
- **`chat.js` bloat (⑤, pre-existing).** ~4,600–9× the 500-line rule; new AI/live
  code must not grow it.
- **Model-identity / dead deps (①).** Dispositions reconciled: remove
  `@parse/node-apn`, `bullmq`, `ioredis`; wire `prom-client`.

## 7. What "implementation-ready" means here

A competent engineer can open any workstream doc and start building with almost no
further architectural decisions **except** the owner decisions in §5 — which are
deliberately escalated because they are threat-model, product, or cost calls, not
engineering ones. The dependency graph, phased backlog, and production-readiness
checklist in `90-…` sequence the work; the risk register in `91-…` tracks every
open decision to closure.

**Nothing here is authorized to be built until the owner accepts the Priority 1
verdict and explicitly starts Priority 2.**
