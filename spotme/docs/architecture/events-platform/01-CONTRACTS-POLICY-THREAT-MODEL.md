# Live Nearby Events — Contracts, Policy & Threat Model (Phase 4A)

> **Status: Implemented (Draft PR — DARK).** Contracts + policy + threat model
> only — no module, no persistence, no route, no ranking engine, no UI. This
> chapter establishes the versioned contract set (`EVENTS_CONTRACTS_VERSION = 1`)
> the later 4B–4D groups build on, ported from the approved #61 legacy-web
> `live-events` design into the new TypeScript stack.

## 1. What Events adds over Discovery/Exchange

Events are **public listings** at public venues. The privacy risk therefore runs
the *opposite* direction from people-presence: the danger is leaking the **user**
back out (their device-local search origin), or surfacing **untrustworthy
content** (fake, spammy, or poisoned listings). The contracts encode both:

- The only location on a public event is the branded `CoarsePublicLocation`
  (venue point — public, but still coarse-branded). There is **no origin field**
  on any event shape, so the user's search centre cannot ride out on a result.
- Every event carries a **mandatory `EventSource`** (C3): provider, provider
  event id, provider source id, canonical organizer reference, source
  revision/updated timestamp, source confidence, and cancellation/postponement
  provenance. **Raw provider payloads are never carried and never persisted.**
- Trust is a first-class type property: absent means unknown, never invented.

## 2. Policy table — fixed vs [PROPOSED] vs owner-retained

| Rule | Status | Where enforced |
|---|---|---|
| Public event location is coarse-branded; user origin never on a result | **Fixed** | `EventPublic.venue: CoarsePublicLocation`; no origin field; 4B `assertNoOriginLeak` mutation guard |
| Source-asserted `cancelled`/`postponed` overrides the clock | **Fixed (C3)** | `EventState`; 4B time-state engine |
| Every event carries full source attribution + provenance | **Fixed (C3)** | `EventSource` (mandatory on `EventPublic`) |
| Sourced popularity is optional, provider-attributed, bounded 0..1, weighted LAST; unknown → omitted, never invented | **Fixed (C2)** | branded `EventPopularity`; `EventRankingBreakdown.omittedSignals`; 4C engine |
| Popularity may break close ties but never resurrect an ineligible/expired/blocked/cancelled/materially-more-distant result | **Fixed (C2)** | 4C ranking (popularity ranked last, hard gate first) |
| Closed ranking signal set — no engagement/sponsored/personalised path | **Fixed** | `EventRankingSignal` union (engagement/sponsored unrepresentable); 4C throws if handed one |
| Cross-provider dedup requires normalized-title + venue-identity + time-overlap + coarse-area; ambiguous stays separate; explainable | **Fixed (C4)** | `EventDedupDecision` + `EventDedupEvidence`; 4B dedup |
| UTC instants, source tz preserved (display only), all-day explicit, end<start rejected, recurrence only from provider occurrence ids | **Fixed (C5)** | `EventTime`; 4B time engine |
| No age/gender anywhere (A3); no payments/ads | **Fixed** | no such field in any contract |
| Ranking weights (`time`/`distance`/`relevance`/`popularity`) | **[PROPOSED] / pending-A5** | 4C config seams with documented defaults |
| Retention window / staleness TTL / default event duration | **[PROPOSED] / pending-A5** | 4B config seams with documented defaults |
| Category allow-list | **[PROPOSED] / pending-A5** | `EventCategory` (documented default set) |
| Which providers are integrated, and any labeled sponsorship of listings | **Owner-retained** | 4B ships fixture + unavailable adapters ONLY; no production provider, no keys |

Unresolved product policy is **never** silently converted into an approved
decision — it is a config seam with a documented default, labelled `[PROPOSED]`.

## 3. Threat model

| # | Threat | Control (Phase 4) |
|---|---|---|
| T-EV-1 | **Fake events** (a listing for an event that does not exist) | Mandatory `EventSource` with confidence + provenance; nothing is invented — a field a source didn't supply stays null; low-confidence handling is a 4B/4C config seam; report/block path. |
| T-EV-2 | **Lure to location** (a fabricated event used to draw a user to a place) | Same source-attribution + confidence surface; the UI credits the source so a user can judge trust; venue is the *event's own public* point, never a private address; safety flags remove source-flagged unsafe/age-restricted listings. |
| T-EV-3 | **Spam / listing flooding** | Conservative dedup (C4) collapses duplicates; closed ranking with no engagement signal denies a spam-amplification path; per-source bounds are a 4B config seam; block-by-source. |
| T-EV-4 | **Provider poisoning** (a compromised/hostile feed injecting content) | Whitelist normalization copies only known fields into a fresh record (raw payload never persisted); `assertNoSecrets`-style guard on adapters; source confidence + provenance carried; a blocked provider/source/organiser is filtered out. |
| T-EV-5 | **User-origin leak** (the device search centre riding out on a result) | No origin field exists on any event shape; 4B `assertNoOriginLeak` mutation guard fails the build if a future change attaches it; branded venue location. |
| T-EV-6 | **Enumeration** (walking the cursor to scrape the corpus / triangulate) | Opaque signed keyset cursor; no total count on a page; banded distance on the public projection. |
| T-EV-7 | **Stale / cancelled shown as live** | Source cancel/postpone overrides the clock; time-derived state; retention/TTL pruning; provenance explains why a state changed. |
| T-EV-8 | **Popularity manipulation** (gaming a crowd number to rank) | Popularity is a bounded 0..1 *sourced* field, weighted last, and can only break ties — never resurrect an ineligible/expired/blocked/cancelled/distant result; unknown is omitted, not invented (C2). |
| T-EV-9 | **Recurrence spoofing** (inflating one event into many occurrences) | Recurrence is expressed ONLY by a stable provider-supplied `occurrenceId`; never inferred (C5); dedup collapses exact provider identity. |
| T-EV-10 | **Timezone / DST confusion** (an event shown at the wrong local time) | UTC instants for all reasoning; source IANA tz preserved for display only, never guessed; DST + all-day covered by the 4B time tests; end<start rejected. |

## 4. Compile-time fences (this group)

`test/events-negative.test.ts` — `@ts-expect-error` asserts non-compilation of:
a raw `{lat,lon}` as a venue, an `age`/`gender` filter, a raw popularity number,
an `engagement`/`sponsored` ranking signal, a plain-string cursor, an arbitrary
`EventState`/lifecycle, and a source-less event. `test/events-usage.test.ts` is
the positive control (valid event, source-wins cancellation with provenance,
exhaustive state narrowing, a ranked result whose total equals the sum of its
weighted components with popularity omitted, an explainable cross-provider dedup,
and a page with no total count). Package `tsc --noEmit` and the declaration build
both pass; import-boundary fence 6/6.

## 5. Non-goals (4A)

No `EventsModule`, no Prisma models, no routes, no provider adapters, no ranking
engine, no search, no UI, no activation. Providers, retention/TTL values, and
ranking weights are config seams with documented defaults — none is an approved
decision.
