# Nearby Moments Platform Architecture (Phase 5, DARK)

Engineering spec for the Nearby Moments dark foundation (Discovery Programme
step 4 — posts, 24-hour stories, nearby/friends/city feeds). Status
throughout: **Implemented (Draft PR — DARK)** — nothing activated, wired,
mounted, connected, or deployed. Built under the recorded **M1–M9**
corrections; the data/privacy model is **ADR-028** (Proposed — the 5A PR
review is its approval gate).

| # | Chapter | Covers |
|---|---|---|
| 01 | [Contracts, ADR & Threat Model](01-CONTRACTS-ADR-THREAT-MODEL.md) | Contracts v1, ADR-028, the 12-threat M6 model, compile-time fences |
| 02 | [Media, Backend & UI](02-MEDIA-BACKEND-UI.md) | 5B media pipeline (EXIF strip, M8 queues, dedup/cascade) · 5C backend (M5 feeds, M3 stories, M4 social, moderation) · 5D surface |
| 03 | [Operations, Performance & Activation](03-OPERATIONS-PERFORMANCE-ACTIVATION.md) | 5E fences + M9 battery, metrics, measured performance, runbooks, activation checklist |

## The corrections, encoded

- **M1** ports everywhere; thin controllers; Disabled realtime; CameraPort
  interface-only. **M2** frozen ranking registry; forbidden signals throw;
  chronological-first. **M3** six-state stories + `{story-expiry}` contract.
- **M4** flat `parentId` comments; closed 5-reaction registry (service + DB
  CHECK). **M5** four-tier visibility; coarse-cells-only on nearby/public;
  private never in any feed/index/projection; pre-attach explanation.
- **M6** expanded threat model incl. the mandatory child-safety path and
  untrusted URLs (no unfurl). **M7** no AI — deterministic only. **M8** four
  reserved queues, contracts + fixture workers, inert without env. **M9** the
  expanded verification battery (import-graph, dependency, ranking-invariant,
  storage/media boundary, artifact scans).

## Phase 5 adversarial-review disposition (13 lenses + media-abuse / feed-integrity / minor-safety)

Every finding was confirmed against the code before any change; the actionable
one was fixed with a regression test on its own branch and merged forward
(5C→5D→5E) per the fix-propagation rule. Nothing merged to master — all DRAFT.

| ID | Sev | Where | Disposition |
|---|---|---|---|
| PRIVATE-INTERACT | **Medium-High** | 5C service/repo | **FIXED** — direct-by-id `react`/`addComment`/`comments` used an ungated `findById`, so a stranger holding a private/friends post's id could interact with it. New `findViewable` runs the full tier + two-way-block + moderation gate IN SQL (private: author only; friends: author/follower; nearby/public: non-blocked); uniform NOT_FOUND otherwise. Real-PostGIS regression test added. |
| STORY-TIER-RAIL | Low | 5C rail | **No change needed** — the rail is follower-scoped for every tier, which is STRICTER than the nearby/public story tiers require; a leak is impossible, only reach is narrower. Widening nearby/public story reach is activation-scope, documented here. |
| MEDIA-REF-UNVALIDATED | Low | 5C/5B seam | **No change needed (documented)** — `createMoment` does not verify `mediaIds` exist; `addReference` on an absent id is a no-op, nothing dangles dangerously, and the upload→post flow is fixture-only this phase. Validating referenced assets (and slot-owner binding on ingest) is named in the activation checklist. |
| REPORT-COMMENT-STATE | Low | 5C moderation | **No change needed (documented)** — reporting a comment assumes a `visible` from-state; a duplicate report of an already-reported comment re-records `visible→reported`. Audit stays truthful about intent, the machine state is correct, and per-target report thresholds are owner-retained policy anyway. |
| CITY-CELL-BOUNDARY | Low | 5C city feed | **No change needed (documented)** — the city feed matches the viewer's exact 1-decimal cell; a viewer on a cell boundary misses the adjacent cell. This is the privacy-conservative direction; widening to a neighborhood of cells is an activation-scope query change. |
| FEED-QUERY-SCALE | Low (honest flag) | 5E bench | **Documented** — 100k nearby-feed p50 ≈ 389 ms with roughly linear growth; named as a pre-activation tuning item (block-set pre-join, `{feed-refresh}` materialization seam) in ch. 03. |

The remaining lenses — origin-privacy (mutation batteries), M2 frozen ranking
(forbidden throws by name), M3 story machine, M4 flat comments + closed
reactions (service + DB CHECK), M5 triple-enforced private exclusion, EXIF
strip (proof + fence re-proof), queue inertness, dark posture, anti-enumeration
(signed depth-bounded cursor, uniform not-found, no totals), additive
migrations (clean + upgraded), dependency/import-graph hygiene, contract
branding/negative fences, and the child-safety mandatory lane — were confirmed
clean against the code.
