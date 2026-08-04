# Discovery Platform Architecture Specification (DPAS)

> **Engineering spec — Layer 3 (platform specification) of the four-layer
> model. DRAFT for owner review** (stacked PR; **documentation only** — nothing
> in this specification activates code, changes a flag, or alters runtime
> behaviour). Numeric values are `[PROPOSED]` config defaults, not constants.

This specification defines the **common platform services** that every
Discovery surface uses. The [Exchange PRD](../../handbook/product/exchange/README.md)
says *what the product does*; the DPAS says *what the platform provides* so
that five surfaces can be built on **one shared foundation** instead of five
private stacks.

## Purpose

The Discovery Programme delivers five surfaces in a fixed, owner-controlled
order ([DISCOVERY-PROGRAMME](../../handbook/product/DISCOVERY-PROGRAMME.md)):

1. **Smart Nearby Discovery Map** — built dark (draft PR #60)
2. **SpotMe Exchange** — planned; PRD exists, pending A5 ratification
3. **Live Nearby Events** — built dark (draft PR #61)
4. **Nearby Moments** — planned (next approved mission after the handbook merges)
5. **AI Assistant & Personalization** — planned, consent-based, interface-first

Each surface needs location privacy, search, ranking, providers, notifications,
caching, offline behaviour, contracts, and flags. Building those five times
would multiply cost and — worse — multiply the places a privacy invariant can
break. The DPAS therefore specifies each concern **once**, as a platform
service with a stable contract, and every surface consumes it. One privacy
boundary, one ranking discipline, one provider seam, one configuration model —
audited in one place.

## The four-layer model

| Layer | Document | Answers | Where |
|---|---|---|---|
| 1 | **Engineering Constitution** — Engineering Handbook (PR #62) | How we work: states, governance, evidence | [../../handbook/](../../handbook/README.md) |
| 2 | **Product Constitution** — Product Scope & Execution Roadmap v2.0 (PR #63) | What we build toward, in what order, under what principles | [../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md](../../handbook/product/SPOT-ME-PRODUCT-ROADMAP-V2.md) |
| 3 | **Platform Specifications** — Exchange PRD (PR #64) + **this DPAS** | What one capability/platform does, precisely enough to build | [../../handbook/product/exchange/](../../handbook/product/exchange/README.md) · this directory |
| 4 | **Implementation** — code, in small stacked dark PRs | What actually runs (or ships dark) | e.g. draft PRs #60/#61 |

Lower layers must conform to the layers above them. Where this spec and an
Accepted ADR disagree, the ADR wins until superseded (Governance G6).

## Contents

| # | Chapter | Covers |
|---|---|---|
| 01 | [Platform Overview](01-PLATFORM-OVERVIEW.md) | Shared-foundation thesis, service inventory, the Intent Graph, current state, non-goals |
| 02 | [Location & Privacy Engine](02-LOCATION-PRIVACY-ENGINE.md) | Device-local GPS, approximation grid, hidden mode, privacy invariants |
| 03 | [Intent Graph & Search Orchestration](03-INTENT-GRAPH-AND-SEARCH.md) | Intent publish/consume contracts, intent routing, unified search, adaptive radius |
| 04 | [Ranking Service](04-RANKING-SERVICE.md) | Transparent deterministic ranking, weight profiles, invariants |
| 05 | [Provider Abstraction](05-PROVIDER-ABSTRACTION.md) | Ports/adapters, normalization, failover, no-secrets discipline |
| 06 | [AI Interfaces](06-AI-INTERFACES.md) | Assistive, interface-first AI seams; no LLM activation |
| 07 | [Notification Service](07-NOTIFICATION-SERVICE.md) | Match/digest notifications, thresholds, privacy-safe payloads |
| 08 | [Data & Caching](08-DATA-AND-CACHING.md) | Database boundaries, caching, TTLs, retention |
| 09 | [Offline Synchronization](09-OFFLINE-SYNC.md) | Offline behaviour, IndexedDB, reconciliation |
| 10 | [API Contracts](10-API-CONTRACTS.md) | Versioned request/response and event contracts, result states |
| 11 | [Feature Flags, Configuration & Observability](11-FLAGS-CONFIG-OBSERVABILITY.md) | Compile-time flags vs runtime config, config classes, audit, telemetry |
| 12 | [Scalability](12-SCALABILITY.md) | Load model, budgets, capacity direction within v1 datastore limits |
| 13 | [Implementation Map](13-IMPLEMENTATION-MAP.md) | Reuse of dark code, migration to the target architecture, sequencing, gates |
| 14 | [Privacy & Abuse Threat Model](14-PRIVACY-ABUSE-THREAT-MODEL.md) | Formal Phase 2 threat model — assets, 18 threats, fence/type-enforced controls, residual risks |
| 15 | [Performance & Capacity (Measured)](15-PERFORMANCE-AND-CAPACITY.md) | Checkpoint 13 measurements — 1M-profile PostGIS + Typesense runs, pagination stability, client timings, measured limits and scaling triggers (nothing extrapolated) |
| 16 | [Operations Runbook](16-OPERATIONS-RUNBOOK.md) | Dark-foundation runbooks — provider/PostGIS/realtime degradation, stale presence sweep, privacy incident response, immediate dark rollback |

## Conventions

- **`[PROPOSED]`** — a configuration default proposed by this spec; the owner
  ratifies it. Never a constant to hardcode.
- **`[REUSE]`** — an existing primitive from real code, cited with its
  repository path (e.g. `[REUSE] spotme/web/src/lib/geo-approx.js`). Where the
  cited code lives on a draft-PR branch (not master), the chapter says so.
- **The Configuration Principle** (owner directive, 2026-08-03), reconciled
  with [ADR-015](../../adr/015-compile-time-feature-flags.md):
  - **The spec fixes behaviour.** Algorithms, invariants, privacy boundaries,
    and contracts are specification, not tunables.
  - **Numbers are runtime configuration with safe defaults.** Radii, weights,
    TTLs, thresholds, and limits are named config keys (chapter
    [11](11-FLAGS-CONFIG-OBSERVABILITY.md)) whose defaults are `[PROPOSED]`
    here. Tuning an activated feature never requires a code change.
  - **Activation stays compile-time** per ADR-015/016: flags default false,
    hard master gate, tree-shaken, fence-tested. Runtime config can *tune* a
    live feature; it can never *turn on* a dark one.
  - **Three config classes:** `privacy-critical` (owner-governed — e.g. the
    privacy cell/window/offset 500 m / 30 min / 150 m), `product`
    (product-tunable), `ops` (SRE-tunable). Every change is validated against
    invariants (weights sum to 1; proximity outranks popularity; radius steps
    strictly ascending; TTL/retention bounds) and audited.
- One `#` title per chapter; sections numbered `n.x` after the chapter number;
  cross-references use exact sibling filenames.

## Relationship to other documents

- **Exchange PRD** ([../../handbook/product/exchange/](../../handbook/product/exchange/README.md))
  — the *product-focused* specification of SpotMe Exchange (UX, lifecycle,
  matching, moderation, schema). The DPAS is the *engineering* counterpart:
  Exchange's Intent Graph is specified here as a platform service
  ([03-INTENT-GRAPH-AND-SEARCH](03-INTENT-GRAPH-AND-SEARCH.md)) that all five
  surfaces publish into, per the owner directive. Where the PRD and DPAS state
  the same default, they use the same config key.
- **ADRs** ([../../adr/](../../adr/README.md)) — this spec binds itself to the
  Accepted decisions [014](../../adr/014-repository-over-memory.md)
  (repository over memory), [015](../../adr/015-compile-time-feature-flags.md)
  (compile-time flags), [016](../../adr/016-dark-shipping.md) (dark shipping,
  fences), [017](../../adr/017-provider-neutral-adapters.md) (provider-neutral
  adapters), [018](../../adr/018-deterministic-location-grid.md) (deterministic
  location grid), [019](../../adr/019-discovery-v2-privacy-model.md)
  (Discovery V2 privacy), [020](../../adr/020-stacked-pr-strategy.md) (stacked
  PRs), and [021](../../adr/021-spotme-unified-product-ecosystem.md) (unified
  ecosystem). [ADR-022](../../adr/022-discovery-execution-sequence.md)
  (five-step sequence) and
  [ADR-023](../../adr/023-exchange-platform-service-intent-graph.md) (Exchange
  as platform service / Intent Graph) were **ratified by the owner 2026-08-03**
  and are Accepted; this spec conforms to both.
- **Canonical target architecture** (owner-controlled migrated build memory;
  reconciled in roadmap v2.0 §9/§11) — the TypeScript monorepo: React/Vite PWA
  (`apps/web`), NestJS/Prisma/PostgreSQL (`apps/api`), shared
  `packages/{contracts,provider-sdk,domain}`, migrated by **strangler waves
  0–10**. **Wave 8 is Discovery** (places, directions, events, adaptive
  radius, local social feed). The DPAS targets that architecture; the existing
  dark JavaScript foundations are the behavioural reference that migrates into
  it ([13-IMPLEMENTATION-MAP](13-IMPLEMENTATION-MAP.md)). Note the target
  memory lists PostGIS/H3 as long-term canonical stack; per the roadmap
  reconciliation and [01-PLATFORM-OVERVIEW §1.6](01-PLATFORM-OVERVIEW.md),
  Discovery v1 introduces **no** new geo datastore — discretized cells only.

## Current status — honest

**Only two surfaces have any implementation, and both are dark on unmerged
draft PRs:** the Discovery Map foundation (draft **PR #60** —
`spotme/web/src/lib/discovery-v2/` + `geo-approx.js`) and Live Nearby Events
(draft **PR #61**, stacked on #60 — `spotme/web/src/lib/live-events/`).
Neither is on `master`; nothing Discovery-related runs in the product.
Everything else in this specification — Exchange/Intent Graph, Moments,
AI Assistant, the notification/data/offline/config services — is **planned**,
with no code. Per-service detail:
[01-PLATFORM-OVERVIEW §1.5](01-PLATFORM-OVERVIEW.md); the authoritative
what-is-real map remains
[03-IMPLEMENTATION-STATUS](../../handbook/03-IMPLEMENTATION-STATUS.md).

## Maintenance

This spec is kept current in place (Governance G9,
[05-GOVERNANCE](../../handbook/05-GOVERNANCE.md)). When the owner ratifies,
amends, or rejects a `[PROPOSED]` default, the chapter that proposes it is
updated in the same change that records the decision — the repository, not
chat history, is the source of truth
([ADR-014](../../adr/014-repository-over-memory.md)).
