# ADR-015 — Compile-time feature flags with a hard master gate

**Status:** Accepted (2026-08-03). Backfilled; owner-approved via PR #60 review.

## Context

New platform foundations must ship without being reachable in production. A
**runtime** toggle (a stored setting, URL param, or debug handle) means the code
still ships in the bundle and is one assignment away from running — and cannot be
tree-shaken out.

## Decision

Feature flags for dark foundations are **plain module constants**, all default
`false`, with a **hard `MASTER` gate** that ANDs every sub-flag (a sub-flag can
never enable a feature on its own). They are **not** localStorage / URL / env.
A production build with the master gate down lets the bundler **tree-shake the
whole subsystem out of `dist`**. `assertShippedDark()` proves the shipped config
is fully dark; turning a subsystem on is a single deliberate edit to `MASTER`.

## Consequences

- Dark code does not reach users and does not bloat the shipped bundle.
- Activation is auditable and deliberate (one edit, one change) — supports G8.
- Tests can exercise features via injected flag overrides without touching the
  shipped constant.

## Evidence

`web/src/lib/discovery-v2/flags.js`, `web/src/lib/live-events/flags.js`
(draft PRs #60/#61); pattern precedent in the merged signing fence (#29).
Owner approved the "layered compile-time flags + hard master gate" in the PR #60
review.
