# 13 — Implementation Map

> Part of the [Discovery Platform Architecture Specification](README.md).
> Engineering spec — draft for owner review (stacked PR; documentation only,
> nothing here activates code). Numeric values are `[PROPOSED]` config defaults.

## 13.1 Purpose — the honest bridge from spec to code

This chapter maps every platform service to **what actually exists**, what does
not, and how the gap closes. Two rules govern it:

1. **Nothing below is on `master`.** All cited Discovery code lives on open,
   unmerged **draft PRs** (#60, #61 — stacked per
   [ADR-020](../../adr/020-stacked-pr-strategy.md)). The surface **engines**
   (`discovery-v2/*`, `live-events/*`) are dark even on their branches (flags
   OFF, fenced, tree-shaken —
   [ADR-015](../../adr/015-compile-time-feature-flags.md)/[016](../../adr/016-dark-shipping.md));
   the exception is `geo-approx.js` + the `discovery.js` presence boundary,
   which are **live-path privacy code** — not flag-gated, active the moment
   #60 merges (that is the point: they fix the v1 precise-GPS defect,
   [ADR-019](../../adr/019-discovery-v2-privacy-model.md)). Nothing
   Discovery-related runs in the product today. The authoritative what-is-real
   map is [03-IMPLEMENTATION-STATUS](../../handbook/03-IMPLEMENTATION-STATUS.md).
2. **Reuse before rebuild.** Where a dark module already proves a behaviour,
   the platform service adopts it (`[REUSE]`); green-field work is labelled as
   such and never described as existing.

## 13.2 Reuse map — existing dark modules → platform services

All rows: *Implemented (Draft PR)* — built, reviewed, dark, **NOT merged**.

**Draft PR #60 — Discovery V2 foundation** (`spotme/web/src/lib/…`):

| Module `[REUSE]` | Serves chapter(s) | What it proves |
|---|---|---|
| `geo-approx.js` — **live-path, not flag-gated** | [02](02-LOCATION-PRIVACY-ENGINE.md) | 500 m cell snap, 30 min rotating window, ≤150 m bounded offset, deterministic from (id, window); activates on #60 merge |
| `discovery-v2/contracts.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) · [10](10-API-CONTRACTS.md) | Result-state model and normalised result shapes |
| `discovery-v2/radius.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) | Adaptive ladder 10→100 km, min-result stop, epoch + AbortSignal cancellation |
| `discovery-v2/search.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) · [05](05-PROVIDER-ABSTRACTION.md) | Provider-neutral search orchestration, whitelist normalization |
| `discovery-v2/ranking.js` | [04](04-RANKING-SERVICE.md) | Deterministic weighted scoring, scoreBreakdown, id tie-break |
| `discovery-v2/mapstate.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) · [10](10-API-CONTRACTS.md) | Map/list single source of truth (one `selectedId`, immutable snapshots) |
| `discovery-v2/intent.js` | [06](06-AI-INTERFACES.md) | Deterministic query-intent seam — interface + keyword baseline, **no LLM, no network** |
| `discovery-v2/people.js` | [02](02-LOCATION-PRIVACY-ENGINE.md) | Privacy-safe markers: hidden ⇒ no marker, blocked filtered, `approximate: true` only |
| `discovery-v2/directions.js` | [05](05-PROVIDER-ABSTRACTION.md) | Directions honesty: no invented ETA; straight-line only ever labelled as such |
| `discovery-v2/flags.js`, `index.js` | [11](11-FLAGS-CONFIG-OBSERVABILITY.md) | Layered compile-time flags, hard master gate, inert-when-dark engine factory |

**Draft PR #61 — Live Nearby Events** (stacked on #60; `spotme/web/src/lib/…`):

