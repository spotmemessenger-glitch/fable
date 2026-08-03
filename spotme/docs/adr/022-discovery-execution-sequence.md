# ADR-022 — Discovery execution sequence (five steps)

**Status:** Proposed (2026-08-03) — **awaiting owner ratification.** The owner
explicitly reserved this decision ("Ratify ADR-022 if you decide the Discovery
sequence changes permanently"). Supersedes the *sequence portion* of
[ADR-021](021-spotme-unified-product-ecosystem.md) when Accepted; ADR-021 itself
remains immutable and otherwise in force.

## Context

ADR-021 recorded a four-step Discovery execution sequence (Map → Events →
Moments → Assistant). On 2026-08-03 the owner inserted **SpotMe Exchange** —
AI-matched local Needs & Offers, judged the product's biggest differentiator —
as step 2 (Product Scope & Execution Roadmap v2.0 §12/§14). Per G6, an Accepted
ADR is never edited; a superseding ADR records the change.

## Decision

The Discovery Programme's implementation sequence is **fixed, owner-controlled,
and five steps**:

1. **Smart Nearby Discovery Map**
2. **SpotMe Exchange**
3. **Live Nearby Events**
4. **Nearby Moments**
5. **AI Assistant & Personalization**

Sessions do not reorder or skip steps. Changing the sequence again requires a
new superseding ADR and an explicit owner decision.

## Consequences

- Exchange implementation follows Map hardening and precedes Events activation
  work; it may not begin until its PRD is ratified (gap A5).
- Step 5 runs last deliberately — personalization only after Discovery data
  exists.
- All other ADR-021 content (three pillars, the product loop, privacy-first
  non-negotiables) is unchanged and still binding.

## Evidence

Owner decisions of 2026-08-03 (roadmap v2.0 §12/§26; PR #63/#64 reviews);
handbook gap C4 (`../handbook/10-CONTRADICTIONS-AND-GAPS.md`).
