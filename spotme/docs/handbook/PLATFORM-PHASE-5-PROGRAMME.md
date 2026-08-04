# Platform Phase 5 — Nearby Moments (dark foundation)

> **Status: Implemented (Draft PR — DARK), in progress.** Phase 5 builds the
> dark foundation for **Nearby Moments** (Discovery Programme step 4 — posts,
> 24-hour stories, and nearby/friends/city feeds). Executed under the recorded
> M1–M9 corrections (ports; frozen ranking; story lifecycle; flat comments +
> closed reactions; four-tier visibility; expanded threat model; no AI;
> reserved queues; expanded verification). The data/privacy-model ADR
> obligation is satisfied by **ADR-028** (Proposed) inside 5A; the 5A PR review
> is its approval gate. Nothing is activated, wired, deployed, or user-visible.

## Linear stacked chain (base master; nothing merges this mission)

Repairs merge FORWARD (5A→5E) with ordinary merge commits before 5E validates;
no rebase/force-push; each PR notes its temporary base.

| Group | Branch | Base | Scope |
|---|---|---|---|
| 5A | `feat/platform-phase-5a-moments-contracts` | `master` | Contracts v1 + ADR-028 + M6 threat model + this programme |
| 5B | `feat/platform-phase-5b-media-pipeline` | 5A | Dark MediaModule: M1 media ports on the existing `IStorageAdapter`, upload-intent/presigned-slot, EXIF/GPS strip (proven), `{moment-media}` contracts + fixture workers, content-hash dedup, retention/cascade |
| 5C | `feat/platform-phase-5c-moments-backend` | 5B | Dark MomentsModule behind the M1 ports: M5 visibility lifecycle, three feeds chronological-first + M2 registry, M3 stories + `{story-expiry}`, M4 comments/reactions, block/report in SQL, moderation machine + audit, PostGIS, sanitized projection, Disabled realtime |
| 5D | `feat/platform-phase-5d-moments-webnext` | 5C | Inert web-next surface: 3-mode virtualized feed, composer (fixture camera-roll; CameraPort seam), post card, stories rail, M5 visibility control + pre-attach explanation, untrusted URLs, a11y + privacy-mutation |
| 5E | `feat/platform-phase-5e-moments-fences-perf-ops-docs` | 5D | Dark fences + full M9 battery + honest benchmarks + closed metrics + runbooks + activation checklist (moderation staffing + legal review HARD) + docs + status rows |

## Standing bar (Phases 2–4 verbatim)

Branded `CoarsePublicLocation` only, single minting point; no precise GPS
outbound (mutation batteries); distance bands for anything person-attached;
anti-enumeration; additive migrations clean+upgraded; keyset pagination;
optimistic concurrency; dark modules unimported by `AppModule`; non-vacuous
fences; closed metrics on the 1G gates; docs at real paths; ranking per M2;
web-next only, legacy web untouched.

## Owner-retained (not delegated)

All merges (every PR stays DRAFT) · activation/flags · deploys · production
storage/provider credentials · #43/#60/#61/camera branches (CameraPort is
interface-only; never unfreeze) · gender/age (A3) · payments/ads/sponsored
ranking · moderation POLICY thresholds + staffing · the D6 age policy ·
deletions.

## Build record

| Group | PR | State | Evidence |
|---|---|---|---|
| 5A | #97 | Draft PR — DARK | `moments.ts` v1 + negative/usage compile-time fences + ADR-028 (Proposed) + M6 threat model; contracts typecheck + build + boundary fence 6/6 |
| 5B | #98 | Draft PR — DARK | media ports on the storage seam + EXIF strip proven + M8 queue contracts (inert) + dedup/cascade; moment-media spec 10/10; migration clean+upgraded |
| 5C | #99 | Draft PR — DARK | MomentsModule (unimported): M5 feeds in SQL + M2 frozen ranking + M3 stories + M4 social + moderation machine; policy/ranking/e2e 25 green; migration clean+upgraded |
| 5D | #100 | Draft PR — DARK | inert web-next surface: two-step location attach, untrusted URLs, closed reactions, privacy-mutation battery; web-next 84 + fence 6/6 |
| 5E | #101 | Draft PR — DARK | dark fences (12) + M9 battery + closed metrics + benchmark (100k achieved, linear-growth flag) + runbooks + activation checklist |
