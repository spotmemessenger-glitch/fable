# ADR-016 — Dark shipping + fence tests

**Status:** Accepted (2026-08-03). Backfilled from merged and draft evidence.

## Context

"Not shipped" must not quietly become "shipped" — an unrelated PR adding an
import, nobody noticing, and a foundation running in the field. Equally, "not
shipped" must not become "not looked at": unexercised code that looks finished is
worse than no code. A statement in a PR description cannot enforce either; a
failing build can.

## Decision

Platform foundations ship **dark** and are guarded by a **fence test**
(`*-not-shipped.test.js`) that proves, mechanically:

1. the subsystem is **shipped dark** (`assertShippedDark`);
2. it is **not wired in** — no app module imports or constructs it;
3. it is **tree-shaken** out of the built `dist`;
4. it contains **no secrets**;

…while the **same suite exercises every module**, so the foundation is tested,
not merely dormant. A sibling dark foundation may reuse another's contracts (both
remain fence-proven not-shipped).

## Consequences

- Activation cannot happen by accident; it is a visible, owner-authorised change
  (G8).
- Reviewers get a build-enforced guarantee rather than a promise.
- The fence is deliberately deletable *when* the owner authorises activation — in
  a change whose whole subject is that activation.

## Evidence

`web/test/signing-not-shipped.test.js` (merged, #29/#36);
`web/test/discovery-v2-not-shipped.test.js`, `web/test/live-events-not-shipped.test.js`
(draft PRs #60/#61).
