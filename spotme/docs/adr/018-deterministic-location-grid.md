# ADR-018 — Deterministic approximate-location grid

**Status:** Accepted (2026-08-03). Backfilled; parameters owner-approved (PR #60).

## Context

Public presence needs a location signal, but broadcasting anything derived
stably from the true point lets an observer average many announcements back to
the home/exact position (long-term correlation). A fixed per-person jitter does
not help — it averages straight back. The model must resist both exact disclosure
and correlation, must be testable, and must not teleport between announcements.

## Decision

The public position is computed **on-device** by:

1. **Snapping to a coarse privacy cell** (~500 m). The public point orbits the
   **cell centre**, so averaging over time converges only on the coarse cell —
   never the true point. This is what defeats correlation.
2. Adding a **per-person, per-window rotating bounded offset** (≤150 m, 30-min
   window) inside the cell — liveness without unbounded drift.
3. Advancing the offset **angle a fixed step per window**, so consecutive windows
   are a bounded chord apart: the point drifts, it never teleports.

Everything is **pure and deterministic** — seeded by `(id, clock)` with an
injectable clock — so the privacy properties are unit-tested (including a
mutation-style guard that fails if precise coordinates are ever restored).

## Consequences

- Public location is honestly approximate and correlation-resistant.
- The properties are provable in CI, not asserted in prose.
- Parameters (500 m / 30 min / 150 m) are owner-approved and centralised as
  constants.

## Evidence

`web/src/lib/geo-approx.js`, `web/test/discovery-privacy.test.js` (draft PR #60).
Related: [ADR-019](019-discovery-v2-privacy-model.md).
