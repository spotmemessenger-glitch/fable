# ADR-019 — Discovery V2 privacy model (precise GPS stays device-local)

**Status:** Accepted (2026-08-03). Backfilled; supersedes the 2026-07-25
precise-broadcast decision. Owner-approved (PR #60 review).

## Context

The Discovery v1 lobby broadcast the device's **precise, high-accuracy GPS**
(`getCurrentPosition`/`watchPosition`) directly into public presence
announcements — a confirmed privacy defect. A prior decision (2026-07-25) had
deliberately broadcast precise coordinates for a fine-grained radar; the owner
reversed this: precise GPS must never be public.

## Decision

**Precise GPS is device-local only** — used for distance, centring, radius and
routing, and never broadcast, persisted unnecessarily, logged, put in analytics,
exposed via debug handles, added to URLs, or sent to a provider except where a
nearby search technically requires an origin. The **public** position is the
on-device **approximation** of [ADR-018]. There is a **single boundary**
(`publicPositionFor`) through which presence announces; hidden/ghost mode
(`showOnMap=false`) transmits **no** lat/lon. On the map, people markers are
**approximate-only** (flagged `approximate: true`), with blocked/hidden filtered;
exact coordinates are not recoverable from a marker, log, event, or the DOM.

## Consequences

- The public path can never carry a precise fix; a mutation test enforces it.
- Explicit venue sharing requires an explicit user action — visibility is not
  consent.
- **Not yet on master:** this model lives in draft PR #60; until it merges, the
  v1 defect still exists on `master` (handbook §08/§10). Do not describe it as
  fixed until then.

## Evidence

`web/src/lib/discovery.js` (boundary), `web/src/lib/geo-approx.js`,
`web/src/lib/discovery-v2/people.js`, `web/test/discovery-privacy.test.js`
(draft PR #60). Depends on [ADR-018](018-deterministic-location-grid.md).
