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

| Group | Branch | State | Evidence |
|---|---|---|---|
| 3A | `feat/platform-phase-3a-exchange-contracts-policy` (PR #86) | Pushed, green | contracts + negative fences + threat model |
| 3B | `feat/platform-phase-3b-exchange-backend` | Pushed, green | dark ExchangeModule + 5 PostGIS tables + lifecycle engine; policy spec 15/15, real-PostGIS e2e 8/8; migrations clean + upgraded |
