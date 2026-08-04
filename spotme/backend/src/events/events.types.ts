/**
 * Live Nearby Events server types (Platform Phase 4B) — the server mirror of the
 * `@spotme/contracts` Events v1 set. DARK: this module is not imported by
 * AppModule. Locations are the coarse PUBLIC venue point only; there is no
 * user-origin field anywhere in these types.
 */

export const EVENTS_CONTRACTS_VERSION = 1 as const;

export type EventCategory =
  | 'music' | 'nightlife' | 'arts' | 'theatre' | 'film' | 'food'
  | 'sports' | 'community' | 'family' | 'education' | 'festival' | 'other';

export const EVENT_CATEGORIES: readonly EventCategory[] = [
  'music', 'nightlife', 'arts', 'theatre', 'film', 'food',
  'sports', 'community', 'family', 'education', 'festival', 'other',
];

export type EventSourceLifecycle = 'scheduled' | 'cancelled' | 'postponed';
export type EventState = 'upcoming' | 'happening-now' | 'ended' | 'cancelled' | 'postponed';
export type EventSearchState =
  | 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed' | 'loading' | 'superseded';

/** Provenance for a source-asserted cancel/postpone. */
export interface EventStateProvenance {
  lifecycle: EventSourceLifecycle;
  assertedBy: string;
  assertedAtUTC: number | null;
  note?: string;
}

/** Full source attribution carried on every event (C3). No credentials. */
export interface EventSourceInfo {
  provider: string;
  providerEventId: string;
  providerSourceId: string | null;
  organizerRef: string | null;
  sourceName: string | null;
  url: string | null;
  revisionUTC: number | null;
  confidence: number | null;
  provenance: EventStateProvenance | null;
}

/** A raw provider candidate — the untrusted, provider-shaped input to normalize. */
export interface EventProviderCandidate {
  providerEventId?: unknown;
  id?: unknown;
  title?: unknown;
  name?: unknown;
  description?: unknown;
  category?: unknown;
  startUTC?: unknown;
  start?: unknown;
  endUTC?: unknown;
  end?: unknown;
  timezone?: unknown;
  allDay?: unknown;
  occurrenceId?: unknown;
  lifecycle?: unknown;
  provenance?: unknown;
  /** Coarse public venue point (already coarse from the provider/venue). */
  lat?: unknown;
  lon?: unknown;
  cell?: unknown;
  popularity?: unknown;
  providerSourceId?: unknown;
  organizerRef?: unknown;
  source?: unknown;
  sourceName?: unknown;
  url?: unknown;
  revisionUTC?: unknown;
  confidence?: unknown;
  restricted?: unknown;
  unsafe?: unknown;
  [k: string]: unknown;
}

/**
 * A normalized event — the ONLY event shape the rest of the subsystem speaks.
 * Instants are UTC epoch-ms; the venue is the coarse public point; popularity is
 * bounded 0..1 or null; source attribution is mandatory. Never carries a raw
 * payload or the user's origin.
 */
export interface NormalizedEvent {
  id: string;
  category: EventCategory;
  title: string;
  description: string | null;
  startUTC: number | null;
  endUTC: number | null;
  timezone: string | null;
  allDay: boolean;
  occurrenceId: string | null;
  lifecycle: EventSourceLifecycle;
  coarseLat: number;
  coarseLon: number;
  coarseCell: string;
  popularity: number | null;
  source: EventSourceInfo;
  fetchedAtUTC: number | null;
  /** Source-flagged restriction/unsafe (removed by safety unless allowed). */
  restricted: boolean;
  unsafe: boolean;
}

/** A normalized event with its derived state at some instant. */
export interface StatedEvent extends NormalizedEvent {
  state: EventState;
}

/** A stored event row as read back from persistence. */
export interface EventRow extends NormalizedEvent {
  canonicalId: string | null;
  expiresAtUTC: number | null;
  state: EventState;
  distanceBand: string | null;
}
