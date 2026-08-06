# AI Interactive Map — Contracts & Threat Model (Phase 6A)

> **Status: Implemented (Draft PR — DARK).** Contracts + threat model only.
> No module, no route, no UI, no model call. Deterministic-only phase: no AI
> SDK, model name, endpoint, or env var exists in the assistant subtree (X10).

## 1. Contracts (`packages/contracts/src/assistant.ts`, v1)

The fabrication-unrepresentable core (X1–X6, X8):

- **`NonEmptyArray<T>`** — the fail-closed primitive. `CitedClaim.citationIds`,
  `CitedSummary.claims`, and `CitedSummary.sources` are non-empty **by type**:
  an uncited claim or an evidence-free summary cannot be constructed.
- **`AssistantAnswer`** — a discriminated union with **no prose variant**:
  `results` (the only content-bearing arm, carrying a `CitedSummary`) |
  `insufficient-evidence` (with a closed reason) | `domain-not-active` (X8) |
  `unavailable`. Honest emptiness is a first-class answer, not a fallback
  string.
- **`EvidenceRecord`** (X2) — immutable branded id, source id+type, the CLOSED
  six-member license class (`first-party | authorized-provider |
  licensed-provider | owner-supplied | consented-community | fixture` —
  `scraped`/`unknown` are not members; the 6B boundary THROWS on non-members,
  DPAS 05 §5.8 / D11a), retrieved/source-updated timestamps, freshness,
  opaque sanitized `contentRef`, integrity digest, attribution label,
  permitted-use scope. Deliberately ABSENT fields: raw provider payloads,
  credentials, precise coordinates, HTML, executable content, provider
  prompts/instructions.
- **`FreshnessState`** (X4) `current | stale | superseded | unknown`;
  `CurrentStateCategory` names the claim categories (hours, event schedule,
  route leg, road condition, presence) that stale/unknown evidence can never
  support — the 6B composition gate.
- **`EvidenceCategory`** closed; citations must MATCH claim category (X3) — a
  `place-name` record cannot support an hours or ETA claim (6B enforces).
- **`ClaimConfidence`** (X5) — basis is `sourceDiversity + freshness +
  density`, structurally not a record count.
- **Review shapes** (X5) — `ReviewFacet` per-field `supported | mixed |
  insufficient-evidence | not-applicable`, mixed keeps BOTH conflicting claims
  visible; **no rating field exists** on any review shape.
- **Route shapes** (X6) — `RouteOrigin` is branded `CoarsePublicLocation` OR a
  user-chosen place reference; a precise device fix is unassignable.
  `RouteLeg` is attributed provider passthrough with a citation;
  `StraightLineEstimate.label` is the fixed literal `'straight-line estimate'`.
- **`DomainDarknessRegistry`** (X8) — total over the five assistant domains;
  Discovery/Exchange/Events/Moments are `implemented-dark` → live composition
  answers `domain-not-active`.
- **`AssistantQuery`** — text + optional branded coarse origin + the disabled
  `VoiceSeamRef` (a NAME for the merged Phase 1E VoicePort seam, not an
  engine). Query text is never persisted, logged, or hashed (X9 — enforced in
  6B). `SensitiveQueryCategory` is a closed enum; a CATEGORY is ever stored,
  never text.

Compile-time negatives (`assistant-negative.test.ts`): prose answer kind
rejected; bare-string summary rejected; empty `citationIds` rejected; empty
claims list rejected; `scraped`/`unknown` license class rejected; coordinates
/ raw payload / provider prompt absent from evidence; rating/stars absent from
review shapes; raw `{lat,lon}` unassignable as route origin; straight-line
label cannot claim to be a route distance. `assistant-usage.test.ts` is the
positive control (valid cited answer, exhaustive union narrowing with a
`never` proof, mixed facet with both sides visible, both route kinds, total
darkness registry).

## 2. Threat model (Phase 6)

| # | Threat | Control |
|---|---|---|
| T-AS-1 | **Fabrication / hallucinated answers** | No prose path (X1): every displayed sentence renders FROM a `CitedClaim` with ≥1 citation, or the answer is an honest non-results kind. Deterministic composition only this phase — there is no generator to hallucinate. |
| T-AS-2 | **Citation spoofing** (cite something that doesn't say that) | Citations resolve within the SAME envelope only; category match enforced (place-name can't support hours/ETA); labels come from the normalized record, never prose; removing evidence invalidates dependent claims (X3, 6B invariants + 6E fences). |
| T-AS-3 | **Scraped / unlicensed content** | CLOSED license class; `scraped`/`unknown` unrepresentable at type level and THROW at the 6B ingestion boundary; permitted-use scope carried per record; attribution mandatory (X2, DPAS 05 §5.8, D11a FIXED). |
| T-AS-4 | **Stale data presented as current** ("open now" from last month's hours) | `CurrentStateCategory` × `FreshnessState` gate: stale/unknown may display WITH disclosure but can never support currently-open / available-now / current-ETA / active-event / road-condition claims (X4). |
| T-AS-5 | **Query privacy loss** | No raw query persistence/cache; no query text in logs/traces/metrics/exceptions/analytics; no reversible hashes; bounded in-memory lifetime; request-scoped correlation id only (X9 — 6B mutation battery + 6E fences). |
| T-AS-6 | **Sensitive queries (health/crisis/legal/financial)** | Classification yields a closed CATEGORY, never stored text; no diagnosis/treatment/emergency-suitability claims without licensed evidence; no invented hotline/number; generic professional-help copy [PROPOSED — owner ratifies]; local emergency info requires a separately authorized verified source (X9). |
| T-AS-7 | **Precise-location leakage via routes** | `RouteOrigin` admits only the branded coarse projection or a user-chosen place ref; a device fix is a compile error and a 6B boundary throw; precise location stays device-local (X6). |
| T-AS-8 | **Dishonest ETAs / distances** | Provider legs are attributed passthrough (nothing computed the provider didn't supply); the fallback is ALWAYS labeled `straight-line estimate` by fixed literal — it cannot masquerade as a route (X6). |
| T-AS-9 | **Rating fabrication / sentiment laundering** | No rating field exists on any review shape; no sentiment-to-rating conversion; no popularity from review count; mixed facets keep conflicts visible; confidence basis is diversity+freshness+density (X5). |
| T-AS-10 | **Assistant as a bypass into dark domains** | X8 registry: dark domains answer `domain-not-active` in live composition; fixture mode is explicit and test-only; 6E fence-tests the non-bypass (X10). |
| T-AS-11 | **Prompt injection via provider payloads** | Evidence NEVER carries raw payloads, HTML, executable content, or provider prompts/instructions — the fields don't exist (X2); content is an opaque sanitized ref with an integrity digest; no field persists toward future model input (X10). |
| T-AS-12 | **Silent scope creep to a live model** | X10 fences: no AI SDK, no model name/endpoint/env var, no network-capable HTTP client anywhere in the assistant subtree; the Phase 1E gateway ports stay named dark seams. |

## 3. What 6A explicitly does NOT contain

No NestJS module, no controller, no persistence, no migration, no web-next
surface, no HTTP client, no provider integration, no model call, no query
handling code. Types + compile-time fences + docs only.
