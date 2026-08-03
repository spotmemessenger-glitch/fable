# ADR-024 — Discovery broadcasts coarse coordinates only (P0 hotfix)

**Status:** ACCEPTED — by the owner's merge of PR #66 into `master`
(merge commit `069905e`, 2026-08-03). Immutable per G6.

## Context

On `master@31e1894`, the discovery lobby broadcast the raw high-accuracy
geolocation fix in its public presence payload while the file's own header
promised coarsening. The pre-fix `acquirePosition()` doc comment recorded the
**2026-07-25 owner decision** this hotfix supersedes
(`spotme/web/src/lib/discovery.js`, master@`31e1894`):

> "PRECISE positions (owner decision 2026-07-25): the 5–500 m radar needs
> real GPS, so coords go out exactly as the device reports them, refreshed
> continuously. Ghost mode (settings.showOnMap=false) remains the privacy
> switch — it withholds position entirely."

The exported `coarse()` helper (~110 m rounding + stable per-identity jitter)
existed with zero call sites.

## Decision

The public discovery broadcast carries **only `coarse()` output**; the precise
fix stays device-local (distance, map centring, `myPosition()`). PR #66's diff
states the supersession in the replacing comment, merged by the owner:

> "The PRECISE fix stays DEVICE-LOCAL. High accuracy is acquired for local
> distance/centring (`myPosition()`), but what the lobby broadcasts is the
> coarse() output — ~110 m rounding plus a stable per-identity jitter —
> applied in myAnnouncement() before anything leaves the device (P0 privacy
> fix; supersedes the 2026-07-25 precise-broadcast decision)."

Payload shape is unchanged (same keys/types; coarser values). The regression
guard `spotme/web/test/discovery-coarse-broadcast.test.js` fails the suite if
raw coordinates are ever restored (mutation-verified: exit 1 on the reverted
code).

## Consequences

- **PR #60 rebase pending.** The Discovery V2 branch also modifies
  `myAnnouncement()`/`acquirePosition()`; after rebase the conflict resolves
  in favour of #60's `publicPositionFor` boundary, which replaces this
  interim model.
- **Interim privacy model until #60:** ~110 m grid rounding plus a **stable**
  per-identity jitter. This defeats casual exact-location disclosure but the
  revealed point is stable over time; the rotating-offset,
  correlation-resistant model of ADR-018/019 (PR #60) supersedes it.
- The 2026-07-25 precise-broadcast decision is formally superseded; no
  session may reintroduce precise coordinates to the public presence path.

## Evidence

`master@31e1894` `spotme/web/src/lib/discovery.js` lines 9–13 (header claim),
69–70 (raw broadcast), 87/96 (high-accuracy capture), 240 (`coarse()`);
PR #66 (+125/−8; non-draft; merged by owner as `069905e`);
`spotme/docs/SPOTME-REPO-AUDIT-2026-08-03.md` §13(1) (the audited
contradiction this fixed). Related: ADR-018, ADR-019.
