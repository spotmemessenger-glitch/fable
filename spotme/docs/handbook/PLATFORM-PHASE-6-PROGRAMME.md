# Platform Phase 6 — AI Interactive Map (dark foundation)

> **Status: Implemented (Merged — DARK).** The Phase 6 chain #103–#107 landed
> on `master` 2026-08-04 (`0470217`…`629a4f1`) under the delegated review-and-
> merge authority. Phase 6 built the
> dark foundation for the **AI Interactive Map assistant** — the fifth and
> FINAL layer of the Discovery programme (X12): after it comes Infrastructure
> & Controlled Activation, not another feature build. Executed under the
> recorded X1–X12 corrections (typed claims not prose; evidence integrity;
> fail-closed citations; freshness; review facets; route location boundary;
> ports-only; domain darkness registry; strict query privacy; 6E fences; 13
> review lenses; framing). **Deterministic-only:** no AI SDK, model, endpoint,
> or env var anywhere in the assistant subtree — the Phase 1E AI Gateway ports
> stay dark seams; LLM provider choice is owner-retained. Nothing is
> activated, wired, deployed, or user-visible.

## Linear stacked chain (base master; nothing merges this mission)

Repairs merge FORWARD (6A→6E) with ordinary merge commits before 6E validates;
no rebase/force-push; each PR notes its temporary base.

| Group | Branch | Base | Scope |
|---|---|---|---|
| 6A | `feat/platform-phase-6a-assistant-contracts` | `master` | Contracts v1 (no-prose answer union, `NonEmptyArray` citations, closed license classes, freshness, facets, route boundary, darkness registry) + compile-time negatives/positive control + threat model + this programme |
| 6B | `feat/platform-phase-6b-assistant-backend` | 6A | Dark AssistantModule behind the X7 ports (AssistantDomainPort, five EvidencePorts, ReviewSourcePort, RouteEvidencePort): deterministic intent routing, X8 registry answering `domain-not-active`, deterministic template composition from claims, evidence ingestion boundary (license-class THROW, category match, freshness gate), X9 query-privacy battery, closed sensitive-query classification |
| 6C | `feat/platform-phase-6c-route-review` | 6B | X5 review-facet engine (per-field states, conflicts visible, no rating anywhere) + route phase-1 (X6 boundary: coarse/place-ref origins only, attributed provider passthrough, labeled straight-line; fixture + unavailable adapters only) |
| 6D | `feat/platform-phase-6d-assistant-webnext` | 6C | Inert web-next conversational map surface: query bar, VoicePort disabled seam, cited answer cards (renderer composes FROM claims; citation labels from records), honest empty/dark/unavailable states, facet panel, route cards, a11y + privacy-mutation battery, fixtures only, App unchanged |
| 6E | `feat/platform-phase-6e-assistant-fences-ops-docs` | 6D | The full X10 fence battery (no prose path, no uncited claim, no cross-request citation, no stale-as-current, no generated rating, no raw HTML/prompt fields, no query persistence/hash, no domain-internal imports, no dark-domain bypass, no precise route origin, NO AI SDK/model/endpoint/env var, NO network HTTP client) + citation-integrity invariants + closed metrics + runbooks + activation checklist + docs + status rows; validates the full chain |

## Standing bar (Phases 2–5 verbatim)

Branded `CoarsePublicLocation` only, single minting point; no precise GPS
outbound (mutation batteries); distance bands for anything person-attached;
anti-enumeration; additive migrations clean+upgraded; keyset pagination;
optimistic concurrency; dark modules unimported by `AppModule`; non-vacuous
fences; closed metrics on the 1G gates; docs at real paths; web-next only,
legacy web untouched.

## Owner-retained (not delegated)

All merges (every PR stays DRAFT) · activation/flags · deploys · production
AI/search/review provider credentials or spend · **LLM/model calls of any
kind** (deterministic composition + adapter seams only) · amending the
no-scrape rule (D11a FIXED: authorized/licensed sources only) ·
sensitive-query copy ratification ([PROPOSED] until then) · #43/#60/#61/camera
branches · gender/age (A3) · payments/ads · deletions.

## Build record

