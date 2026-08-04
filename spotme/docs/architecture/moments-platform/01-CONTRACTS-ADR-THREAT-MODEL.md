# Nearby Moments — Contracts, ADR & Threat Model (Phase 5A)

> **Status: Implemented (Draft PR — DARK).** Contracts + the data/privacy ADR
> (ADR-028, Proposed — the 5A PR review is its approval gate) + threat model
> only. No module, no persistence, no route, no UI.

## 1. Contracts (`packages/contracts/src/moments.ts`, v1)

`MomentPublic` (photo/video/text; optional poster-opted branded coarse attach,
nearby/public tiers only; NO view/like/share counts), `StoryPublic` (only
`active` is public; the M3 six-state lifecycle is the `StoryState` union),
`MomentFeedMode` (nearby/friends/city) with **chronological-first** default,
M5 four-tier visibility with `FeedVisibility` structurally excluding `private`,
flat `parentId` comments (M4), the closed five-member reaction registry (M4),
report/block/hide capabilities (report ALWAYS available), moderation states
`visible→reported→limited→removed` with closed reason codes (incl.
`child-safety`), the closed M2 ranking registry (forbidden signals
unrepresentable), opaque branded cursor + pages with no totals.

Compile-time negatives (`moments-negative.test.ts`): raw `{lat,lon}`
unassignable; `private` unrepresentable in feed shapes; view/like counts a
compile error; `watchTime`/`engagement`/`sponsored`/`popularityAmplification`
unrepresentable as signals; unknown reaction rejected; age on an author ref a
compile error (A3); plain-string cursor rejected; non-active story
unrepresentable as public; nested `children` on a comment a compile error.
`moments-usage.test.ts` is the positive control.

## 2. Data & privacy model

**ADR-028** (`docs/adr/028-nearby-moments-data-privacy-model.md`, Proposed) —
entities, the four-tier visibility model with triple enforcement (type, SQL,
fence), opt-in coarse-only location with pre-attach explanation, EXIF-strip
before persistence, no engagement telemetry, location-inference mitigations,
retention/cascade, the [PROPOSED] 18+ minors posture (D6-open), no-AI (M7).

## 3. Threat model (M6)

| # | Threat | Control (Phase 5) |
|---|---|---|
| T-MO-1 | **Spam / flooding** | closed reaction registry (no engagement fuel), report path, moderation machine + `{moderation}` contract, per-author rate seams ([PROPOSED]), no amplification ranking (M2). |
| T-MO-2 | **Fake giveaways / scams** | report reason codes, moderation `limited` state (reach-limited before removal), fake-business reason code; no payments exist anywhere. |
| T-MO-3 | **Harassment** | block enforced in every read path (SQL), hide, report; comments/reactions from blocked users never fetched; sanitized notifications (ids only). |
| T-MO-4 | **Doxxing** | free text is user-authored — report/`removed` path + `doxxing` reason; no auto-unfurl of links (below); locations only ever coarse cells. |
| T-MO-5 | **Location inference from post patterns** | per-post opt-in; coarse cells only; no location on friends/private; no per-author location history; no totals; uniform not-found; ADR-028 §5. |
| T-MO-6 | **Image abuse** | EXIF/GPS strip before persistence (proven + fenced); content-hash dedup gives a stable handle for moderation removal; `image-abuse` reason. |
| T-MO-7 | **Child safety** | MANDATORY report path: `child-safety` reason routes to the highest-priority moderation lane (5E runbook names escalation + preservation duties); [PROPOSED] 18+ posture for location/public posts (owner-retained, D6). |
| T-MO-8 | **Revenge content** | `revenge-content` reason; `removed` cascades media deletion; hash-based re-upload block seam ([PROPOSED], deterministic hash match only — no AI this phase). |
| T-MO-9 | **Fake businesses** | `fake-business` reason; no business surface exists in Moments v1. |
| T-MO-10 | **Malware links** | URLs in posts are UNTRUSTED: rendered as plain non-clickable text, no auto-fetch/unfurl this phase (M6); `malware-link` reason. |
| T-MO-11 | **EXIF/location leakage** | the 5B strip boundary; original bytes never persisted; fence-level re-proof in 5E. |
| T-MO-12 | **Enumeration / scraping** | signed depth-bounded keyset cursor, no totals, uniform not-found, banded person distance. |

## 4. Owner-retained

Moderation POLICY thresholds + staffing (machinery ships with [PROPOSED]
defaults), the D6 age policy, storage provider/spend, camera unfreeze
(CameraPort stays interface-only), activation, merges.
