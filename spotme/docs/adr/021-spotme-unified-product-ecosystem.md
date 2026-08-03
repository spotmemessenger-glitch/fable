# ADR-021 — SpotMe Unified Product Ecosystem

**Status:** Accepted (2026-08-03). Owner directive. Separates long-term product
architecture from implementation detail; the single architectural reference for
how Spot Me's surfaces fit together.

## Context

Spot Me has grown from a proximity messenger into a multi-surface product
(communication, discovery, creation). Without one architectural reference,
future sessions drift back to older roadmap priorities or treat the surfaces as
unrelated apps. Product scope and implementation status also blur. This ADR
fixes the product architecture; it does **not** claim anything is built (see
[handbook/03-IMPLEMENTATION-STATUS](../handbook/03-IMPLEMENTATION-STATUS.md)).

## Decision

Spot Me is **one product, three flagship pillars, one loop**:

- **Communication is the core** — messaging, calls, translation, identity.
- **Discovery is the intelligence layer** — privacy-first local discovery
  (map, events, moments, assistant).
- **Creation is the content engine** — camera, studio, vision, photos, videos,
  stories, reels — whose output **feeds Discovery** via Nearby Moments.
- **The lifecycle is `Create → Discover → Communicate → Create`** — the pillars
  are one loop, not three apps.

**The Discovery execution sequence is fixed:**
1. Smart Nearby Discovery Map → 2. Live Nearby Events → 3. Nearby Moments →
4. AI Assistant & Personalization. Sessions do not reorder or skip it.

**Privacy-first local discovery is a non-negotiable design principle:** precise
GPS is always device-local; public locations are approximate by default;
provider-neutral; compile-time dark shipping; consent-based, non-sensitive-
inferring personalization; sponsored content always labeled; never fabricate
ETAs/directions; deterministic tests for privacy-sensitive logic.

This ADR is the product-architecture reference. It **supersedes ad-hoc priority
ordering** where it conflicts, but does **not** override the ADR-008 §12 hard
stop or the standing owner directives in
[handbook/09-OWNER-DECISIONS](../handbook/09-OWNER-DECISIONS.md).

## Consequences

- Every session shares one product model and one fixed Discovery order.
- Creation is preserved (not removed); its frozen foundations wait behind the
  Discovery sequence, with a defined product purpose (feeding Nearby Moments).
- Product direction (this ADR + the product-authority docs) is cleanly separated
  from implementation status (the six-state map).
- A change to the pillars, the loop, or the fixed sequence requires a **new ADR**
  (G6) — this one is immutable once Accepted.

## Evidence

Owner directive (2026-08-03); product authority in
[handbook/product/](../handbook/product/README.md); the verbatim scope doc
`handbook/product/SPOTME_NEW_PRODUCT_SCOPE_2026-08-02.md`. Related decisions:
ADR-015, ADR-016, ADR-017, ADR-018, ADR-019.
