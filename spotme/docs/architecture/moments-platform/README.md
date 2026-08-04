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
