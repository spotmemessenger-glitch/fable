# Spot Me — Product Authority

**This is the product-authority layer of the handbook.** It sits *beside* the
engineering handbook: the engineering handbook says how we build and what is
*real* (with evidence); the product authority says what we are building toward.
When the two describe the same surface, the engineering
[03-IMPLEMENTATION-STATUS](../03-IMPLEMENTATION-STATUS.md) is authoritative for
*what is actually built* — product scope is not an implementation claim.

> **The highest-level product authority is
> [SPOT-ME-PRODUCT-ROADMAP-V2](SPOT-ME-PRODUCT-ROADMAP-V2.md)** (Product Scope &
> Execution Roadmap v2.0). It is the canonical, complete product document and
> **replaces** `SPOTME_NEW_PRODUCT_SCOPE_2026-08-02` as *authority* — the scope
> doc is preserved beside it as a historical **source**, not authority. Read v2.0
> first; the pages below are its supporting detail.

> Canonical product sources (owner):
> - **[SPOTME_NEW_PRODUCT_SCOPE_2026-08-02](SPOTME_NEW_PRODUCT_SCOPE_2026-08-02.md)**
>   — verbatim owner scope (committed here).
> - **Spot_Me_Product_Scope_and_Execution_Roadmap** — owner product/execution
>   roadmap. Its execution decisions are captured in
>   [DISCOVERY-PROGRAMME](DISCOVERY-PROGRAMME.md); the verbatim document should be
>   committed here when provided (tracked in
>   [../10-CONTRADICTIONS-AND-GAPS](../10-CONTRADICTIONS-AND-GAPS.md)).
> - Implementation must follow the canonical migrated architecture document
>   (`SPOTME_CANONICAL_MIGRATED_BUILD_MEMORY`, owner upload) — referenced by the
>   scope doc; not yet committed to the repo.

## The three flagship pillars

Spot Me is one product built on three flagship pillars:

1. **Communication** — the core. Fast, dependable, private messaging: chats,
   groups, communities, channels; media, calls, voice notes; translation and
   voice-preserving translation; adaptive transport; strong E2EE identity.
2. **Discovery** — the intelligence layer. Privacy-first local discovery: the
   Smart Nearby Discovery Map, Live Nearby Events, Nearby Moments, and (later)
   an AI assistant — always approximate-by-default and provider-neutral.
3. **Creation** — the content engine. AI Camera, Creative Studio, AI Vision,
   Photos, Videos, Stories, Reels — whose output later *feeds* Discovery via
   Nearby Moments.

## The product loop

```
        Create ──▶ Discover ──▶ Communicate ──▶ Create ──▶ …
     (Creation)   (Discovery)  (Communication)
```

People **create** (camera/studio), that content is surfaced through
**discovery** (nearby moments/map/events), which sparks **communication**
(chats/knocks), which motivates more **creation**. Creation feeds Discovery;
Discovery feeds Communication; Communication feeds Creation. The three pillars
are one loop, not three apps.

## How this relates to the PRD's design pillars

The PRD's three pillars — **proximity, language, honesty**
([01-PRODUCT-VISION](../01-PRODUCT-VISION.md)) — are the enduring **design law**
(how every surface must behave). The three flagship pillars above are the
**product structure** (what the surfaces are). They are complementary, not
competing: every flagship pillar is held to proximity-without-surveillance,
language-first, and honesty.

## Contents

- **[DISCOVERY-PROGRAMME](DISCOVERY-PROGRAMME.md)** — the current active
  programme, the fixed execution order, the discovery principles, and the
  record-but-don't-activate future scope.
- **[CREATION-PILLAR](CREATION-PILLAR.md)** — the Creation pillar and its
  implementation status.
- **[SPOTME_NEW_PRODUCT_SCOPE_2026-08-02](SPOTME_NEW_PRODUCT_SCOPE_2026-08-02.md)**
  — verbatim owner scope.
- **[exchange/](exchange/README.md)** — the **SpotMe Exchange PRD** (the dedicated
  engineering blueprint for Discovery step 2; a reconstruction pending A5
  ratification).

The architectural decision that formalises this ecosystem is
**[ADR-021](../../adr/021-spotme-unified-product-ecosystem.md)**.
