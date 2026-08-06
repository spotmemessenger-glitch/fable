# Spot Me — Product Scope & Execution Roadmap v2.0

**Status:** Canonical. This is the **highest-level product authority** for Spot
Me. It is a complete rewrite (not an amendment) and **replaces**
`SPOTME_NEW_PRODUCT_SCOPE_2026-08-02` as the governing product document. That
scope document is preserved beside this one as a historical source, not as
authority.

> **How to trust this document.** It states *product scope and direction* — what
> we are building toward. It is **not** an implementation claim. What is actually
> built is authoritative only in
> [../03-IMPLEMENTATION-STATUS](../03-IMPLEMENTATION-STATUS.md) (the six-state
> model, with evidence). Separate, always: requested scope · planned architecture
> · implemented code · real-device validation · production activation.
>
> **Sources reconciled** (2026-08-03): Engineering Handbook v1.0 (PR #62), the
> Product Authority + ADR-021, `SPOTME_NEW_PRODUCT_SCOPE_2026-08-02` (owner),
> `SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY` (owner), and current repository
> evidence at `master` `31e1894`. Two named owner sources were **not available
> verbatim** and are flagged where they bear on content:
> `Spot_Me_Product_Scope_and_Execution_Roadmap` and the **approved SpotMe
> Exchange specification** (see §14 and §26). Where sources conflict, both are
> preserved and the reconciliation is stated explicitly.

---

## 1. Executive Summary

Spot Me is a **privacy-first, AI-powered real-world connection platform**. It
unifies three flagship pillars — **Communication** (the core), **Discovery** (the
intelligence layer) and **Creation** (the content engine) — into a single loop:
**Create → Discover → Communicate → Create**.

The objective is not to be another messaging app. It is to become the world's
most intelligent **real-world** connection platform: people communicate across
languages, discover what is genuinely around them, create and share local
content, **solve everyday problems** (via SpotMe Exchange), and build
communities — all under a constitution where privacy is non-negotiable and the
product never claims more than it can prove.

The near-term work is the **AI Discovery & Social Platform** programme, executed
in a fixed, owner-controlled sequence: **Smart Nearby Discovery Map → SpotMe
Exchange → Live Nearby Events → Nearby Moments → AI Assistant &
Personalization**. Communication is the mature core; Creation (Camera/Studio) is
built but **frozen ("built-off")**, integrating later through Nearby Moments.

Two architectures coexist and are reconciled here: the **current** shipped
repository (vanilla-JS web + NestJS backend) and the **canonical target
architecture** (TypeScript monorepo, React PWA, scalable realtime) defined in
`SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY`. Delivery is a **strangler migration**
across waves, not a single rewrite (§11).

---

## 2. Product Constitution

These principles should **almost never change**. A change here requires an
explicit owner decision and a new superseding ADR.

1. **Communication is the core.**
2. **Discovery is the intelligence layer.**
3. **Creation is the content engine.**
4. **AI assists people** — it never manipulates, impersonates, or decides for
   them; every AI output is explainable.
5. **Privacy is non-negotiable.**
6. **Exact location is always optional.**
7. **Approximate public location is the default.**
8. **Proximity outranks popularity.**
9. **Honesty over fabricated convenience** — never invent ETAs, reviews,
   attendance, or capabilities; say "insufficient evidence" instead.
10. **Security before features.**
11. **Consent is explicit and revocable** — voice profiles, personalization,
    location sharing, and cloud-AI boundaries are opt-in and deletable.
12. **Sponsored content is always labeled** and never silently overrides
    relevance or safety.
13. **Dark by default** — new capability ships flag-off and inert; activation is
    a separate, owner-authorised act.

---

## 3. Product Vision

Spot Me is a global, privacy-first communication and discovery platform that
feels as immediate and dependable as the leading messengers, while adding what
they lack: **honest, privacy-safe awareness of the real world around you**, in
your own language, with tools to create and act on it.

**Long-term vision.** Spot Me becomes an AI-powered real-world platform where
people:

```
Communicate → Discover → Create → Solve everyday problems → Build communities → Explore the world
```

The goal is the world's most intelligent **real-world** connection platform —
not another chat app.

---

## 4. Three Flagship Pillars

### Communication — the core
Fast, dependable, private messaging and calling. Multilingual by design:
translation and **voice-preserving** translation are first-class, not
afterthoughts. Includes chats, groups, communities, channels; media, documents,
location, contacts, voice notes and calls; offline queueing and reliable replay;
multi-device continuity; strong E2EE identity and safety-number UX; adaptive
transport that never asks the user to pick a network. (Scope §1–§3.)

### Discovery — the intelligence layer
Privacy-first awareness of people, places, events, needs and community content
nearby. Delivered by the **Discovery Programme** (§12) in a fixed sequence.
Always approximate-by-default, provider-neutral, and transparently ranked
(proximity outranks popularity).

### Creation — the content engine
AI Camera, Creative Studio, AI Vision, Photos, Videos, Stories, Reels. Creation's
output **feeds Discovery** through Nearby Moments. Currently **frozen**
("built-off"); it integrates later and is **not** reopened ahead of the Discovery
sequence (§18).

---

## 5. Product Loop

```
        ┌───────────────────────────────────────────────┐
        │                                               │
        ▼                                               │
     Create  ───────▶  Discover  ───────▶  Communicate ─┘
   (Creation)        (Discovery)        (Communication)
```

People **create** content and needs; **discovery** surfaces them nearby;
surfacing sparks **communication**; communication motivates more **creation**.
Creation feeds Discovery; Discovery feeds Communication; Communication feeds
Creation. Three pillars, one loop — not three apps.

---

## 6. Core Design Principles

Operational rules every surface inherits (a superset of the constitution,
applied):

- **Precise GPS is device-local** — used for distance/centring/radius/routing;
  never broadcast, persisted unnecessarily, logged, put in analytics/URLs, or
  sent to a provider except where a nearby search technically needs an origin.
  (ADR-019.)
- **Public location is approximate** — coarse cell + rotating bounded offset;
  hidden/ghost transmits nothing. (ADR-018.)
- **Provider-neutral** — normalise every vendor to stable Spot Me models; no
  vendor lock-in; no credential leakage; route/fall back on quality, latency,
  cost, availability. (ADR-017.)
- **Compile-time dark shipping** — flags default off, hard master gate,
  tree-shaken, fence-tested. (ADR-015/016.)
- **Transparent ranking** — explicit weights, explainable; **proximity outranks
  popularity**; no sensitive-trait inference; personalization opt-in.
- **Never fabricate ETAs/directions** — routes/ETAs come from a directions
  provider; straight-line is labeled as such.
- **Deterministic tests for privacy-sensitive logic** — injected clock/seed;
  mutation tests that fail if precise data leaks.
- **Honesty** — "insufficient evidence" over invention; clear refusal over fake
  controls.

---

## 7. Product Differentiators

- **Voice-preserving translation** — live and voice-note translation in the
  speaker's consented voice, captions-before-speech, original-audio fallback.
- **Privacy-safe local discovery** — approximate-by-default presence and a map
  that resists home/exact-location correlation, unlike location-sharing apps.
- **SpotMe Exchange** — AI-matched local **needs and offers**: a real-world
  problem-solving layer no mainstream messenger has (§14).
- **Honest AI** — explainable recommendations, labeled sponsorship, non-diagnostic
  vision, no sensitive inference.
- **No account, no phone number** — device-generated identity; spontaneous,
  proximity-based connection.
- **One loop, not many apps** — creation, discovery and communication reinforce
  each other.

---

## 8. Current Product Baseline

**Implemented and running on `master`** (evidence in §9 and
[../03-IMPLEMENTATION-STATUS](../03-IMPLEMENTATION-STATUS.md)):

- Proximity messenger: Meet / Nearby / Bluetooth chat, no-accept-gate knock.
- Multilingual messaging: split-bubble translation + 10-language transliteration.
- Groups and permissions.
- Secure identity: safety numbers, identity-trust state machine (key changes
  **proposed, never silently adopted**), signing identity + bindings, send
  enforcement computed-but-off, dark signing-key storage.
- Media in IndexedDB; client→bucket storage seam; transport authorisation seam.
- CI that runs real assertions; ESLint gate; Playwright e2e foundation.

**Baseline defect — FIXED 2026-08-03:** Discovery v1 previously broadcast precise
GPS in public presence. This was fixed on `master` by the **coarse-location
hotfix (PR #66, merge `069905e`, ADR-024)** — public presence now emits only
coarsened output, guarded by `web/test/discovery-coarse-broadcast.test.js`. The
broader approximate-only Discovery model (draft PR #60) supersedes the interim
`coarse()` call and rebases onto ADR-024.

---

## 9. Current Repository State

Verified at `master` `31e1894`, 2026-08-03.

- **Frontend** `spotme/web`: Vanilla-JS ES modules + Vite 8 (no framework),
  Trystero P2P + socket.io transport, IndexedDB media, WebCrypto. Tests:
  `node --test` (45 suites on master) + ESLint + `vite build`.
- **Backend** `spotme/backend`: NestJS + Prisma + PostgreSQL; tested against a
  real Postgres in CI.
- **Also:** `core/` (shared JS), `e2e/` (Playwright), `server/`, `app/` (an
  Expo/RN experiment, not the shipped client).

**Reconciliation — current vs. canonical target architecture.** The **canonical
target** (`SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY` §2) is a **TypeScript
monorepo**: `apps/{web(React PWA),mobile(Capacitor),api(NestJS),workers,admin}`,
`packages/{contracts,crypto,ui,domain,observability,testing,provider-sdk}`,
scalable Socket.IO + Redis/DragonflyDB realtime, X3DH/Double-Ratchet identity.
The **current** repo is the pre-migration source. **Both are canonical for
different purposes:** the current repo is the compatibility/behaviour source; the
target is the destination. New work builds toward the target via a **strangler
migration** (§11), preserving data/protocol compatibility — the current stack is
**not** revived as the target.

---

## 10. Current Built-Off Programmes

"**Built-off**" = built, on a **frozen** branch, not to be advanced without owner
authorisation (six-state: *Implemented (Draft PR)*, frozen).

| Programme | Draft PRs | State |
|---|---|---|
| **Discovery V2 — Smart Nearby Discovery Map** | #60 | Dark; **active programme step 1** (not frozen) |
| **Live Nearby Events** | #61 (stacked on #60) | Dark; active programme step 3 |
| **AI Camera / Vision / AR / Creative Studio** | #56 / #58 / #59 / #55 | **Built-off (frozen)** — do not reopen (§18) |
| Translation provider abstraction | #51 | Dark |
| Push platform / SDKs | #52 / #48 | Dark |
| Live voice translation | #49 / #54 | Scaffolding |
| Adaptive transport + Bluetooth mesh | #50 | Scaffolding |
| Crypto ratchet stack (X3DH/Double-Ratchet/multi-device) | #41 / #42 / #43 | **Gated by ADR-008 §12** |

Media-core contracts exist on a branch with **no open PR** (anomaly — §26,
handbook §10). Camera branches are **frozen** per standing owner directive.

---

## 11. Priority Roadmap

Two lenses, reconciled: the **migration waves** (target-architecture path,
`MIGRATED_BUILD_MEMORY` §3) and the **current active product programme**
(Discovery). They are not in conflict — the active programme is delivered as
dark foundations now and hardened into the migrated architecture as the waves
land.

**Migration waves (target path):** 0 Governance → 1 Platform foundation → 2
React/TS app shell → 3 Identity/auth/profiles → 4 Secure chat & realtime → 5
Media & notifications → 6 Translation & live voice → 7 AI Camera & Studio → 8
Discovery/events/local social → 9 Autonomous ops & business → 10 Launch
hardening. Each wave replaces a complete vertical slice, ships dark, and includes
rollback.

**Current active programme:** **AI Discovery & Social Platform** — the Discovery
Programme (§12), whose foundations (steps 1–3) are already built dark ahead of
their wave, pending activation and migration-hardening.

**Named macro-phases** (handbook [04-ROADMAP](../04-ROADMAP.md)): 1 Engineering
Handbook · 2–3 AI Discovery & Social Platform *(active)* · 4 Integration &
Activation · 5 Media Platform Evolution.

**Standing gates:** ADR-008 §12 crypto hard-stop; AI interface-only until
authorised; dark-by-default with separate activation; the migrated Definition of
Done (§25).

---

## 12. Discovery Programme

The current active programme, **"SpotMe AI Discovery & Social Platform."** The
implementation sequence is **fixed and owner-controlled** — sessions do not
reorder or skip it:

```
 Smart Nearby Discovery Map
        ↓
 SpotMe Exchange
        ↓
 Live Nearby Events
        ↓
 Nearby Moments
        ↓
 AI Assistant & Personalization
```

> **Reconciliation with ADR-021.** ADR-021 recorded a **four-step** sequence
> (Map → Events → Moments → Assistant). This v2.0 inserts **SpotMe Exchange** as
> step 2 by owner decision, making it **five steps**. ADR-021 is **immutable**
> (G6) and is **not** edited; this owner decision **supersedes its sequence** and
> is ratified by **ADR-022 (Accepted 2026-08-03)**. Both are preserved; this
> document and ADR-022 are authoritative for the sequence going forward.

Every step inherits the core design principles (§6). Steps 1–3 have dark
foundations built (§10); steps 2, 4, 5 are Planned. Sections §13–§17 detail each.

---

## 13. Smart Nearby Discovery Map

**Sequence step 1.** *Implemented (Draft PR #60), dark.*

A privacy-safe interactive local map: "Happening Around You" by default (activity
within 10 km, expanding transparently 15 → 25 → 50 → 100 km with the app telling
the user when it expands); place/service search (restaurants and specific dishes,
dietary needs, cafés, nightlife, parks, hotels, medical, banks/ATMs, fuel/EV,
shopping, events); full-screen map with clustered pins, a selected-pin↔result-card
single source of truth, best-first list with alternative sorts, and **honest**
route/ETA/distance (directions provider, never straight-line-as-driving). People
markers are **approximate-only**; precise GPS stays device-local. (Scope §7;
ADR-018/019.) Provider-neutral; authorized data only; no scraping.

---

## 14. SpotMe Exchange

**Sequence step 2.** *Planned — flagship capability.*

> **⚠ SOURCING NOTE (honesty).** The owner directs integrating "the complete
> approved SpotMe Exchange specification" verbatim. **That specification was not
> present** in any available canonical source. Per the constitution ("do not
> invent scope"), the summary below and the **full dedicated PRD** at
> **[exchange/](exchange/README.md)** are a **faithful reconstruction** from (a)
> the components the owner named and (b) Spot Me's established design principles.
> It is **pending ratification** against the approved spec (§26, gap A5;
> ratification checklist in [exchange §13](exchange/13-ACCEPTANCE-AND-OPEN-QUESTIONS.md)).
> Nothing here is final approved detail. **The dedicated PRD
> [exchange/README](exchange/README.md) is the engineering blueprint for
> Exchange** — this section is its summary.

**Concept.** SpotMe Exchange is the real-world problem-solving layer: people post
a **Need** or an **Offer**, and AI matches them by **intent**, surfaced through
the same privacy-safe local discovery as everything else. It is a flagship
capability, not a classifieds bolt-on.

- **Need** — a request to fulfil ("need a plumber this evening", "looking for a
  used road bike", "need a study partner for calculus"). Structured intent +
  free text; approximate location by default; time-bounded; lifecycle-managed.
- **Offer** — a capability or item on offer ("offering guitar lessons",
  "selling a sofa", "open table at 8pm"). Same structure; may originate from a
  person or a participating business.
- **AI Intent Matching** — matches Needs to Offers on **intent**, not keywords:
  structured intent + semantic similarity + proximity + availability + trust,
  with an **explicit, explainable** match rationale. Interface-first (no LLM
  activation without owner authorisation); no sensitive-trait inference.
- **Unified Discovery** — Exchange results appear in the same map/list surfaces
  as places/events (single result model, single map state), not a separate silo.
- **Adaptive Radius** — reuses the approved 10 → 15 → 25 → 50 → 100 km expansion
  with min-result stop and transparent "expanded to N km" messaging.
- **Business Participation** — verified businesses may post Offers and respond to
  Needs; any paid placement is **labeled** and never overrides organic relevance
  or safety.
- **Privacy** — approximate location by default; precise location only on
  explicit, per-interaction consent; a poster's exact live position is never
  exposed; matching runs on privacy-safe signals.
- **Safety** — report/block/appeal; anti-fraud and anti-spam; safe defaults for
  minors and vulnerable users; no unsafe categories; provider/source trust
  signals in ranking.
- **User Flows** — post a Need/Offer → AI proposes matches with rationale →
  connect via Communication (knock/chat) → resolve → close/expire. Discovery and
  Communication pillars are the rails; Exchange is the matcher.
- **Lifecycle** — draft → active → matched → in-conversation → resolved →
  closed/expired; freshness/expiry and stale removal like Live Events; edits and
  withdrawals are explicit.
- **Ranking** — transparent weighted match (intent fit, proximity, availability/
  recency, trust), **proximity-respecting**, explainable; **no** sensitive
  inference; sponsored Offers labeled and separated.
- **Long-Term Vision** — a trusted local marketplace of needs and offers —
  services, goods, help, community — that makes Spot Me the place people go to
  **solve everyday problems** locally, feeding the Communicate and Create loop.

**Engineering inheritance** (when built): provider-neutral contracts, compile-time
dark flags, deterministic tests for the privacy boundary, honest states
(loading/empty/unavailable/partial/failed), cancellation/supersede — reusing the
Discovery V2 radius/search/ranking/mapstate primitives (ADR-015–019).

---

## 15. Live Nearby Events

**Sequence step 3.** *Implemented (Draft PR #61), dark.*

A separate flagship surface (not a map filter or place category): authorized,
public events near the user — upcoming / happening-now / cancelled / postponed /
ended, with source attribution, timezone handling, freshness/expiry, cross-
provider dedup, adaptive radius, transparent time+distance+relevance+popularity
ranking, event detail, and place/map/directions linking. **Never** invents
events, attendance, popularity, prices, or venue details; authorized sources
only; no scraping. Reuses the Discovery V2 contracts. (Scope §7.1.)

---

## 16. Nearby Moments

**Sequence step 4.** *Planned — next approved mission after the handbook merges.*

The nearby social feed: local photos/videos, stories and short videos,
location-tagged posts with **approximate/coarse location by default**, likes/
comments/saves/shares, follow creators and places, local trends and event
coverage, creator tools drawn from the (frozen) Camera & Studio, moderation/
block/report/appeals, age and safety controls, optional friends-only/community
modes. It **connects content to the map without exposing a poster's precise live
location**. This is where **Creation feeds Discovery**. (Scope §8.)

**Required before code:** a Nearby Moments **data & privacy-model ADR** (location
coarsening, consent, retention, moderation, blast radius).

---

## 17. AI Assistant & Personalization

**Sequence step 5.** *Planned — consent-based, interface-first.*

Explainable recommendations ("because you liked South Indian food", "quiet cafés
open now", "vegetarian options near your route"), a voice map assistant (natural
questions → transcript → structured query; route questions use a directions
provider, never an unlabeled straight-line estimate), and AI review/result
summaries from **authorized data only** ("insufficient evidence" over invention).

**Personalization is opt-in and editable** (dietary, cuisines, budget, family-
friendly, accessibility, nightlife, travel interests, radius, saved/hidden
categories). **Sensitive religious/health attributes must never be inferred;**
medical searches never become an ad profile. **No LLM/assistant activation
without owner authorisation.** (Scope §7.4–§7.6, §9.)

---

## 18. Camera & Creative Studio

The **Creation** pillar. **Camera is not removed from the product** — it is a
flagship pillar whose output later feeds Discovery via Nearby Moments. Its status
lifecycle:

```
 Built  →  Draft PR  →  Built-Off  →  Not Active
```

- **Built:** Photos and basic photo editing on `master`.
- **Draft PR / Built-Off (frozen):** Camera Engine (#56), AI Vision (#58), AR &
  Beauty (#59), Creative Studio (#55) — dark, behind disabled flags, on **frozen**
  branches.
- **Not Active:** Stories/Reels (planned).

**Do not reopen the Camera programme** ahead of the Discovery sequence. It
integrates later, principally through **Nearby Moments** (creator tools) and via
the migrated architecture's Wave 7. Scope detail: professional capture with
honest capability matrix, natural user-controlled beauty (fully disable-able, no
hidden appearance scoring), gesture-reactive AR, non-destructive studio, and safe
**non-diagnostic** AI Vision. (Scope §4–§6; CREATION-PILLAR.)

---

## 19. Business Platform

*Future scope — recorded, not active.* Verified business pages; promoted events
and **labeled** sponsored pins/listings; coupons/offers; reservations and ticket/
affiliate actions; business subscriptions and analytics; a creator-brand
marketplace; organization/enterprise accounts, managed devices, business
messaging, support inboxes, audit logs, compliance, API/webhook plans. Businesses
also participate in **SpotMe Exchange** (Offers). **Paid placement never silently
overrides relevance or safety;** sponsorship is always labeled. (Scope §10.2–§10.3.)

---

## 20. Revenue Model

*Direction, not an activation plan.*

- **Consumer plans:** Free (secure chat, basic calling, limited translation/AI-
  camera/vision, normal Discovery) · Plus (larger translation allowance, voice-
  note translation, advanced camera tools, more studio exports, higher AI limits)
  · Pro/Creator (higher-res exports, advanced AI effects, creator analytics,
  premium templates, storage, priority processing) · optional usage credits for
  costly voice-clone/live-translation/cloud-vision/TTS. **Core chat and safety
  remain usable without an AI subscription.**
- **Local commerce & discovery:** labeled sponsored pins/listings, promoted
  events, coupons, reservations, ticket/affiliate fees, business subscriptions,
  verified pages, analytics, creator-brand marketplace — all privacy-controlled
  and clearly labeled.
- **Business & enterprise:** org accounts, managed devices, business messaging,
  support inboxes, audit/compliance, API/webhook plans.

Non-negotiable: **paid placement never overrides relevance or safety;** the goal
is sustained usefulness, not compulsive engagement. (Scope §10.)

---

## 21. Privacy Architecture

- **Exact location is private by default;** nearby discovery uses coarse or
  consented location; **location history off by default**. (Constitution 6–7.)
- **Precise GPS is device-local** (ADR-019); **public position is approximate**
  via a deterministic cell + rotating bounded offset (ADR-018); hidden/ghost
  transmits nothing; the exact position is not recoverable from markers, logs,
  events, or the DOM.
- **E2EE** remains central to Communication; content-free notifications by
  default; no raw exact-location or sensitive-transcript logging.
- **Voice cloning** requires explicit enrollment and deletion controls.
- **Consent** is explicit and revocable; users can export, clear and delete data;
  collection minimized and retention bounded.
- **Deterministic privacy tests** (mutation-style) guard every privacy boundary.
- **Cloud-AI boundaries are visible;** stronger defaults for minors and
  vulnerable users. (Scope §12; MIGRATED_BUILD_MEMORY §2.)

---

## 22. AI Architecture

- **AI assists people** and is **explainable** — every recommendation/match/summary
  carries a rationale; no hidden manipulation.
- **Interface-first / provider-neutral** — AI features are defined as interfaces
  over provider-neutral ports (`provider-sdk`); **no LLM calls or conversational
  assistant are activated without explicit owner authorisation**. Every provider
  call has timeout, cancellation, retry, circuit-breaker, cost accounting and
  normalized errors.
- **No hard provider dependency** — route/fall back on accuracy, latency, privacy,
  availability and cost; every AI feature optimises accuracy + latency + privacy
  simultaneously.
- **No sensitive inference** — never infer religious/health/other sensitive
  attributes; personalization is opt-in and editable.
- **Honest boundaries** — vision is non-diagnostic; summaries say "insufficient
  evidence" rather than inventing; transparent ranking with explicit weights and
  proximity-over-popularity. (Scope §5, §7.5–§7.6, §9; owner amendment.)

---

## 23. Safety & Moderation

Report / block / appeal with evidence handling across people, places, events,
Moments and Exchange. Anti-fraud/anti-spam; safe categories; **stronger defaults
for children and vulnerable users**; age and safety controls on social surfaces.
Location-abuse controls (approximate-by-default, no precise live exposure).
Sponsorship labeled; paid placement never overrides safety. Moderation tooling
and audit trails; two independent reviewers for security, crypto, billing and
data-deletion changes; **no agent or automation may hide an alert or mark its own
unverified claim as evidence.** (Scope §11.3, §12; MIGRATED_BUILD_MEMORY §4.)

---

## 24. Engineering Principles

Every feature (from `MIGRATED_BUILD_MEMORY` §4, reconciled with the handbook):
repository-first inspection · written compatibility/dependency report · small
**stacked draft PRs** · **feature flags default OFF** · no new dependency without
license/security/size/rollback justification · unit + integration + browser + E2E
tests · **negative and mutation tests for critical invariants** · real-provider
tests separated from credential-free CI · CPU/memory/latency/battery/network
benchmarks where applicable · threat model + privacy review · observability + cost
metrics · forward migration + rollback · mixed-version compatibility · docs +
runbook · **explicit owner approval before merge or activation.** Provider-neutral
adapters, compile-time dark shipping, and fence tests are mandatory for new
platform foundations (ADR-015–017). Coding standards: handbook
[06-CODING-STANDARDS](../06-CODING-STANDARDS.md).

---

## 25. Acceptance Gates

**Definition of Done** (`MIGRATED_BUILD_MEMORY` §5): a capability is **not** done
when only interfaces, stubs or dark modules exist. It is production-ready only
when: wired into the migrated app behind reviewed flags · real dependencies and
credentials validated in staging · real devices and supported browsers tested ·
security and privacy decisions ratified · cost ceilings configured · monitoring
and alerts live · **rollback executed successfully** · staged-rollout evidence
complete · **owner approves activation**.

**Per-wave exit gates** apply (§11). **Discovery-specific gates:** privacy threat
model, provider licensing, ranking fairness, and location-abuse controls must
pass before any Discovery surface activates (`MIGRATED_BUILD_MEMORY` Wave 8).
**Crypto gate:** ADR-008 §12 hard stop stands. **Dark→active** is always a
separate owner-authorised change (ADR-016, G8).

---

## 26. Owner Decisions

**Standing directives** (binding; handbook
[09-OWNER-DECISIONS](../09-OWNER-DECISIONS.md)): Roadmap V2 engineering doc
controls; execution-order amendment; ADR-008 §12 hard stop; AI interface-only; no
provider is a hard dependency; dark-by-default with separate activation; **Camera
branches #55/#56/#58/#59 frozen**; Discovery privacy parameters approved (500 m /
30 min / 150 m), layered compile-time flags + hard master gate, provider-neutral
contracts approved.

**Decided in this document:** the Discovery sequence is **five** steps with
**SpotMe Exchange inserted at step 2** (owner-controlled; supersedes ADR-021's
four-step sequence — ratified as ADR-022, Accepted 2026-08-03).

**Open decisions / required inputs:**
| # | Decision | Needed for |
|---|---|---|
| 1 | Provide the **approved SpotMe Exchange specification** (verbatim) | Ratify §14; replace the reconstruction |
| 2 | Provide **`Spot_Me_Product_Scope_and_Execution_Roadmap`** and **`SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY`** as committed repo files | Close handbook gap A4 |
| 3 | Merge the documentation PRs in order (#62 → #63 → #64 → #65), then approve **Nearby Moments** when its turn comes | Unblock implementation |
| 4 | Provider selection (map/events/exchange authorized sources) | Activate Discovery surfaces |
| 5 | Crypto ratchet stack ratification vs ADR-008 §12 | Priority-1 messaging completion |
| 6 | `feat/media-core-contracts` — open a PR or fold the branch | Resolve anomaly |

---

## 27. Future Scope

Recorded, **not** activated (needs a separate owner-approved mission and, where
architectural, an ADR): nearby **businesses** at full breadth · **AI Search** and
**Voice Search** · **AI Review Engine** (authorized-source summaries) · **Community
Contributions** (reviews/photos/local posts) · **AI Travel Companion** · **Business
Platform** (§19) · **Autonomous operations agents** (event-driven, policy-approved,
audited, human-confirmation for dangerous actions — Scope §11, `MIGRATED_BUILD_MEMORY`
Wave 9) · **Global readiness** (multilingual/RTL, localization, low-bandwidth,
accessibility, regional compliance, desktop — Scope §13). These sit behind the
fixed Discovery sequence and the migration waves.

---

## 28. Bootstrap Instructions

Every session runs the handbook bootstrap before any work:

1. Read `CLAUDE.md`.
2. Read the handbook entry ([../README](../README.md)) and bootstrap protocol
   ([../00-BOOTSTRAP](../00-BOOTSTRAP.md)).
3. **Read this document and the Product Authority** ([README](README.md)) — the
   three pillars, the loop, and the **fixed Discovery sequence**. Do not drift to
   older priorities.
4. Read the current milestone and next approved mission ([../04-ROADMAP](../04-ROADMAP.md)).
5. Read governing ADRs ([../../adr/](../../adr/README.md)).
6. **Verify repository state** (`git log origin/master`, open PRs, `npm test &&
   npm run lint && npm run build` in `spotme/web`) against
   [../03-IMPLEMENTATION-STATUS](../03-IMPLEMENTATION-STATUS.md).
7. **Report mismatches before coding.** Never claim something works because a doc
   says so.
8. Implement the approved milestone only, dark by default, in stacked draft PRs;
   stop for owner review (G8, §25).

---

## 29. Repository References

- **Product authority:** `spotme/docs/handbook/product/` (this file · README ·
  DISCOVERY-PROGRAMME · CREATION-PILLAR · SPOTME_NEW_PRODUCT_SCOPE_2026-08-02).
- **Engineering handbook:** `spotme/docs/handbook/` (README · 00-BOOTSTRAP …
  10-CONTRADICTIONS-AND-GAPS).
- **ADRs:** `spotme/docs/adr/` (001–008 merged · 014–021 handbook-era ·
  009–013 reserved by draft PRs #40/#43).
- **Controlling engineering roadmap:** `spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md`.
- **Subsystem docs:** `spotme/docs/01-PRD.md` … `09-TECH-STACK.md`, audits `10`–`12`.
- **Code:** `spotme/web` (frontend), `spotme/backend` (API), `spotme/core`,
  `spotme/e2e`. Discovery V2: `web/src/lib/discovery-v2/` + `geo-approx.js`
  (PR #60). Live Events: `web/src/lib/live-events/` (PR #61).
- **External owner sources** (not yet committed verbatim):
  `Spot_Me_Product_Scope_and_Execution_Roadmap`,
  `SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY`, the approved **SpotMe Exchange** spec.

---

## 30. Glossary

- **Pillar** — one of the three flagship product areas: Communication, Discovery,
  Creation.
- **Product loop** — Create → Discover → Communicate → Create.
- **Discovery Programme** — the active "AI Discovery & Social Platform" work; a
  fixed five-step sequence.
- **SpotMe Exchange** — AI-matched local Needs and Offers (§14).
- **Need / Offer** — a request to fulfil / a capability or item on offer.
- **Built-off** — built, on a frozen branch, not advanced without authorisation.
- **Dark shipping** — flag-off, inert, tree-shaken, fence-tested (ADR-016).
- **Approximate location** — public position snapped to a coarse cell with a
  rotating bounded offset (ADR-018).
- **Provider-neutral** — normalised to stable Spot Me models; no vendor lock-in
  (ADR-017).
- **Fence test** — a build-enforced proof a foundation is dark and not wired in.
- **Six-state model** — Implemented (Merged) / Implemented (Draft PR) / In
  Progress / Planned / Deferred / Retired.
- **Strangler migration** — incremental replacement of vertical slices toward the
  canonical target architecture, not a single rewrite.
- **Definition of Done** — production-ready criteria (§25); dark modules alone are
  never "done".
- **ADR** — Architecture Decision Record; Accepted ADRs are immutable (G6).

---

## 31. Execution-Order Conflict — OWNER RATIFICATION REQUIRED

Three sources give **conflicting execution orders**. This section records all
three verbatim-where-available and deliberately **does not pick a winner** —
the owner must ratify one (or scope them to different layers).

**Source A — master's Owner Amendment (2026-08-01)**
(`spotme/docs/MASTER-ENGINEERING-ROADMAP-V2.md`, "Owner Amendment" section,
on `master`):

> "1. **Push notifications** — complete Android AND iOS push; … 2.
> **Translation platform** — … 3. **Live voice translation** — the flagship
> … 4. [adaptive communication layer] … 5. [remaining Priority 1 crypto
> (X3DH → Double Ratchet → multi-device → completion evidence)]" — with
> Priority 1's "remaining cryptography stays mandatory before Priority 1 is
> declared complete."

**Source B — this document (roadmap v2.0, §12, PR #63)**:

> "Smart Nearby Discovery Map → SpotMe Exchange → Live Nearby Events →
> Nearby Moments → AI Assistant & Personalization" — fixed, owner-controlled
> (ratified as ADR-022), with crypto gated behind the ADR-008 §12 hard stop
> (§11 standing gates) rather than sequenced among the Discovery steps.

**Source C — Scope Lock & Migration Blueprint v1.0**:

> **Not available in this session; owner to attach.** Per the owner's mission
> text (relayed instruction, not a document quote), the Blueprint orders
> "Map → Exchange → Events → Moments → AI" with **crypto at Phase 8**. It has
> not been reconstructed from memory here; ratification requires the actual
> document.

The three orders cannot all be followed: A sequences platform pillars
(push → translation → voice → transport → crypto) with no Discovery steps;
B sequences Discovery with crypto held behind a gate; C (as relayed)
sequences Discovery with crypto explicitly late (Phase 8). **OWNER
RATIFICATION REQUIRED** — until then, sessions must treat A as the standing
order for platform pillars (it is the only one on `master`) and B for
Discovery-internal ordering, and must not begin crypto work under any
reading (ADR-008 §12).

### Status-vocabulary note — OWNER DECISION REQUIRED

Two six-state vocabularies now exist: the **handbook's repo-level six**
(Implemented (Merged) / Implemented (Draft PR) / In Progress / Planned /
Deferred / Retired — evidence-cited against the repository) and the
**Blueprint's product-level six** (document not available in this session —
owner to attach). The owner must either pick a single vocabulary or scope
them explicitly (Blueprint states = product-level lifecycle; handbook states
= repository-level truth). Until then, the handbook vocabulary is the only
one used inside `spotme/docs/handbook/`.
