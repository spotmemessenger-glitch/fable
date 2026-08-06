/**
 * Live Nearby Events — shared contracts (Platform Phase 4, group 4A, DARK).
 *
 * Framework-neutral, types-only. The single wire/domain contract for every
 * Events surface (backend, web-next). It ports the APPROVED #61 design (the
 * legacy-web `live-events` foundation) into the new TypeScript stack and
 * encodes the mission's rules at the TYPE level wherever a type can carry one:
 *
 *  - PRIVACY (P2): the only location shape on a public event is the BRANDED
 *    {@link CoarsePublicLocation}. A raw `{lat, lon}` is a compile error — the
 *    device-local search origin never appears on an event at all (there is no
 *    origin field), and a venue point is public but still coarse-branded.
 *  - TRUST (P4): absent means UNKNOWN, never invented. Every optional signal is
 *    optional-by-omission; `exactOptionalPropertyTypes` forbids an explicit
 *    `undefined`. Popularity is a BRANDED bounded value (C2) that only the
 *    backend boundary can mint — a raw number cannot be dropped in as a crowd.
 *  - EXPLAINABLE RANKING (P5): {@link EventRankingBreakdown} is REQUIRED on a
 *    ranked result, and an unknown signal (e.g. popularity a source didn't
 *    supply) appears in `omittedSignals` — never as an invented zero (C2).
 *  - SOURCE TRUTH (C3): every event carries a mandatory {@link EventSource}
 *    with full provenance; a source-asserted `cancelled`/`postponed` lifecycle
 *    wins over the clock (see {@link EventState}).
 *  - TIME SAFETY (C5): instants are UTC epoch-ms; the source timezone is
 *    preserved for display only; all-day is explicit; recurrence is expressed
 *    ONLY by a stable provider-supplied {@link EventTime.occurrenceId}.
 *  - A3: there is no age or gender field anywhere in these contracts.
 */

import type { CoarsePublicLocation, DistanceBand } from './discovery.ts';

/** Contracts version — bump on any breaking change to the events shapes. */
export const EVENTS_CONTRACTS_VERSION = 1 as const;
export type EventsContractsVersion = typeof EVENTS_CONTRACTS_VERSION;

/* ------------------------------------------------------------------ *
 * Category & lifecycle
 * ------------------------------------------------------------------ */

/** Closed event category set (ports #61 `EVENT_CATEGORIES`). */
export type EventCategory =
  | 'music'
  | 'nightlife'
  | 'arts'
  | 'theatre'
  | 'film'
  | 'food'
  | 'sports'
  | 'community'
  | 'family'
  | 'education'
  | 'festival'
  | 'other';

/**
 * The lifecycle a SOURCE may assert explicitly. `cancelled`/`postponed` are
 * source truth and override any time-derived state.
 */
export type EventSourceLifecycle = 'scheduled' | 'cancelled' | 'postponed';

/**
 * The event's effective state. `upcoming`/`happening-now`/`ended` are DERIVED
 * from the clock vs the event window; `cancelled`/`postponed` are asserted by
 * the source and ALWAYS win over the clock (C3, ported from #61 `EVENT_STATE`).
 */
export type EventState =
  | 'upcoming'
  | 'happening-now'
  | 'ended'
  | 'cancelled'
  | 'postponed';

/* ------------------------------------------------------------------ *
 * Popularity — the ONLY optional ranking input, branded (C2)
 * ------------------------------------------------------------------ */

declare const EventPopularityBrand: unique symbol;

/**
 * A sourced popularity figure: bounded 0..1, PROVIDER-ATTRIBUTED, and minted
 * ONLY by the backend boundary that clamps and attributes it. Branded so a raw
 * `number` (or an engagement metric dressed up as one) cannot be assigned as
 * popularity without passing that boundary. Absent (`null`) means UNKNOWN and
 * MUST rank as an omitted signal — never an invented zero (C2).
 */
export type EventPopularity = number & { readonly [EventPopularityBrand]: true };

/* ------------------------------------------------------------------ *
 * Time — UTC instants, preserved source tz, explicit all-day (C5)
 * ------------------------------------------------------------------ */