| Module `[REUSE]` | Serves chapter(s) | What it proves |
|---|---|---|
| `live-events/contracts.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) · [10](10-API-CONTRACTS.md) | Event states + result states shared with Discovery V2 |
| `live-events/time.js` | [08](08-DATA-AND-CACHING.md) | UTC-instant lifecycle, source-wins state rules, injected `now`, freshness/TTL |
| `live-events/ranking.js` | [04](04-RANKING-SERVICE.md) | Second weight profile (time/distance/relevance/popularity) on the same discipline |
| `live-events/safety.js` | [02](02-LOCATION-PRIVACY-ENGINE.md) · [07](07-NOTIFICATION-SERVICE.md) | Blocking, unsafe-source removal, `assertNoOriginLeak` mutation guard |
| `live-events/search.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) · [05](05-PROVIDER-ABSTRACTION.md) | Cross-provider search + dedup over authorized sources |
| `live-events/detail.js` | [05](05-PROVIDER-ABSTRACTION.md) · [10](10-API-CONTRACTS.md) | Optional provider enrichment with honest `ready`/no-spinner semantics |
| `live-events/linking.js` | [03](03-INTENT-GRAPH-AND-SEARCH.md) | Cross-surface composition: events → places/map/directions via #60 primitives |
| `live-events/flags.js`, `index.js` | [11](11-FLAGS-CONFIG-OBSERVABILITY.md) | Same flag/fence pattern, proven twice |

**Prior art from other programmes** (dark, not Discovery code):

| Source | Draft PR(s) | Serves | Note |
|---|---|---|---|
| Push platform foundation + SDK packages | #52 / #48 | [07](07-NOTIFICATION-SERVICE.md) | Delivery transports the Discovery notification classes will ride; additive and inert today |
| Translation provider abstraction | #51 | [05](05-PROVIDER-ABSTRACTION.md) | **Precedent**, not shared code yet: routing/scoring/failover across providers — the pattern ch 05 generalises |

## 13.3 Gap map — no implementation exists

Green-field. Labelled honestly; nothing here may be described as built.

| Gap | Specified in | Note |
|---|---|---|
| **Intent Graph** — source registry, publish/consume contracts | [03](03-INTENT-GRAPH-AND-SEARCH.md) §3.2–§3.4 | The platform thesis itself; [ADR-023](../../adr/023-exchange-platform-service-intent-graph.md) is **Proposed**, not Accepted |
| **Runtime configuration service** — three classes, validation, audit | [11](11-FLAGS-CONFIG-OBSERVABILITY.md) | Only compile-time flags exist today |
| **Notification outbox + Discovery notification classes** | [07](07-NOTIFICATION-SERVICE.md) | #48/#52 provide transports only; no outbox, no Discovery classes |
| **Offline compose/action queues for Discovery surfaces** | [09](09-OFFLINE-SYNC.md) | Messaging's IndexedDB media baseline is merged prior art, not Discovery code |
| **`packages/contracts` port** (typed, versioned, shared) | [10](10-API-CONTRACTS.md) | Target-architecture home; today's contracts are per-engine JS modules on draft branches |

## 13.4 Migration path — dark JS precursors → the TS monorepo

The existing modules are **behaviour-proven precursors**, not the destination.
The destination is the canonical target architecture (canonical migrated build memory
§2, reconciled in roadmap v2.0 §9): a TypeScript monorepo —
`apps/{web,api,workers}`, `packages/{contracts,provider-sdk,domain}` — reached
by the **strangler waves 0–10** (§3), of which **Wave 8 is Discovery, events
and the local social feed**.

```
  today (draft PRs #60/#61)                target (Wave 8)
  vanilla-JS dark modules      ──port──▶   TS monorepo services
  spotme/web/src/lib/…                     packages/contracts · apps/api
  behaviour-proven, fenced                 same behaviour, same tests, dark
```

**Porting rule (binding):**

1. **Contracts first.** The typed contract lands in `packages/contracts`
   before any service is ported; client and server import the same shape
   (no duplicated domain contracts — canonical migrated build memory §2.1).
2. **Behaviour-identical ports, pinned by the SAME deterministic tests.** The
   existing test suites (injected clock/seed/config, mutation guards,
   invariant pins) travel to the port and must pass unchanged in meaning —
   the port is proven equivalent, not rewritten on trust.
3. **Fence tests travel with the code.** Every ported subsystem keeps its
   `*-not-shipped` fence; dark stays provable in the new home
   ([ADR-016](../../adr/016-dark-shipping.md)).

## 13.5 Build sequencing — surfaces over shared services

The owner-controlled **five-step order** is fixed
([DISCOVERY-PROGRAMME](../../handbook/product/DISCOVERY-PROGRAMME.md);
roadmap v2.0 §12; [ADR-022](../../adr/022-discovery-execution-sequence.md)
Proposed). Each step builds **on the shared services, never around them**:

