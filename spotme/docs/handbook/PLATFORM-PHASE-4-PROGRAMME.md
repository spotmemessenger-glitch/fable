# Platform Phase 4 — Live Nearby Events (dark foundation)

> **Status: Implemented (Draft PR — DARK), in progress.** Phase 4 builds the
> dark foundation for **Live Nearby Events** (Discovery Programme step 3 — the
> local, privacy-safe, provider-neutral surface of what's happening nearby). It
> ports the approved **#61** legacy-web `live-events` design into the new stack
> (contracts → NestJS/PostGIS backend → web-next). Nothing is activated, wired,
> deployed, or user-visible; every numeric default stays a documented
> `[PROPOSED]`/pending-A5 config seam. No production provider, no keys.

## #61 classification (Phase 0)

#61 (`feat/live-nearby-events`, `a6baf318`) is a complete **legacy-web JS**
foundation under `spotme/web/src/lib/live-events/`, built on Discovery-V2
(PR #60, also legacy-web). Phase 4 rebuilds Events in the **new** stack, so #61
is a **design source to port**, not code to move:

| #61 module | Verdict | Phase 4 disposition |
|---|---|---|
| `contracts.js` | Reusable → adapt | Blueprint for 4A `EventPublic`; adapted to branded `CoarsePublicLocation` + full C3 provenance. |
| `time.js` | Reusable → adapt (harden for C5) | Ported to the 4B time-state engine; add end<start rejection, all-day, DST tests, postponement provenance, provider-only recurrence. |
| `ranking.js` | Reusable → adapt (for C2) | Ported to 4C; closed registry throws on engagement/sponsored; unknown popularity shown as omitted, not zero. |
| `safety.js` | Reusable | `filterForSafety` + `assertNoOriginLeak` map onto the 4B/4C mutation guards. |
| `search.js` | Adapt (partly superseded) | Pipeline shape reused in the 4B service; client-side expanding-radius superseded by PostGIS `ST_DWithin`. |
| `linking.js` | Reusable → adapt | event→marker + honest straight-line directions → 4C web-next map surface. |
| `detail.js` | Reusable → adapt | Detail state machine → 4C controller. |
| `flags.js` | Superseded (mechanism) | Compile-time MASTER-gate superseded by the unimported-module darkness model; concept informs the 4D activation checklist. |
| `index.js` | Superseded | Inert-engine assembly superseded by the dark-module approach. |
| `test/live-events-*.test.js` | Reusable (proof design) | Proof obligations become fences/specs in the new stack. |

## Linear stacked chain (base master; nothing merges this mission)

Each PR's temporary base is the immediately preceding Phase 4 branch (C1);
retarget to master only after the parent merges. A repair on an earlier branch
is merged FORWARD (4A→4B→4C→4D) with ordinary merge commits before 4D validates
— no rebase, no force-push.

| Group | Branch | Base | Scope |
|---|---|---|---|
| 4A | `feat/platform-phase-4a-events-contracts` | `master` | Versioned contracts + policy + threat model + this programme |
| 4B | `feat/platform-phase-4b-events-backend` | 4A branch | Dark `EventsModule` + additive PostGIS storage + provider port (fixture/unavailable only) + time-state engine + dedup + sanitized projection |
| 4C | `feat/platform-phase-4c-events-webnext` | 4B branch | Transparent ranking + inert web-next Events surface |
| 4D | `feat/platform-phase-4d-events-fences-ops-docs` | 4C branch | Dark fences + closed metrics + runbooks + benchmark + docs + status rows |

## Standing bar (Phase 2/3 verbatim)

Branded `CoarsePublicLocation` only; no precise GPS outbound (mutation tests);
closed ranking registries with explainable breakdowns (sourced popularity ONLY
as a bounded 0..1 provider field per C2; engagement signals throw);
anti-enumeration (opaque keyset cursor, no total count); unknown stays null,
nothing invented; additive migrations tested clean+upgraded; keyset pagination;
dark modules unimported by `AppModule`; non-vacuous fences; docs at real paths;
status = Implemented (Draft PR — DARK).

## Owner-retained (not delegated)

All merges (every PR stays DRAFT), activation/flag flips, deploys, production
providers/credentials, `#43/#60/#61/camera` (read #61 for reuse; never modify),
gender/age (A3), payments/ads, deletions. Ranking weights, retention/TTL, and
the category allow-list are config seams with documented defaults, pending A5.

## Build record

| Group | PR | State | Evidence |
|---|---|---|---|
| 4A | #92 | Draft PR — DARK | `events.ts` v1 + negative/usage compile-time fences + threat model; contracts typecheck + build + boundary fence 6/6 |
| 4B | #93 | Draft PR — DARK | dark `EventsModule` + 3 PostGIS tables + normalize/time/dedup/safety + provider port (fixture/unavailable) + keyset browse; pure-logic specs (30) + real-PostGIS e2e (7); migration clean + upgraded; backend suite 342 |
| 4C | #94 | Draft PR — DARK | closed-registry ranking (popularity tie-break only, unknown omitted) + inert web-next surface; ranking spec (8) + web-next controller/ui/mutation (16); web-next 67 + fence 6/6 |
| 4D | #95 | Draft PR — DARK | dark fences (11) + closed metrics registry (observability spec) + benchmark (50k achieved) + runbooks + activation checklist + docs |
