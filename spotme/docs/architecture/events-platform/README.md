# Live Nearby Events Platform Architecture (Phase 4, DARK)

Engineering spec for the Live Nearby Events dark foundation (Discovery Programme
step 3). Status throughout: **Implemented (Draft PR — DARK)** — nothing
activated, wired, mounted, or deployed. It ports the approved **#61** legacy-web
`live-events` design into the new stack (contracts → NestJS/PostGIS → web-next).

| # | Chapter | Covers |
|---|---|---|
| 01 | [Contracts, Policy & Threat Model](01-CONTRACTS-POLICY-THREAT-MODEL.md) | Versioned contracts (`EVENTS_CONTRACTS_VERSION=1`), fixed-vs-[PROPOSED]-vs-owner-retained policy, 10-threat model, #61 classification |
| 02 | [Backend, Persistence, Ranking & UI](02-BACKEND-PERSISTENCE-RANKING-UI.md) | 4B persistence + ingest pipeline (normalize/time/dedup/safety) · 4C transparent ranking · inert web-next surface |
| 03 | [Operations, Performance & Activation](03-OPERATIONS-PERFORMANCE-ACTIVATION.md) | 4D dark fences, instrumentation, measured performance, runbooks, activation checklist |

## The corrections, encoded

- **C2** — sourced popularity is optional, provider-attributed, bounded 0..1,
  weighted **last**, tie-break only; unknown ⇒ omitted, never invented.
- **C3** — full source identity + cancellation/postponement provenance; raw
  provider payloads never persisted.
- **C4** — conservative cross-provider dedup (title + venue + time + area), exact
  provider identity wins, ambiguous stays separate, explainable.
- **C5** — UTC storage with source timezone preserved, DST/all-day handled,
  end-before-start rejected, postponement replaces time with provenance,
  recurrence only from stable provider occurrence ids.

No payments/ads; no age/gender anywhere (A3); the device search origin never
appears on a result; no production provider or credential ships.

## Phase 4 adversarial-review disposition (13 lenses)

The 13-lens adversarial review of 4A–4D ran after the chain was built; every
finding was confirmed against the code before any change, and the actionable one
was fixed with a regression test on its own branch and merged forward (4B→4C→4D)
per C1 (nothing merged to master — all still DRAFT).

| ID | Sev | Where | Disposition |
|---|---|---|---|
| KEYSET-NULL | **Medium** | 4B repo/migration | **FIXED** — browse keyset used `startAt < cursor` with `NULLS LAST`, making NULL-start (tbd/postponed) events unreachable past a page boundary. Now orders + pages on `COALESCE("startAt", epoch)` consistently (partial index rebuilt on the same immutable expression); real-PostGIS regression test added. |
| DEDUP-CHAIN | Low | 4B dedup | **No change needed** — when a higher-confidence newcomer displaces a seated canonical, prior merge decisions form a two-hop pointer chain. Display is correct (browse hides every `canonicalId IS NULL = false` row, so exactly one canonical shows); the audit records are individually truthful. Flattening the chain is an activation-time nicety, not a correctness defect. |
| SERVER-ORIGIN-COARSEN | Low | 4B controller | **No change needed** — the browse origin is used only transiently for `ST_DWithin` and is never persisted (`assertNoOriginLeak` guards rows); the client coarsens before outbound (mutation battery). Optional server-side re-coarsening of the query origin noted as defense-in-depth for activation. |

The other lenses — privacy/origin-leak, C2 popularity (tie-break only, omitted
disclosed), C3 source completeness, C4 dedup conservatism (title-alone never
merges), C5 time safety (end<start / all-day / DST / recurrence / postponement),
dark posture (unimported / no keys / dist), anti-enumeration (signed
depth-bounded cursor, no total count), venue coarsening, ranking closed-registry
(engagement throws), additive migration (clean+upgraded), sanitized projection
(no coordinates), provider secret detection, and contract branding/negative
fences — were confirmed clean against the code.

Owner-retained items are unchanged and NOT decided here: `[PROPOSED]` ranking
weights (A5), retention/TTL, category allow-list, provider integration + any
labeled sponsorship, and every activation/flag flip.
