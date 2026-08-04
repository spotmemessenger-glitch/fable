# ADR-028 — Nearby Moments: data & privacy model

**Status: PROPOSED — owner review of the Phase 5A PR is the approval gate**
(per the Phase 5 mission's ADR note; this document satisfies the handbook's
"data/privacy-model ADR required before code" obligation for Nearby Moments).
**Date:** 2026-08-04 · **Relates to:** ADR-018/019/024 (coarse location),
ADR-021 (product ecosystem), ADR-022 (execution sequence), ADR-026 (realtime
split-plane), Phase 5 corrections M1–M9.

## Context

Nearby Moments is the fourth Discovery pillar: short posts and 24-hour stories,
optionally location-flavoured, surfaced in nearby/friends/city feeds. It is the
first surface where USER-AUTHORED media and location intersect, so the data
model must make the dangerous states unrepresentable before any code ships.

## Decision — the data model

**Entities (all additive):** `Moment` (post: photo/video/text), `MomentMediaAsset`
(processed media: storage key, content hash, EXIF-free by construction),
`Story` (six-state lifecycle), `MomentComment` (flat, `parentId`-referenced),
`MomentReaction` (closed five-member registry), `MomentFollow` (explicit
follows), `MomentBlock`, `MomentReport`, `MomentModerationEvent` (append-only
audit). Wire shapes live in `@spotme/contracts/src/moments.ts` v1.

## Decision — the privacy model

1. **Visibility is four poster-controlled tiers (M5):** `private` / `friends` /
   `nearby` / `public`, per post. `private` NEVER enters any feed, index, or
   projection — enforced three times: at the TYPE level (`FeedVisibility`
   excludes it), in SQL (every feed query carries `visibility <> 'private'`),
   and by a 5E fence over the search projection.
2. **Location is opt-in, coarse-only, tier-limited:** only `nearby`/`public`
   posts may attach a location, and the ONLY attachable shape is the branded
   `CoarsePublicLocation` (cell) minted at the single client boundary
   (`coarsenForPublic`). A raw device fix is a compile error. The UI shows a
   plain-language explanation BEFORE any attach (M5). City feeds use a broader
   city-level cell derived server-side from the coarse cell — never finer.
3. **EXIF/GPS is stripped BEFORE persistence:** uploaded media passes the 5B
   strip boundary; a GPS-tagged image is proven clean by test and re-proven by
   a 5E fence. No original (pre-strip) bytes are ever stored.
4. **No engagement telemetry on public shapes:** no view/like/share counts
   exist on any public contract (compile-time negative). Reactions expose only
   the viewer's own state. This removes the raw material for popularity
   amplification (M2) and for inference of a person's audience.
5. **Location-inference resistance (M6):** post patterns can reconstruct a
   home/work location even from coarse cells. Mitigations: per-post opt-in
   (no default-on location), coarse-cell-only granularity, no location on
   `friends`/`private` tiers, no per-author location history endpoint, keyset
   pages with no totals, and uniform not-found for unauthorized ids.
6. **Retention:** stories expire at 24h ([PROPOSED]) and are swept by the
   `{story-expiry}` job; deleted content cascades to media assets (dedup-aware:
   an asset is deleted when its last reference goes); moderation audit is
   append-only and sanitized (ids + closed codes, never content).
7. **Minors (D6-open):** the posture is [PROPOSED] 18+ for location-attached
   posts and for public visibility; the child-safety report reason follows a
   MANDATORY handling path (5E runbook). Final age policy is owner-retained.
8. **No AI in this phase (M7):** feeds, moderation, and search are
   deterministic; AI touchpoints are named seams only, owner-gated.

## Consequences

Feed queries filter in SQL (blocked/private/moderation-removed rows are never
fetched); ranking uses only the closed M2 registry with chronological-first as
the default; realtime is an interface + Disabled adapter (ADR-026 alignment);
the media pipeline composes on the existing `IStorageAdapter` with job
contracts on the reserved M8 queue names, all inert without env. Everything
ships DARK behind unimported modules until an owner-authorized activation.

## Alternatives considered

- **Nested comment storage** — rejected (M4): unbounded recursion, hot-path
  update amplification; flat `parentId` keeps storage simple and render-side.
- **Default-on location for nearby posts** — rejected: violates opt-in posture
  and worsens inference risk.
- **Engagement counters on public shapes** — rejected (M2): they are the fuel
  of amplification ranking and a harassment signal; nothing needs them dark.