| Group | PR | State | Evidence |
|---|---|---|---|
| 6A | #103 | **Merged — DARK** (`0470217`) | `assistant.ts` v1 + negative/usage compile-time fences + threat model (T-AS-1..12); contracts typecheck + build + boundary fence 6/6 |
| 6B | #104 | **Merged — DARK** (`75815a5`) | dark AssistantModule (unimported): X7 ports, live darkness registry (all domains implemented-dark), deterministic intent + template composer, evidence mint boundary (license THROW / forbidden-field THROW / X3 category match / X4 freshness gate), QueryHandle + closed-code errors (X9), [PROPOSED] sensitive copy; 49 tests green (incl. F2-F4 regressions) |
| 6C | #105 | **Merged — DARK** (`9276c87`) | X5 review-facet engine (closed facet registry, mixed keeps both sides, no rating key anywhere, honest insufficient-evidence rows) + route phase-1 (X6: origin/destination QUANTIZED to the public grid, F1-corrected from the exact-grid throw; attributed provider passthrough with CURRENT route-leg citations; labeled straight-line with no duration field; road-reports named as a future Moments seam, not built); 25 tests green (incl. F1/F4 regressions) |
| 6D | #106 | **Merged — DARK** (`5cacb17`) | inert web-next conversational surface: query bar + honestly-disabled VoicePort mic seam, cited answer cards (labels from normalized records, unresolved renders as explicit failure, stale disclosure), honest state cards, mixed-facet review panel (no stars), route cards (attributed passthrough / verbatim straight-line label / honest unavailable), digit-free sensitive notice, privacy-mutation battery incl. query-text scan; App unchanged |
| 6E | #107 | **Merged — DARK** (`629a4f1`) | X10 fence battery (16 assertions, tamper-checked non-vacuous) + citation-integrity invariants (frozen records, evidence-removal invalidation, no cross-envelope citation, no uncited source rides along) + closed metrics (query text can never be a label — refused by key name AND enum membership) + runbooks (provider outage, evidence integrity, privacy incident, dark rollback) + owner-gated activation checklist + docs 02/03; validates the full chain post-repair (backend 146, contracts fence 6/6, web-next 105) |

## Landing (2026-08-04, delegated approval)

The Phase 6 chain (6A→6E) landed on `master` via a five-commit merge train
(`master` `d0fc160` → `629a4f1`): #103 `0470217` → #104 `75815a5` → #105
`9276c87` → #106 `5cacb17` → #107 `629a4f1`. Each PR was marked Ready for
Review, verified against its expected head (the X11 repair descendants
`bd7150c`/`1336b90`/`245ecbf`/`eae7cb9` were the documented heads),
scope-inspected, retargeted to master stepwise, and merged with a merge
commit — no squash/rebase/force-push; no GitHub refusal, so the base-advance
precedent was not needed.

**Post-landing verification on `629a4f1`:** backend 52/52 suites (517 tests;
the only 5 skipped suites are the documented env-gated opt-ins — four
`*-benchmark.e2e-spec.ts` + `s3-integration.spec.ts`); all five programme
dark fences run by filename (`discovery|exchange|events|moments|assistant-
dark-fences.spec.ts` + `assistant-citation-observability.spec.ts`, 72 green);
legacy web 1017/1017 (incl. `signing-not-shipped`, `e2e-v3-not-shipped`,
`ai-gateway-not-shipped`); contracts fence 6/6 + build; web-next 105 +
isolation fence 6/6 + build. Environment-free startup (DB + JWT secret only):
`/api/v1/{assistant,moments,discovery,exchange,events}/...` all **404**,
real routes live (`/api/auth/guest` 400, `/api/users/lookup` 401), zero
assistant mentions in the boot log. Secret scan over all 44 landed files
clean. `AppModule` and `App.tsx` untouched; protected heads (#60 `3e2c709`,
#61 `a6baf31`, camera `c7c8020`, multi-device `fc26de4`) byte-identical;
crypto conditions false.

Owner-retained, unchanged by landing: activation/flags · provider
licensing/spend · LLM provider choice (through the AI Gateway, deterministic
baseline as mandatory fallback) · sensitive-copy ratification · per-domain
activation order.
