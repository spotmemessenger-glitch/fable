# Exchange Platform — Contracts, Policy & Threat Model (Phase 3A)

> **Status: Implemented (Draft PR — DARK).** The engineering counterpart to the
> Exchange PRD (`handbook/product/exchange/`). This chapter specifies the
> Phase 3A dark foundation: the versioned contract set, the policy it encodes,
> and the formal threat model the later Phase 3 groups must satisfy. Nothing
> here activates code. Every `[PROPOSED]`/pending-A5 value is a config seam, not
> an approved product decision.

## 1. Contracts (as built)

Authoritative types live in `packages/contracts/src/exchange.ts`
(`EXCHANGE_CONTRACTS_VERSION = 1`), exported from the package index. They are
framework-neutral, versioned, and privacy-branded:

- **Intents:** `ExchangeIntent = ExchangeNeed | ExchangeOffer | ExchangeService`
  over `ExchangeIntentBase`, with the eight-state `ExchangeIntentStatus`
  lifecycle (`draft → active → paused → matched → fulfilled → expired →
  withdrawn → removed`). Location is the **branded `CoarsePublicLocation`** from
  the discovery contracts — a raw `{lat,lon}` is unassignable by type.
- **Lifecycle audit:** `ExchangeLifecycleEvent` with closed `reasonCode`s (no
  free text in the audit stream).
- **Matching:** `ExchangeMatch` + `ExchangeMatchExplanation` with the closed
  `ExchangeMatchSignal` registry (`intentFit`, `proximity`, `availability`,
  `trust`, `freshness`) and `safetyEligible: true` as a **type property** — an
  ineligible match is unrepresentable. Distance is a `DistanceBand`, never
  metres between parties.
- **Identity/business/reputation:** `ExchangeOwnerRef` (a reference, never a
  profile — Exchange owns no identity lifecycle, A9), `ExchangeBusinessPublic`,
  `ExchangeReputationSummary` (derived, non-sensitive, first-party only).
- **Search/paging:** `ExchangeSearchQuery` (filters limited to category /
  availability / distance band — A3 leaves no room for age/gender),
  `ExchangePage<T>` with **no total count**, and the opaque branded
  `ExchangeCursor`.
- **Contact:** `ExchangeContactCapability` with `requiresExplicitConsent: true`
  — no shape opens a chat implicitly (P7).
- **No money:** there is no payment/escrow/checkout field anywhere;
  `ExchangeInformationalPrice` is display-only and carries the literal
  disclaimer `informational-only-no-payment`.

Compile-time fences: `test/exchange-negative.test.ts` (`@ts-expect-error` on
raw coordinates, age/gender filters, `safetyEligible: false`, sponsored
signals, an unbranded cursor, a payment field) with `test/exchange-usage.test.ts`
as the positive control.

## 2. Policy (encoded, with open questions preserved)

| Policy | Encoded as | Status |
|---|---|---|
| Approximate location only | branded `CoarsePublicLocation` on every public shape | **fixed** (inherited law) |
| No age/gender/sensitive traits | absent from every type; filter shape is closed | **fixed** (A3) |
| No payments in v1 | no payment contract; informational price disclaimered | **fixed** (owner-retained) |
| Consent before contact | `requiresExplicitConsent: true` | **fixed** (P7) |
| Safety is a hard gate | `safetyEligible: true` type property | **fixed** |
| Proximity outranks popularity | closed signal registry; no popularity/sponsored signal | **fixed** |
| Ranking weights `0.35/0.25/0.20/0.15/0.05` | config seam (defaults documented, not hardcoded) | **[PROPOSED]** pending A5 |
| Radius falloff, TTL (24 h), retention (30 d) | config seam | **[PROPOSED]** pending A5 |
| Category allow-list, safe-category set | config seam | **[PROPOSED]** pending A5 |
| Labeled business sponsorship | separate labeled slot, never organic score | **owner-retained** |

Unresolved product policy is **not** converted into an approved decision by any
Phase 3 code — it is a named config default the owner ratifies (PRD §13.1).

## 3. Threat model

Assets: intents (needs/offers), the public projection, presence/approximate
location, identity, reputation, the match graph, and moderation records.

| # | Threat | Control (where enforced in Phase 3) |
|---|---|---|
| T-EX-1 | Scam / advance-fee / bait-and-switch | Moderation pre-check + post-publish classifiers behind a port; in-conversation scam nudges; "no off-platform payment in v1" |
| T-EX-2 | Prohibited / illegal / unsafe goods | Category allow-list (config); pre-check block; human review for flagged |
| T-EX-3 | Counterfeit / misrepresented listing | Report + reputation feedback; two-reviewer rule for safety-critical actions |
| T-EX-4 | Price manipulation | No payment surface; informational price only; no ranking signal derived from price |
| T-EX-5 | Impersonation | Canonical identity authoritative; business verification gate; reputation shows "verified" without exposing private data |
| T-EX-6 | Off-platform payment lure | Anti-scam heuristics (external-link/credentialed-URL detection reused from the discovery guards); nudges |
| T-EX-7 | Unsafe meetup | Approximate-only location; consent gate; no exact location by matching |
| T-EX-8 | Stalking / triangulation | Branded coarse location; distance bands; no numeric distance; anti-correlation coarsening (ADR-018) |
| T-EX-9 | Spam / flooding | Rate/velocity limits + duplicate detection (config); earned reach for new accounts |
| T-EX-10 | Duplicate listings | Duplicate-content detection at compose |
| T-EX-11 | Sybil accounts | Device-set identity signals + verification raise throwaway cost; no reliance on precise location |
| T-EX-12 | Scraping / enumeration | Keyset pagination, no total count, signed depth-bounded cursor (reused from discovery), bounded radius |
| T-EX-13 | Review / reputation manipulation | Ratings gated to real conversations; first-party signals only; no purchasable reputation |
| T-EX-14 | Malicious business behavior | Verification gate; labeled sponsorship separate from organic; privacy-preserving business analytics |
| T-EX-15 | Moderation evasion | Post-publish re-classification; appeal with human decision + audit trail |
| T-EX-16 | Account takeover | Inherited platform auth; reputation/ban propagation across a user's device set |
| T-EX-17 | Coercion | Report/block/appeal on every object; safety nudges; no exact-location exposure |
| T-EX-18 | Result poisoning | Closed ranking registry; unknown evidence scores zero; deterministic explainable ranking |
| T-EX-19 | Search leakage | Sanitized public projections only in the index (no precise coords, private profile, message content, contact-book, age/gender) |
| T-EX-20 | Sensitive-category profiling | No sensitive-trait inference; sensitive-category needs get stronger privacy defaults, no proactive broadcast |
| T-EX-21 | Content-guard bypass in events/logs | Reused discovery publish-time content guard + redacting logger (coordinate values, credentials, query text) |

Controls that are **fixed** are enforced by the contracts/types now; controls
that depend on `[PROPOSED]` thresholds are named config seams the later Phase 3
groups wire behind fences, with defaults the owner ratifies. No control here
presumes an unratified product decision.

## 4. What Phase 3A does NOT do

No module, no persistence, no route, no matching, no search, no UI, no
provider, no activation. 3A is contracts + policy + threat model only — the
foundation the 3B–3E groups build on, each dark and additive.
