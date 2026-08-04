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

## Phase 3 adversarial-review disposition (13 lenses)

The 13-lens adversarial review of 3B–3E ran after the stack was built; every
finding was confirmed against the code before any change, and each High/Medium
was fixed with a regression test on its own PR (nothing merged — all still
DRAFT). Dispositions:

| ID | Sev | Where | Disposition |
|---|---|---|---|
| CELL-BYPASS | High | 3B policy | FIXED — cell is always server-derived; a precise-shaped or non-matching client cell is refused. Tests in `exchange-policy.spec.ts`. |
| MODERATION-FILTER | High | 3B repo | FIXED — discoverable query requires `moderationState = 'clear'` (was `<> 'removed'`); e2e proves restricted rows are hidden. |
| IDEMPOTENCY-RACE | Med | 3B repo | FIXED — concurrent duplicate-key create catches P2002 and replays the winner; race e2e added. |
| KEYSET-INDEX | Med | 3B migration | FIXED — partial keyset index on `(createdAt DESC, id DESC)` for discoverable/clear rows. |
| INDEX-CATEGORY | Med | 3C search | FIXED — `category` coordinate tokens stripped from the projection; regression test added. |
| PROXIMITY-COMMENT | Low | 3C matching | FIXED — comment corrected: intentFit leads, proximity second; proximity-outranks-popularity holds because no popularity signal exists. |
| MINE-TAB-BLANK | Med | 3D web-next | FIXED — `listMine` controller method + `mine` state + shell view with lifecycle actions; loads on tab entry; controller test added. |
| RADIOGROUP | Low | 3D web-next | FIXED — toggle-button group is `role="group"` (aria-pressed), not an ARIA radiogroup. |
| ARIA-DESCRIBEDBY | Low | 3D web-next | FIXED — price input associated with its no-payment note via `aria-describedby`. |
| WEBNEXT-UNFENCED | Med | 3E fences | FIXED — new fence asserts `App.tsx`/`main.tsx` mount neither `ExchangeShell` nor the exchange subtree. |
| IMPORTER-REGEX | Low | 3E fences | FIXED — import-reach matcher broadened to `/exchange.module`-style specifiers while excluding bare `'exchange'` domain-label literals. |
| BUSINESS-FENCE | Med | 3E fences | FIXED — behavioral assertion that `validateIntentInput` stamps `ownerKind='user'` (business owner unreachable in fact). |
| PERF-OVERCLAIM / SEED-CAVEAT / TITLE-SELF-DISCLOSURE | Low | 3E docs | FIXED — ch. 03 now distinguishes measured first-page-vs-scale from unmeasured depth-invariance, documents the synthetic-uniform seed caveat, and records free-text self-disclosure as a moderation/user-education surface (not a coordinate leak). |

Owner-retained items surfaced by the review are unchanged and NOT decided here:
the `[PROPOSED]` match weights (A5), business activation (D4), and every
activation/flag flip remain owner-gated per ch. 03 §5.
