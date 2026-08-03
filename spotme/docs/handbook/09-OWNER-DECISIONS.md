# 09 — Owner Decisions

Standing owner directives (binding until changed) and the open decisions each
phase is waiting on. Source: owner messages recorded in PRs #35/#37/#38, the
Roadmap V2 Owner Amendment, and the mission briefs.

## Standing directives (binding)

1. **Roadmap V2 is the controlling engineering document** (approved 2026-08-01,
   #35). Its §2 rules, §5 priorities, §8 checklist, §10 instructions apply.
   Where V1 is stricter, the stricter gate still holds (V2 Appendix B).
2. **Execution order** (Owner Amendment 2026-08-01, #37): ① push notifications →
   ② translation platform → ③ live voice translation → ④ adaptive communication
   layer → ⑤ remaining Priority-1 crypto. Renumbering V1↔V2 is **not** an unblock.
3. **ADR-008 §12 hard stop** on signing-key generation/publication and the crypto
   ratchet stack — unchanged by V2. (See [08-SECURITY-AND-PRIVACY](08-SECURITY-AND-PRIVACY.md).)
4. **AI is interface-only** — no LLM calls, no conversational assistant — until
   explicitly authorised. Every provider feature: accuracy + latency + privacy
   together; **no provider is a hard dependency**.
5. **Dark by default; activation is separate** (G8). No merging, marking-ready,
   auto-merge, flag activation, or wiring-in a foundation without explicit
   authorisation. Draft PRs stop for owner review.
6. **Camera branches #56/#58/#59 (and #55) are frozen** unless explicitly
   authorised — no merge, rebase, further pushes, wiring, or flag activation.
7. **Discovery sequence** (approved): fix the confirmed precise-GPS privacy
   defect first, then build the privacy-safe discovery foundation. Owner approved
   (PR #60 review): the **500 m cell / 30-min rotation / 150 m max offset**, the
   **layered compile-time flags + hard master gate**, and the **provider-neutral
   Discovery V2 contracts**.

## Ratified 2026-08-03 (documentation-phase close-out)

8. **ADR-022 Accepted** — the five-step Discovery sequence (Map → Exchange →
   Events → Moments → Assistant) is formal; closes gap C4.
9. **ADR-023 Accepted** — Exchange is a platform service (the universal Intent
   Graph), scoped to architectural boundary and responsibilities only.
10. **Privacy-critical values are never ordinary runtime configuration.**
    Anything affecting a privacy guarantee (location precision, consent
    semantics, wire exposure) changes only via a **code-reviewed change with
    explicit owner approval** — the runtime config service tunes `product`/`ops`
    keys only (DPAS ch 02 §2.6 / ch 11 §11.5).
11. **The documentation phase is closed.** No further broad planning documents;
    the next documentation is implementation-specific (ADRs arising during
    development, generated API references). The owner's sequence: merge the
    documentation PRs in order → close ratification items (A5, proposed
    defaults) → implement **Smart Nearby Discovery Map** against the approved
    architecture → then **SpotMe Exchange** on that foundation.

## Open decisions (waiting on the owner)

| Decision | Blocking | Where |
|---|---|---|
| **Merge the documentation PRs in order**: #62 → #63 → #64 → #65 (re-targeting each stacked PR as its base merges) | Implementation start | the four draft PRs |
| **Close A5**: ratify the Exchange PRD (checklist `product/exchange/13 §13.1`) incl. the `[PROPOSED]` defaults | Exchange implementation | #64 |
| Ratify/adjust the **coarse-origin provider-port tightening** | DPAS ch 02 §2.4 | #65 |
| Re-target PR #61 to `master` after #60 merges | Live Events stacked base is temporary | #61 |
| Event/place/exchange **provider selection** (authorized sources) | Discovery surfaces go live | #60/#61/#64 |
| Ratify the crypto ratchet stack (#41/#42/#43) + cross ADR-008 §12 | Priority-1 messaging completion | #43 |
| Nearby Moments data/privacy model (needs a new ADR) | Discovery step 4 | Planned |
| Media-core: open a PR or fold the branch | anomaly: branch without a PR | [10-CONTRADICTIONS-AND-GAPS](10-CONTRADICTIONS-AND-GAPS.md) |

## How decisions are recorded

- An **architectural** decision becomes an **ADR** (immutable, G6).
- A **status** change updates [03-IMPLEMENTATION-STATUS](03-IMPLEMENTATION-STATUS.md).
- A **roadmap** change updates [04-ROADMAP](04-ROADMAP.md).
- This page tracks the standing directives and the open queue; keep it current
  under G9.
