# Exchange Platform Architecture (Phase 3, DARK)

Engineering spec for the SpotMe Exchange dark foundation (Discovery Programme
step 2). Status throughout: **Implemented (Draft PR — DARK)** — nothing
activated, wired, or deployed. Chapters:

| # | Chapter | Covers |
|---|---|---|
| 01 | [Contracts, Policy & Threat Model](01-CONTRACTS-POLICY-THREAT-MODEL.md) | Versioned contracts, the fixed-vs-[PROPOSED]-vs-owner-retained policy table, 21-threat model |
| 02 | [Backend, Persistence, Matching & UI](02-BACKEND-AND-PERSISTENCE.md) | Phase 3B persistence + lifecycle engine · 3C matching/search · 3D web-next experience |
| 03 | [Operations, Performance & Activation](03-OPERATIONS-PERFORMANCE-ACTIVATION.md) | Phase 3E dark fences, instrumentation, measured performance, runbooks, activation checklist |

Every `[PROPOSED]`/pending-A5 value is a config seam with a documented default,
never an approved product decision. No payments/escrow/advertising/sponsored
ranking; no age/gender anywhere (A3); business participation is a dark seam (D4).
