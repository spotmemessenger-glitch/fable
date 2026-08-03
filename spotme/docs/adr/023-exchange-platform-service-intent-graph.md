# ADR-023 — Exchange as a platform service: the universal Intent Graph

**Status:** Proposed (2026-08-03) — **awaiting owner ratification.** Records the
owner's architectural directive from the PR #64 review.

## Context

SpotMe Exchange (AI-matched local Needs & Offers) could be built as a
self-contained module — its own compose UI, its own store, its own search. The
owner directed otherwise: "Exchange should not become a module. It should become
a platform service… eventually everything should publish into Exchange," turning
it into a **universal Intent Graph**, and Spot Me should organize information
**by intent, not by type**.

## Decision

1. **Exchange is a platform service.** It exposes **publish/consume intent
   contracts** (a service boundary), not just a UI. Every Spot Me surface can
   publish intents into it: Discovery Map → nearby business; Nearby Events →
   tickets; Nearby Moments → "I have camping gear"; Business Platform →
   inventory; Communities → "volunteer needed"; Messaging → a friend's
   consented "needs a charger". New sources integrate via the contract — the
   core architecture does not change as sources grow.
2. **Unified search organizes by intent, not type.** One query ("I need a
   turbocharger") searches businesses, individuals, marketplace items, nearby
   requests, groups, friends' consented shares, inventory, events and AI
   recommendations, and returns *the nearest solution* — a single type-agnostic
   ranked answer, not type-siloed lists.
3. **Every published intent inherits the platform invariants** regardless of
   source surface: approximate location only (ADR-018/019), consent gates, no
   sensitive inference, provider-neutrality (ADR-017), dark shipping until
   activation (ADR-015/016), transparent proximity-first ranking.

The realising architecture (intent record, source registry, routing, unified
search pipeline) is specified in the Discovery Platform Architecture
Specification (`../architecture/discovery-platform/`), ch. 03.

## Consequences

- Exchange's contracts are designed for N sources from day one, even though v1
  ships with Exchange's own compose as the only publisher.
- Surfaces integrate with Exchange by contract, never by reaching into its
  internals; the DPAS do-not-duplicate rule applies.
- Intent-first search becomes the platform's distinctive abstraction; ranking
  stays transparent and proximity-first across heterogeneous result kinds.

## Evidence

Owner review of PR #64 (2026-08-03); Exchange PRD §1.8
(`../handbook/product/exchange/01-CONCEPT-AND-SCOPE.md`); roadmap v2.0 §14.