/**
 * An event's temporal shape. All instants are UTC epoch-ms so reasoning is
 * timezone-safe and deterministic; `timezone` is DISPLAY metadata only. `null`
 * start/end means the source did not supply it (e.g. a postponed, undated
 * event) — never a guess. `end < start` is rejected at the boundary, so a valid
 * record never carries an inverted window.
 */
export interface EventTime {
  /** UTC epoch-ms; `null` when the source gave no start (tbd). */
  readonly startUTC: number | null;
  /** UTC epoch-ms; `null` when the source gave no end. */
  readonly endUTC: number | null;
  /** IANA timezone id (e.g. `"Asia/Kolkata"`) preserved for display; `null` if unknown. */
  readonly timezone: string | null;
  /** True for an all-day / date-only event (no meaningful wall-clock time). */
  readonly allDay: boolean;
  /**
   * A recurrence occurrence identifier — present ONLY when the provider supplies
   * a stable occurrence id for this instance. Recurrence is NEVER inferred (C5).
   */
  readonly occurrenceId?: string;
}

/* ------------------------------------------------------------------ *
 * Source attribution & provenance (C3)
 * ------------------------------------------------------------------ */

/**
 * Provenance for a source-asserted state change (cancellation/postponement):
 * who asserted it and when, so the surface can explain WHY an event shows as
 * cancelled/postponed rather than deriving it from the clock.
 */
export interface EventStateProvenance {
  readonly lifecycle: EventSourceLifecycle;
  /** The provider/source that asserted the change (audit). */
  readonly assertedBy: string;
  /** UTC epoch-ms the assertion was observed; `null` if unknown. */
  readonly assertedAtUTC: number | null;
  /** Optional public note the source supplied with the change. */
  readonly note?: string;
}

/**
 * Where an event came from — carried on EVERY event so the UI can credit the
 * source and a user can judge trust. No credentials, ever (C3): a public
 * provider/source name, ids, a revision timestamp, a confidence, and the
 * cancellation/postponement provenance. Raw provider payloads are NEVER carried
 * here (they are never persisted at all — see the 4B storage layer).
 */
export interface EventSource {
  /** The adapter name (audit). */
  readonly provider: string;
  /** The provider's own event id. */
  readonly providerEventId: string;
  /** The provider's source/feed id, when distinct from the event id; else `null`. */
  readonly providerSourceId: string | null;
  /** A canonical organizer reference (stable across a provider's events); `null` if none. */
  readonly organizerRef: string | null;
  /** Public display name of the origin (e.g. a listings org); `null` if none. */
  readonly sourceName: string | null;
  /** Public URL for the listing; `null` if none. */
  readonly url: string | null;
  /** UTC epoch-ms of the source's last revision/update; `null` if unknown. */
  readonly revisionUTC: number | null;
  /** Source-supplied confidence 0..1; `null` when the source gave none (unknown). */
  readonly confidence: number | null;
  /** Provenance of a source-asserted cancellation/postponement; `null` when scheduled. */
  readonly provenance: EventStateProvenance | null;
}

/* ------------------------------------------------------------------ *
 * The public event record
 * ------------------------------------------------------------------ */

/**
 * The stable public event — the ONLY event shape a surface renders. It carries
 * a coarse-branded venue point (public, but never precise), a banded distance
 * (anti-triangulation; a numeric distance, when shown, is computed device-local
 * and never travels), an optional branded popularity, and mandatory source
 * attribution. There is deliberately NO field for the user's search origin.
 */
export interface EventPublic {
  /** `${provider}:${providerEventId}`. */
  readonly id: string;
  readonly category: EventCategory;
  readonly title: string;
  readonly description: string | null;
  readonly time: EventTime;
  /** Derived, with source cancelled/postponed overriding the clock (C3). */
  readonly state: EventState;
  /** The public venue point — coarse-branded; a raw `{lat,lon}` is unassignable. */
  readonly venue: CoarsePublicLocation;
  /** Banded distance to the venue; `null` when unknown. */
  readonly distanceBand: DistanceBand | null;
  /** Sourced popularity, or `null` when the source supplied none (C2). */
  readonly popularity: EventPopularity | null;
  /** Mandatory source attribution + provenance (C3). */
  readonly source: EventSource;
  /** UTC epoch-ms this record was retrieved (freshness); `null` if unknown. */
  readonly fetchedAtUTC: number | null;
}

