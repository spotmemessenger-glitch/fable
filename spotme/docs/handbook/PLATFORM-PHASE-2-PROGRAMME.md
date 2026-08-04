# Platform Phase 2 — Smart Nearby Discovery Map (staged, dark, additive)

**This document is the Platform Phase 2 programme playbook.** Fifteen
checkpoints land as **six draft PRs** (one item group per branch), per the
Phase 1 pattern. Each PR: own scope, own tests green before push, stops as
draft for owner review. Stacked bases are temporary — retarget to `master`
when the base merges. Everything is **DARK**: no activation, no flag flips,
no deployment, no user-visible change; precise GPS never leaves the client
boundary (ADR-018/019, P2).

## Group / branch / checkpoint map

**Linear dependency chain (corrected A1):** each group stacks on the previous
one, so the final validation branch (2F) contains every prior subsystem. Each
PR contains only its documented checkpoint scope relative to its temporary
parent; each opens as Draft and stops for owner review, stating "Temporary
stacked base — retarget to master after the immediately preceding Phase 2 PR
merges." No merge/rebase/retarget/force-push during the build mission; the
later landing mission merges and retargets strictly in order 2A → 2B → 2C →
2D → 2E → 2F.

| Group | Branch | Base | Checkpoints |
|---|---|---|---|
| **2A** | `feat/platform-phase-2a-contracts-threatmodel` | master | 1 (shared discovery contracts) + 4 (privacy/abuse threat model) |
| 2B | `feat/platform-phase-2b-discovery-backend` | 2A branch | 2 (backend module) + 3 (PostGIS model) + 5 (people engine) |
| 2C | `feat/platform-phase-2c-search-and-providers` | 2B branch | 6 (Typesense SearchPort) + 7 (place/directions ports) |
| 2D | `feat/platform-phase-2d-intent-ranking-realtime` | 2C branch | 8 (intent + ranking) + 9 (realtime contract) |
| 2E | `feat/platform-phase-2e-webnext-discovery` | 2D branch | 10 (web-next UI) + 11 (client application layer) |
| 2F | `feat/platform-phase-2f-fences-perf-ops-docs` | 2E branch | 12 (dark fences) + 13 (performance) + 14 (ops/observability) + 15 (docs/governance) + final validation |

## Standing constraints

- **P1–P10 product principles** of the Phase 2 mission bind every checkpoint;
  P2 (privacy by architecture) and P7 (communication only after consent) are
  fence-enforced, not promised.
- **A3 exclusion:** no gender or age filters anywhere — no such field in any
  schema, index, contract, or UI. The filter sheet is distance band, category,
  open-now only (D6/D7 owner-retained).
- **D9/D10** are approved for DARK BUILD only (see DECISIONS.md); activation
  is owner-retained.
- Typesense is the selected target (tech-stack §14); the **production-hardware
  re-benchmark before wiring stands** — no harness rerun in this phase (A4).
- PR #60/#61, #43 and the camera branches remain byte-identical; reusable #60
  concepts are re-cut, never modified in place (classification in the Phase 0
  report of the executing session).
- **A8 (open-now scope):** the open-now filter applies ONLY to place results,
  and only where authorized provider evidence of opening hours exists — it is
  unavailable/visibly unsupported without that evidence, and it never affects
  nearby-person or username results. No availability/open-now signal of any
  kind attaches to people.
- **A9 (handle ownership):** DiscoveryPublicProfileProjection may reference
  the canonical public handle and carry a normalized search projection, but it
  is never the authority for handle uniqueness, ownership, or lifecycle — the
  existing identity model (D10) remains authoritative; the projection is
  derived, rebuildable, and deleted with the user.
- One commit per checkpoint; push after each; complete validation after
  checkpoints 4, 8, 12 and before each draft PR.

## Resume line

"Continue Platform Phase 2 from the last pushed PR; verify all prior PRs
before continuing."

## Build record (updated 2026-08-04)

| Group | PR | State | Checkpoints delivered |
|---|---|---|---|
| 2A | #80 (draft) | Pushed, green | 1 (contracts) + programme/decisions docs + 4 (threat model) |
| 2B | #81 (draft) | Pushed, green | 2 (module) + 3 (PostGIS models/migration) + 5 (people engine on real PostGIS) |
| 2C | #82 (draft) | Pushed, green | 6 (Typesense SearchPort, live-verified) + 7 (place/directions ports) |
| 2D | #83 (draft) | Pushed, green | 8 (intent + closed-registry ranking) + 9 (realtime contract) |
| 2E | #84 (draft) | Pushed, green | 10 (Discovery UI) + 11 (client application layer + privacy mutation battery) |
| 2F | #85 (draft) | Pushed, green | 12 (dark fences) + 13 (benchmarks — 1M achieved) + 14 (instrumentation + runbooks) + 15 (docs/governance) + final validation |

Landing order (owner-retained): 2A → 2B → 2C → 2D → 2E → 2F, strictly in
order, retargeting each next PR to master as its parent merges. Nothing in
this programme is merged, deployed, activated, or user-visible.
