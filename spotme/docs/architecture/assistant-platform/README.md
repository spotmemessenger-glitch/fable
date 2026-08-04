# Assistant Platform (AI Interactive Map) — Phase 6 architecture

The fifth and **final** layer of the Discovery programme (X12): a
citation-first assistant over the four dark Discovery layers (Discovery,
Exchange, Events, Moments) plus username lookup. Built DARK — no activation,
no AppModule import, no model call.

**The core design law (X1): there is no prose answer path.** An assistant
answer is a discriminated union whose only content-bearing variant carries a
`CitedSummary` — typed claims, each with a non-empty citation list resolving
into the same answer envelope. Fabrication, uncited claims, generated star
ratings, precise coordinates on evidence, and unlabeled straight-line
estimates are **compile errors** at the contract layer and **throws** at the
6B boundary.

**Deterministic-only this phase.** No AI SDK, model name, endpoint, or env var
exists anywhere in the assistant subtree (X10 fence). The Phase 1E AI Gateway
ports (IntentPort/SummaryPort/VoicePort in `web/src/lib/ai/`) remain dark
seams; LLM provider choice is owner-retained.

| Doc | Contents |
|---|---|
| [01-CONTRACTS-AND-THREAT-MODEL.md](01-CONTRACTS-AND-THREAT-MODEL.md) | 6A: `assistant.ts` contracts v1 + the Phase 6 threat model |
| [02-BACKEND-REVIEW-ROUTE-UI.md](02-BACKEND-REVIEW-ROUTE-UI.md) | 6B–6D: dark AssistantModule, X5 review engine, X6 routes, web-next surface |
| [03-OPERATIONS-ACTIVATION.md](03-OPERATIONS-ACTIVATION.md) | 6E: closed metrics, runbooks, owner-gated activation checklist |
| [04-ADVERSARIAL-REVIEW-PHASE-6.md](04-ADVERSARIAL-REVIEW-PHASE-6.md) | X11 13-lens review: findings F1-F4, dispositions, post-repair validation |

Programme table + build record: `docs/handbook/PLATFORM-PHASE-6-PROGRAMME.md`.
Corrections of record: X1–X12 (typed claims; evidence integrity; fail-closed
citations; freshness; review facets; route location boundary; ports-only;
domain darkness; query privacy; 6E fences; 13 review lenses; framing).
