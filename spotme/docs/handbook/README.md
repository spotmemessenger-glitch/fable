# Spot Me — Engineering Handbook v1.0

**The repository is the single source of truth.** This handbook replaces
project memory that used to live in chat history and temporary handoff files.
After it is merged, any engineer — human or a fresh Claude Code session — can
understand Spot Me by reading the repository alone.

> **Verified against the repository on 2026-08-03**, at `master` =
> `31e1894` (`docs: owner amendment 2026-08-01 — execution order (#37)`).
> Every status claim in §03 cites its evidence (a merged commit or an open PR).
> Where the repository is silent, this handbook says so rather than inventing an
> answer (see [10-CONTRADICTIONS-AND-GAPS](10-CONTRADICTIONS-AND-GAPS.md)).

## How to read this (start here every session)

1. **[00-BOOTSTRAP](00-BOOTSTRAP.md)** — the session bootstrap protocol. A fresh
   session runs this *before* writing any code.
2. **[01-PRODUCT-VISION](01-PRODUCT-VISION.md)** — what Spot Me is; the
   three-pillar architecture.
3. **[02-ARCHITECTURE](02-ARCHITECTURE.md)** — frontend, backend, subsystems,
   and honest stubs for the parts not yet built.
4. **[03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md)** — every feature in
   exactly one of six states, **with evidence**. The authoritative "what is
   real" map.
5. **[04-ROADMAP](04-ROADMAP.md)** — the five named phases, the current
   milestone, and the next approved mission.
6. **[05-GOVERNANCE](05-GOVERNANCE.md)** — the rules (G1–G9) that apply before
   and during any change.
7. **[06-CODING-STANDARDS](06-CODING-STANDARDS.md)** · **[07-TESTING-AND-CICD](07-TESTING-AND-CICD.md)**
   · **[08-SECURITY-AND-PRIVACY](08-SECURITY-AND-PRIVACY.md)**
8. **[09-OWNER-DECISIONS](09-OWNER-DECISIONS.md)** — standing owner directives
   and open decisions.
9. **[10-CONTRADICTIONS-AND-GAPS](10-CONTRADICTIONS-AND-GAPS.md)** — where the
   repository disagrees with itself, and what is genuinely undocumented.

**Product authority** lives in **[product/](product/README.md)**; its canonical
top-level document is
**[Product Scope & Execution Roadmap v2.0](product/SPOT-ME-PRODUCT-ROADMAP-V2.md)**
— the three flagship pillars (Communication · Discovery · Creation), the
`Create → Discover → Communicate` loop, the current active programme and its
fixed five-step Discovery execution order (incl. **SpotMe Exchange**), the
product constitution, privacy/AI architecture, and revenue direction. Read it
alongside the engineering pages: product authority says *what we build toward*;
§03 says *what is actually built*.

Architectural decisions live in **[../adr/](../adr/README.md)** (immutable once
Accepted) — including **[ADR-021](../adr/021-spotme-unified-product-ecosystem.md)**,
the unified product-ecosystem reference (ADR-022/023 are drafted **Proposed**,
awaiting owner ratification).

**Platform specifications** (engineering blueprints) live under
**[../architecture/](../architecture/discovery-platform/README.md)** — currently
the **Discovery Platform Architecture Specification**, the shared-services
blueprint for Map, Exchange, Events and Moments.

## Relationship to existing docs

This handbook is the **navigational and status layer**. It does not replace the
detailed engineering documents already in `spotme/docs/`; it points to them and
records their status honestly:

- **[MASTER-ENGINEERING-ROADMAP-V2.md](../MASTER-ENGINEERING-ROADMAP-V2.md)** —
  the controlling engineering roadmap (owner-approved). Its Priority 1–13 detail
  remains authoritative; §04 here maps those priorities onto five named phases
  so future sessions have one consistent vocabulary.
- `01-PRD.md`, `02-SYSTEM-ARCHITECTURE.md`, `03-DATABASE-SCHEMA.md`,
  `04-API-DOCUMENTATION.md`, `05-DESIGN-SYSTEM.md`, `07-SECURITY-PLAN.md`,
  `08-TESTING-STRATEGY.md`, `09-TECH-STACK.md` — subsystem detail.
- Audits: `10-PRIORITY-0-AUDIT.md`, `11-PR2-MIGRATION-AUDIT.md`,
  `12-PRIORITY-1-BASELINE.md`.

## Maintenance

This handbook is kept current in place — see **G9** in
[05-GOVERNANCE](05-GOVERNANCE.md). The old `.handoff/NEXT-SESSION.md` mechanism
is **Retired** (see §03 and the retirement banner in that file).