/* ------------------------------------------------------------------ *
 * Transparent ranking (P5, C2) — the closed signal set
 * ------------------------------------------------------------------ */

/**
 * The CLOSED ranking signal set. There is no engagement/sponsored/personalised
 * signal — those are not members of this union, so a breakdown cannot even name
 * one (the 4C engine additionally throws if handed one). `popularity` is
 * weighted LAST and is the only sourced-external signal (C2).
 */
export type EventRankingSignal = 'time' | 'distance' | 'relevance' | 'popularity';

/** One transparent component of a score: `weighted = weight * value`. */
export interface EventRankingComponent {
  readonly signal: EventRankingSignal;
  readonly weight: number;
  /** The signal value in [0,1]. */
  readonly value: number;
  readonly weighted: number;
}

/**
 * The full, explainable breakdown REQUIRED on every ranked result. A signal the
 * event could not supply (e.g. popularity a source didn't give) appears in
 * `omittedSignals` and contributes nothing — never an invented zero (C2).
 */
export interface EventRankingBreakdown {
  readonly components: readonly EventRankingComponent[];
  readonly omittedSignals: readonly EventRankingSignal[];
  readonly total: number;
}

/** A ranked event: the public event plus its required ranking breakdown. */
export interface RankedEventPublic extends EventPublic {
  readonly ranking: EventRankingBreakdown;
}

/* ------------------------------------------------------------------ *
 * Conservative cross-provider dedup — explainable (C4)
 * ------------------------------------------------------------------ */

/** How a dedup decision was reached. */
export type EventDedupBasis = 'exact-provider-identity' | 'cross-provider-match';

/**
 * The evidence a CROSS-PROVIDER merge requires — ALL four must hold; any short
 * of that leaves the candidates SEPARATE (C4). Title similarity alone never
 * merges. The decision is explainable: the evidence is carried, not discarded.
 */
export interface EventDedupEvidence {
  readonly normalizedTitleMatch: boolean;
  readonly venueIdentityMatch: boolean;
  readonly timeWindowOverlap: boolean;
  readonly coarseAreaMatch: boolean;
}

/** An explainable dedup decision (C4). */
export interface EventDedupDecision {
  /** The surviving canonical event id. */
  readonly canonicalId: string;
  /** Ids folded into the canonical (exact provider identity, or a full cross-provider match). */
  readonly mergedIds: readonly string[];
  readonly basis: EventDedupBasis;
  /** Present for a cross-provider merge; documents why the merge was allowed. */
  readonly evidence: EventDedupEvidence | null;
}

/* ------------------------------------------------------------------ *
 * Search, paging & capabilities
 * ------------------------------------------------------------------ */

/** Result lifecycle for an events query (ports #61 `RESULT_STATE` + `LOADING`). */
export type EventSearchState =
  | 'ok'
  | 'partial'
  | 'empty'
  | 'unavailable'
  | 'failed'
  | 'loading'
  | 'superseded';

/** A UTC time window filter; either bound may be absent. */
export interface EventTimeWindow {
  readonly fromUTC?: number;
  readonly toUTC?: number;
}

/**
 * An events query. Filters are category / free text / distance band / time
 * window ONLY — no age, no gender (A3). The search origin is device-local and
 * is NOT part of the public query shape (it never travels on a result).
 */
export interface EventSearchQuery {
  readonly text?: string;
  readonly category?: EventCategory;
  readonly distanceBand?: DistanceBand;
  readonly timeWindow?: EventTimeWindow;
  readonly cursor: EventCursor | null;
}

declare const EventCursorBrand: unique symbol;

/** Opaque, signed keyset cursor (anti-enumeration); minted server-side only. */
export type EventCursor = string & { readonly [EventCursorBrand]: true };

/** A page of events. No total count is exposed (anti-enumeration). */
export interface EventPage<T> {
  readonly results: readonly T[];
  readonly cursor: EventCursor | null;
  readonly state: EventSearchState;
}

/**
 * The affordances an event surface offers. Events are PUBLIC listings, so there
 * is no consent-gated person contact here — only save/unsave and a map handoff.
 */
export interface EventCapabilities {
  readonly canSave: boolean;
  readonly canOpenInMaps: boolean;
}
