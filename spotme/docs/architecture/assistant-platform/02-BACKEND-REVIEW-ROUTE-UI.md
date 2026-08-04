# AI Interactive Map — Backend, Review Intelligence, Routes & UI (Phases 6B–6D)

> **Status: Implemented (Draft PR — DARK).** `AssistantModule` is NOT imported
> by `AppModule`; the web-next surface is NOT mounted by `App`. Deterministic
> only — no AI SDK, model, endpoint, env var, or network client exists in the
> assistant subtrees (fence-proven, 6E).

## 1. Backend (6B, `backend/src/assistant/`)

**Ports-only composition (X7):** AssistantDomainPort (X8 darkness registry) +
five per-domain evidence ports + ReviewSourcePort + RouteEvidencePort + the
IntentPort/SummaryPort seams. Live bindings: every domain `implemented-dark`
(→ every live answer is `domain-not-active`) and UNAVAILABLE evidence
adapters. Fixture adapters throw at construction outside a test environment.

**The mint boundary (X2/X3/X4, `assistant.evidence.ts`):** every
EvidenceRecord is minted allow-list style; non-member license classes
(`scraped`/`unknown`) throw by name; forbidden fields (payloads, HTML,
prompts/instructions, credentials, precise coordinates) throw by presence;
envelope validation fails closed (in-envelope resolution, category match,
stale-never-supports-current); confidence = diversity + worst freshness +
density (X5).

**Deterministic composition (`assistant.compose.ts`):** claim text renders
ONLY from a closed template registry with sanitized params (control chars +
markup stripped); unknown template key throws; zero surviving claims → null →
`insufficient-evidence`. There is no prose path.

**Query privacy (X9, `assistant.privacy.ts` / `assistant.errors.ts`):**
QueryHandle is the only text carrier — serialization-proof, bounded lifetime
(disposed in the service `finally`); AssistantError has a closed code set and
NO free-text channel; correlation ids are random, never text-derived;
sensitive classification yields a closed category; [PROPOSED] notice copy is
digit-free (no invented hotline) — ratification owner-retained.

## 2. Review intelligence (6C, `assistant.review.ts`, X5)

Closed facet registry (`service`, `noise-level`, `cleanliness`, `wait-time`,
`value`, `best-time-to-visit`); unknown field throws. States: `supported` |
`mixed` (BOTH conflicting claims stay visible) | `insufficient-evidence` |
`not-applicable`. NO rating of any kind — no stars/score key exists on any
output (fence-scanned). Nothing derives from record counts.

## 3. Routes phase-1 (6C, `assistant.route.ts`, X6)

Origins: the coarse public grid (3-decimal) or a user-chosen place-ref — a
device-precision coordinate THROWS `precise-route-origin` (never silently
rounded; coarsening is device-local). Provider legs are attributed
passthrough citing CURRENT `route-leg` evidence; absent numbers stay null.
The fallback is the fixed-label `straight-line estimate` with distance only —
the shape has no duration field. Community road-reports are NAMED as a future
Moments content-type seam; nothing is built (owner-gated).

## 4. Web-next surface (6D, `web-next/src/assistant/`)

Framework-free controller behind ports; precise fix only inside the
`coarsenForPublic` boundary. QueryBar with the Phase 1E VoicePort seam as an
HONESTLY DISABLED mic (reason exposed to AT). Answer cards render only
CitedClaims; citation chips labeled from `EvidenceRecord.attributionLabel`
(X3); unresolved citations render as explicit failures; stale-cited claims
carry an out-of-date disclosure (X4). Honest state cards for
insufficient-evidence / domain-not-active / unavailable / fixed-message
failure. X5 facet panel (conflict announced, both sides shown, no stars). X6
route cards (attributed passthrough, verbatim straight-line label, no time).
Privacy-mutation battery scans outbound payloads, console, and rendered state
for precise markers AND the query-text marker.

## 5. Verification map

| Concern | Suite |
|---|---|
| Mint boundary, envelope, confidence | `backend/test/assistant-evidence.spec.ts` |
| Intent + sensitive classification/copy | `backend/test/assistant-intent-sensitive.spec.ts` |
| Composition + service + fixture guards | `backend/test/assistant-compose-service.spec.ts` |
| X9 privacy battery | `backend/test/assistant-privacy.spec.ts` |
| X5 facets | `backend/test/assistant-review.spec.ts` |
| X6 routes | `backend/test/assistant-route.spec.ts` |
| X10 fences + darkness | `backend/test/assistant-dark-fences.spec.ts` |
| Citation invariants + closed metrics | `backend/test/assistant-citation-observability.spec.ts` |
| Client controller / privacy / UI+a11y | `web-next/test/assistant-{controller,privacy-mutation,ui}.*` |
