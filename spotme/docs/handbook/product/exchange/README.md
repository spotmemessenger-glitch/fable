# SpotMe Exchange — Product Requirements Document (PRD)

**The dedicated specification for SpotMe Exchange**, the AI-matched local
**Needs & Offers** capability — Discovery Programme step 2 and Spot Me's biggest
differentiator. This PRD is the engineering blueprint for Exchange: build from
it, not from chat history.

**Architecturally, Exchange is a platform service, not a module** (owner
directive, 2026-08-03): a universal **Intent Graph** that every Spot Me surface
publishes into — see §1.8 of the concept chapter. Its engineering foundation is
specified in the Discovery Platform Architecture Specification (separate stacked
PR).

> ## ⚠ SOURCING & RATIFICATION (gap A5 — read first)
>
> **No owner-approved SpotMe Exchange specification existed in any available
> source** (Engineering Handbook, Product Authority, roadmap v2.0,
> `SPOTME_NEW_PRODUCT_SCOPE_2026-08-02`, `SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY`,
> or the repository). This PRD is therefore a **reconstruction**, authored per
> owner direction (2026-08-03) from (a) the twelve components the owner named for
> Exchange and (b) Spot Me's established, already-approved design principles
> (ADR-015–021, the product constitution). **Every substantive decision here is
> PENDING RATIFICATION** against the owner's approved spec.
>
> - Treat this as a *proposal to ratify*, not settled fact. Reconcile it against
>   the approved Exchange spec when provided; where they differ, the approved
>   spec wins.
> - Numeric values (radii, weights, TTLs, thresholds, limits) are **proposed
>   defaults**, clearly labeled `[PROPOSED]`, chosen for testability — not final.
> - This closes gap A5 by **replacing "no spec" with "a ratifiable draft spec"**;
>   A5 remains open until the owner ratifies. (Handbook §10; roadmap v2.0 §14/§26.)
>
> **Documentation only.** No code, no activation, no runtime change. When built,
> Exchange ships **dark** (flag-off, fenced, tree-shaken) like every foundation.

## Contents

| # | Chapter | Covers |
|---|---|---|
| 00 | [Overview & Sourcing](README.md) | This page — scope of the PRD, A5, how to read it |
| 01 | [Concept, Scope & Personas](01-CONCEPT-AND-SCOPE.md) | What Exchange is, Need/Offer, goals/non-goals, personas, success metrics |
| 02 | [UX & Screens](02-UX-AND-SCREENS.md) | Complete UX, screen inventory, primary flows |
| 03 | [State Diagrams & Lifecycle](03-STATE-DIAGRAMS.md) | Need/Offer/Match/Handoff state machines, transitions |
| 04 | [Matching, AI Search & Ranking](04-MATCHING-AND-RANKING.md) | Intent matching, unified search, adaptive radius, ranking formulas |
| 05 | [Notifications](05-NOTIFICATIONS.md) | Notification classes, triggers, rules, privacy |
| 06 | [Moderation, Safety & Fraud](06-MODERATION-AND-FRAUD.md) | Moderation pipeline, abuse/fraud prevention, safety |
| 07 | [Privacy Architecture](07-PRIVACY.md) | Location privacy, consent, minimization, retention |
| 08 | [API Contracts](08-API-CONTRACTS.md) | REST + realtime contracts, provider-neutral ports |
| 09 | [Database Schema](09-DATABASE-SCHEMA.md) | Entities, relations, indexes, migrations |
| 10 | [Business Participation & Reputation](10-BUSINESS-AND-REPUTATION.md) | Business Offers, verification, reputation/trust |
| 11 | [Edge Cases & Offline](11-EDGE-CASES-AND-OFFLINE.md) | Failure modes, edge cases, offline behaviour |
| 12 | [Scalability & Performance](12-SCALABILITY.md) | Scale, latency/cost budgets, capacity |
| 13 | [Acceptance & Open Questions](13-ACCEPTANCE-AND-OPEN-QUESTIONS.md) | Acceptance gates, ratification checklist, open owner decisions |

## Relationship to other documents

- **Product authority:** roadmap v2.0 [§14 SpotMe Exchange](../SPOT-ME-PRODUCT-ROADMAP-V2.md);
  Discovery sequence [DISCOVERY-PROGRAMME](../DISCOVERY-PROGRAMME.md) (Exchange = step 2).
- **Principles/ADRs:** ADR-015 (flags), ADR-016 (dark shipping), ADR-017
  (provider-neutral), ADR-018 (location grid), ADR-019 (Discovery privacy),
  ADR-021 (product ecosystem). See [../../../adr/](../../../adr/README.md).
- **Target architecture:** the canonical TypeScript monorepo (NestJS/Prisma/
  Postgres, `packages/{contracts,provider-sdk,domain}`), reconciled in roadmap
  v2.0 §9/§11. Exchange targets that architecture; where current code exists
  (Discovery V2 primitives, PR #60), it is reused.

## Conventions

- `[PROPOSED]` — a value/decision chosen for this draft; owner to ratify.
- `[REUSE]` — reuses an existing, approved Spot Me primitive.
- **Configuration principle (owner directive, 2026-08-03):** this PRD fixes
  *behaviour*; numeric values (radii, ranking weights, TTLs, notification
  thresholds, rate limits) are **runtime configuration with safe defaults**,
  tunable without architectural change. Every `[PROPOSED]` number is the
  proposed *default* for a configuration key — never a constant to hardcode.
  Privacy-critical values stay owner-governed (Discovery Platform Architecture
  Specification, ch. 11 — separate stacked PR).
- **Proximity outranks popularity**, **honesty over fabricated convenience**, and
  **privacy is non-negotiable** — the constitution binds every chapter.