| Step | Surface | Platform work it lands |
|---|---|---|
| 1 | **Smart Nearby Discovery Map** — harden the #60 foundation | Location & Privacy Engine, search/radius, ranking, flags become platform services |
| 2 | **SpotMe Exchange** — **only after A5 ratification** ([Exchange PRD 13](../../handbook/product/exchange/13-ACCEPTANCE-AND-OPEN-QUESTIONS.md) §13.1) | Intent Graph, matching workers, notification classes/outbox |
| 3 | **Live Nearby Events** — harden #61 on the platform services | Second ranking profile, provider dedup, event linking |
| 4 | **Nearby Moments** — incl. Camera integration via creator tools drawn from the **frozen** Camera & Studio branches (roadmap v2.0 §16; the frozen branches #55/#56/#58/#59 are not reopened) | Moments data/privacy ADR first; offline compose queue; moderation seams |
| 5 | **AI Assistant & Personalization** — **last, and only after Discovery data exists** to be assistive over; consent-based, interface-first | AI interface activation seams; opt-in personalization |

Delivery discipline for every step: **dark-first**, small **stacked draft PRs**
([ADR-020](../../adr/020-stacked-pr-strategy.md)), owner gates at each PR —
**no merge and no activation without owner authorisation**
(canonical migrated build memory §4/§6).

## 13.6 The DO-NOT-DUPLICATE rule

**A surface may never reimplement a common service.** No private geo math, no
per-surface ranking loop, no bespoke provider client, no surface-local flag
scheme, no second notification path. If a service is missing a capability, the
service is extended (its chapter updated in the same change — Governance G9);
the surface is not forked around it. One implementation, one test suite, one
audit point — this is the entire payoff of the platform
([01-PLATFORM-OVERVIEW](01-PLATFORM-OVERVIEW.md) §1.1).

**PR review checklist (apply to every Discovery PR):**

- [ ] No module re-derives cells/offsets outside
      [02-LOCATION-PRIVACY-ENGINE](02-LOCATION-PRIVACY-ENGINE.md) (`geo-approx`)
- [ ] No search/candidate loop outside the
      [03](03-INTENT-GRAPH-AND-SEARCH.md) orchestrator; every query is
      radius/cell-bounded
- [ ] No scoring outside [04-RANKING-SERVICE](04-RANKING-SERVICE.md); weights
      are config keys, not literals
- [ ] No direct provider/SDK call — ports/adapters only
      ([05](05-PROVIDER-ABSTRACTION.md)); `assertNoSecrets` passes
- [ ] No surface-local notification send — classes registered in
      [07](07-NOTIFICATION-SERVICE.md), delivery via the outbox
- [ ] No new datastore, no raw-coordinate column
      ([08](08-DATA-AND-CACHING.md))
- [ ] Contracts imported from the shared module/package, not redeclared
      ([10](10-API-CONTRACTS.md))
- [ ] Flags follow the layered pattern + hard master gate; fence test present
      ([11](11-FLAGS-CONFIG-OBSERVABILITY.md)); no hardcoded tunables
- [ ] Honest states only — no fabricated results, counts, ETAs; radius
      expansion disclosed

## 13.7 Acceptance gates — summary

A Discovery capability is **done** only per the platform **Definition of Done**
(roadmap v2.0 §25; canonical migrated build memory §5) — never because dark modules or
interfaces exist:

- **Fence tests** prove every dark subsystem unreachable and tree-shaken until
  its owner-authorised activation ([ADR-016](../../adr/016-dark-shipping.md)).
- **Definition of Done:** wired behind reviewed flags · real credentials in
  staging · real devices/browsers · security and privacy ratified · cost
  ceilings configured · monitoring live · **rollback executed** · staged
  rollout evidence · **owner approves activation**.
- **Scale gates:** load/soak/chaos evidence per
  [12-SCALABILITY](12-SCALABILITY.md) §12.9.
- **Wave-8 exit criteria** (canonical migrated build memory §3) — before Discovery
  activates: **privacy threat model · provider licensing · ranking fairness ·
  location-abuse controls** all pass.

## 13.8 Deterministic testing

The map itself is pinned: reuse rows cite modules whose suites inject
clock/seed/config and carry mutation guards (`assertNoOriginLeak`, no-precise-
coordinate, proximity-outranks-popularity); ports under §13.4 must keep those
suites green unchanged; fence tests (`*-not-shipped`) exist for every dark
subsystem and travel with every port. A PR that weakens or drops a pinned test
fails review by definition (§13.6 checklist).
