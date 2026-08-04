# 17 — Adversarial Review & Repair Record (Platform Phase 2)

> Status: **Implemented (Draft PR — DARK).** This is the audit record for the
> Phase 2 adversarial review the Overnight Migration Programme ran across the
> six stacked draft PRs (2A #80 → 2F #85). Twelve independent review lenses;
> every finding was verified against the actual code before it was recorded.
> Fixes were committed to the earliest owning branch and propagated forward
> through the stack with ordinary merge commits; each carries a regression test.

## Disposition summary

| ID | Sev | Lens | Owning PR | Disposition |
|---|---|---|---|---|
| F1 / F4.1 | High | location leak / ranking | 2B | FIXED — `validateVisibilityUpsert`: precise-shape refusal, exact keys, WGS84 range, grid re-quantization, server-bounded TTL |
| F4.2 | High | ranking honesty | 2B | FIXED — band-dominant weights (0.85/0.15) so the breakdown total preserves the sort order; invariant test |
| F10.1 | High | benchmark / correctness | 2B | FIXED — `encodeCursor` serializes the exact float (rounding caused keyset dup/skip); benchmark drives the real encode/decode path |
| 6.1 | High | realtime authz | 2D | FIXED — `deriveChannelClaim` takes authoritative cells; grant never widens past them |
| 6.2 | High | realtime authz | 2D | FIXED — cell events carry no userId; routing guard refuses identity-bearing events on cell channels |
| 8.1 | High | dark isolation | 2F | FIXED — import fence catches dynamic import/require/string forms; asserts `main.ts` discovery-free |
| F7-1 | High | frontend a11y | 2E | FIXED — result cards keyboard-operable (button role, tabIndex, Enter/Space, focus ring) |
| F9-1 | High | observability | 2F | FIXED — per-label closed value sets + decimal-value refusal; the ≤32-char-token bypass is closed |
| F6 | Med | enumeration | 2B | FIXED — HMAC-signed cursor; forgery rejected |
| F5 / F11.4 | Med | enumeration | 2B / 2F | FIXED — cursor depth enforced (`CURSOR_TOO_DEEP`); `.env.example` fence regex tightened |
| F11.2 | Med | test vacuity | 2B | FIXED — numeric-context distance-leak assertion replaces a vacuous quoted check |
| 3.1 | Med | schema | 2B | FIXED — migration header documents the raw-SQL GIST index drift caveat; e2e asserts the index exists |
| F4.3 | Med | ranking | 2D | FIXED — `rankCandidates` validates weights (finite ≥ 0, registered only) |
| 6.3 | Med | realtime | 2D | FIXED — publish-time visibilityVersion monotonicity (C-REPLAY enforced) |
| 6.4 | Med | realtime | 2D | FIXED — `assertPublishable` rejects coordinate-shaped VALUES |
| F8 | Med | index minimization | 2C | FIXED — `indexDoc` screens coordinate-shaped string values |
| F10-search | Med | search honesty | 2C | FIXED — any non-2xx Typesense response is a typed failure |
| F3 / F7-12 | Med | frontend | 2E | FIXED — offline cache re-filtered for expiry + hidden; hide() works offline |
| F11.1 | Med | test vacuity | 2E | FIXED — structural coordinate-token assertion (truncated leaks caught) |
| F7-3 | Med | frontend | 2E | FIXED — single `resultsOf(state)` shared by Shell + App |
| F7-4 | Med | frontend | 2E | FIXED — `setVisibility` wrapped; failures never clobber the search state machine |
| F7-7 | Med | frontend | 2E | FIXED — virtualization scroll clamped; `results` in selection-sync deps |
| F9-2 | Med | observability | 2F | FIXED — union-literal label types |
| F9-3 | Med | observability | 2F | FIXED — logger redacts short query aliases + user-id fields |
| F10.2 | Med | benchmark | 2F | FIXED — per-run search state counts (no last-run overwrite) |
| F12-1 | Med | doc honesty | 2F | FIXED — runbook detection rows marked `[when instrumented]`; checklist adds the wiring step |
| 8.2 / 8.3 | Med | dark isolation | 2F | FIXED — fence covers `spotme/web/api`; asserts no `now.json`/`.vercel`; scans vercel `functions`/`builds` |
| F2 | Med | location | 2E | DOCUMENTED — privacy budget is the ~110 m grid, not the (public-seed, reversible) jitter; a secret salt / ADR-018 cell is an activation decision |
| F7-6 | Med | frontend | 2E | DOCUMENTED — controller notifications no-op under `useSyncExternalStore`; the App `bump` covers today; fold-into-snapshot deferred to activation |
| F9 (search) | Low | privacy | 2C | DOCUMENTED — search text rides the GET query string; switch to POST `/multi_search` is activation hardening |
| F10.3 / F10.4 / F10.5 | Low | benchmark | 2F | FIXED — unmeasured findings relabelled analysis; seeding label corrected; every origin warmed |
| F9-4 / F9-5 | Low | observability | 2F | FIXED — log constants spread last (unoverridable id); histogram buckets extended to 5/10 s |
| F11.3 | Low | test | 2F | FIXED — fence regex catches barrel imports; serialization fence points at the service projection |
| F12-2 / F12-3 | Low | doc honesty | 2F | FIXED — tech-stack p95 wording matches the recorded 62.4 ms; §13.9 cites PR #85 |
| F7-2 / F7-8 / F7-9 | Low | a11y | 2E | FIXED — markers announce display names + Enter/Space + focus; list `aria-setsize`/`aria-posinset`; open-now 44 px target |
| F7-5 | Low | frontend | 2F | DOCUMENTED — text→intent path not wired (activation work) |
| F7-11 | Low | frontend | 2E | DOCUMENTED — `superseded` is a producer-less contract state (controller drops silently) |
| F3.2 | Low | schema | 2B | DOCUMENTED — block projection has no FK by design; deletion is via the projection rebuild sweep (runbook §16.3) |

## Verdict

All **High** findings fixed. All **Medium** findings fixed except two that are
genuine activation-time decisions (F2 jitter model, F7-6 store shape),
documented honestly. **Low** findings fixed where trivial, documented
otherwise. Every fix carries a regression test; the controlling privacy
guarantee — the precise fix never leaves the device — was re-verified by the
mutation battery after the changes. Nothing was activated, deployed, or wired;
the whole stack remains DARK.
