/**
 * COMPILE-TIME POSITIVE CONTROL for the Phase 4 Live Nearby Events contracts.
 *
 * Proves the shapes are usable as intended: a well-formed event constructs, the
 * state/lifecycle unions narrow exhaustively, a ranked result's total equals the
 * sum of its weighted components with popularity omittable (C2), a cross-provider
 * dedup decision carries its evidence (C4), and a page exposes no total count.
 * This is the counterpart to `events-negative.test.ts` — if these break, the
 * contracts became unusable, not just stricter.
 */

import {
  EVENTS_CONTRACTS_VERSION,
} from '../src/index.ts';
import type {
  CoarsePublicLocation,
  EventPublic,
  EventPopularity,
  EventState,
  EventSource,
  EventTime,
  RankedEventPublic,
  EventRankingBreakdown,
  EventDedupDecision,
  EventPage,
} from '../src/index.ts';

export const version: 1 = EVENTS_CONTRACTS_VERSION;

const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;
/** The boundary that mints a bounded, sourced popularity (backend-owned; here a test stand-in). */
const boundedPopularity = (n: number): EventPopularity =>
  Math.max(0, Math.min(1, n)) as EventPopularity;

const time: EventTime = {
  startUTC: Date.parse('2026-08-05T18:00:00Z'),
  endUTC: Date.parse('2026-08-05T21:00:00Z'),
  timezone: 'Asia/Kolkata',
  allDay: false,
};

const scheduledSource: EventSource = {
  provider: 'fixture', providerEventId: 'e1', providerSourceId: 'feed-7',
  organizerRef: 'org:acme', sourceName: 'Acme Listings', url: 'https://example.test/e1',
  revisionUTC: Date.parse('2026-08-04T00:00:00Z'), confidence: 0.9, provenance: null,
};

export const ev: EventPublic = {
  id: 'fixture:e1', category: 'music', title: 'Rooftop set', description: 'Live music',
  time, state: 'upcoming', venue: coarse, distanceBand: 'under2km',
  popularity: boundedPopularity(0.6), source: scheduledSource, fetchedAtUTC: Date.now(),
};

/* A source-asserted cancellation carries provenance and overrides the clock. */
export const cancelled: EventPublic = {
  ...ev,
  state: 'cancelled',
  source: {
    ...scheduledSource,
    provenance: { lifecycle: 'cancelled', assertedBy: 'Acme Listings', assertedAtUTC: Date.now(), note: 'Venue closed' },
  },
};

/* Exhaustive narrowing over the closed state union. */
export function label(state: EventState): string {
  switch (state) {
    case 'upcoming': return 'Upcoming';
    case 'happening-now': return 'Now';
    case 'ended': return 'Ended';
    case 'cancelled': return 'Cancelled';
    case 'postponed': return 'Postponed';
    default: { const never: never = state; return never; }
  }
}

/* A ranked event: total equals the sum of weighted components; popularity omitted
 * (unknown) contributes nothing and is disclosed in omittedSignals (C2). */
const breakdown: EventRankingBreakdown = {
  components: [
    { signal: 'time', weight: 0.4, value: 1, weighted: 0.4 },
    { signal: 'distance', weight: 0.3, value: 0.8, weighted: 0.24 },
    { signal: 'relevance', weight: 0.2, value: 0.5, weighted: 0.1 },
  ],
  omittedSignals: ['popularity'],
  total: 0.74,
};
export const ranked: RankedEventPublic = { ...ev, popularity: null, ranking: breakdown };
export const totalMatches: boolean =
  ranked.ranking.total === ranked.ranking.components.reduce((s, c) => s + c.weighted, 0);

/* A conservative cross-provider merge carries its full evidence (C4). */
export const dedup: EventDedupDecision = {
  canonicalId: 'fixture:e1',
  mergedIds: ['other:x9'],
  basis: 'cross-provider-match',
  evidence: {
    normalizedTitleMatch: true,
    venueIdentityMatch: true,
    timeWindowOverlap: true,
    coarseAreaMatch: true,
  },
};

/* A page exposes results + an opaque cursor + a state — never a total count. */
export const page: EventPage<RankedEventPublic> = {
  results: [ranked],
  cursor: null,
  state: 'ok',
};
export const hasNoTotal: boolean = !('total' in page) && !('count' in page);
