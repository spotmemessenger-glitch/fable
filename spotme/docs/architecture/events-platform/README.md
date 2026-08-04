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
