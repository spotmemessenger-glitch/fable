# Platform Phase 3 — SpotMe Exchange (dark foundation)

> **Status: Implemented (Draft PR — DARK), in progress.** Phase 3 builds the
> dark enterprise foundation for SpotMe Exchange — the local, privacy-safe,
> AI-matched marketplace of needs and offers (Discovery Programme step 2). It
> builds ON the complete Phase 2 chain. Nothing is activated, wired, deployed,
> or user-visible; every numeric default from the Exchange PRD stays a
> documented `[PROPOSED]`/pending-A5 config seam.

## Linear stacked chain

Each PR's temporary base is the immediately preceding Phase 3 branch; retarget
to master only after the parent merges. Landing order is strict.

| Group | Branch | Base | Scope |
|---|---|---|---|
| 3A | `feat/platform-phase-3a-exchange-contracts-policy` | `feat/platform-phase-2f-fences-perf-ops-docs` | Versioned contracts + policy + threat model |
| 3B | `feat/platform-phase-3b-exchange-backend` | 3A branch | Dark ExchangeModule + additive PostGIS models + lifecycle engine |
| 3C | `feat/platform-phase-3c-exchange-matching` | 3B branch | Matching + search + transparent ranking (safety hard gate) |
| 3D | `feat/platform-phase-3d-exchange-webnext` | 3C branch | Inert web-next Exchange experience |
| 3E | `feat/platform-phase-3e-exchange-fences-ops-docs` | 3D branch | Dark fences, performance, operations, docs, cumulative validation |

## Standing constraints (inherited + Exchange-specific)

- **All Phase 2 privacy law binds Exchange.** Locations are the branded
  `CoarsePublicLocation`; the precise fix never leaves the device; distance is
  a band; no total counts where enumeration risk exists.
- **A3 absolute:** no gender/age field, filter, index, ranking signal, or UI
  control anywhere in Exchange.
- **No money in v1:** no payment, escrow, checkout, or money-transfer contract
  exists. An informational listing price is display-only and structurally
  disclaimered (`informational-only-no-payment`). Payments/escrow/advertising/
  sponsored-ranking are owner-retained and out of scope.
- **Consent-gated communication:** contact/chat follows explicit acceptance
  (`ExchangeContactCapability.requiresExplicitConsent: true`); nothing opens a
  conversation implicitly (PRD §03.4, P7).
- **Safety is a hard gate** in matching (a type property of
  `ExchangeMatchExplanation.safetyEligible: true`); proximity outranks
  popularity; no sponsored path in the closed signal registry; unknown
  evidence scores zero; every match carries an explanation.
- **[PROPOSED]/pending-A5 stays open.** Ratifiable implementation contracts are
  derived from the merged PRD and repository authority; unresolved product
  policy is never silently converted into an approved decision — it is a config
  seam with a documented default.
- **Business/reputation:** derived, non-sensitive, first-party only; labeled
  sponsorship (owner-retained) never mixes into organic ranking.

## Resume line

"Continue the Overnight Migration Programme Phase 3 from the last pushed PR;
verify all prior Phase 3 branches before continuing."

## Build record

| Group | PR | State | Merge SHA | Evidence |
|---|---|---|---|---|
| 3A | #86 | **Merged — DARK** | `a793609` | contracts + negative fences + threat model |
| 3B | #87 | **Merged — DARK** | `8c414cc` | dark ExchangeModule + 5 PostGIS tables + lifecycle engine; policy spec, real-PostGIS e2e; migrations clean + upgraded |
| 3C | #88 | **Merged — DARK** | `dd7bde7` | closed-registry matching engine + sanitized search projection (category coordinate-strip); proof obligations |
| 3D | #89 | **Merged — DARK** | `b769e6b` | inert web-next Exchange UI; consent gate, no-payment disclaimer, A3, functional Mine tab; web-next + fence 6/6 |
| 3E | #90 | **Merged — DARK** | `7659d43` | dark fences (10), instrumentation (closed registry), benchmark (100k achieved), runbooks, activation checklist |

## Landing (2026-08-04, delegated approval)

The Phase 3 chain (3A→3E) landed on `master` via a five-commit `--no-ff` merge
train (`master` `4a5b0d1` → `7659d43`), executed under the recorded 2026-08-04
owner delegation of engineering merge approval. Each merge re-verified crypto
flags false and the affected suites; the one merge conflict (Phase 2's merged
status rows vs 3A's stale draft rows in `03-IMPLEMENTATION-STATUS.md`) was an
additive-union resolved by keeping the newer merged rows and appending the new
phase row. Post-landing validation on `7659d43`: full backend (306) + legacy
web (1017) + contracts + web-next (52) suites green; crypto, discovery, exchange
(23), and isolation fences green; environment-free boot leaves discovery **and**
exchange routes 404 while real routes stay live; secret scan clean;
`ExchangeModule` unimported; both crypto flags false; all seven protected heads
byte-identical. **Everything landed DARK** — no activation, no wiring, no flag
flip. Activation (A5 PRD ratification, D4 business, provider config, the
one-line `AppModule` import + privacy re-review + rollback drill) stays
owner-retained.
