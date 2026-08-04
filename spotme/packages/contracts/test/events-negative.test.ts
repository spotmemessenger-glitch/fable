/**
 * COMPILE-TIME NEGATIVE TESTS for the Phase 4 Live Nearby Events contracts.
 *
 * Each `@ts-expect-error` asserts the marked assignment DOES NOT compile. If a
 * refactor makes a raw coordinate, an age/gender filter, a raw popularity
 * number, an engagement/sponsored ranking signal, a plain-string cursor, an
 * arbitrary lifecycle, or a source-less event assignable, the expected error
 * vanishes and `tsc` fails with "unused @ts-expect-error" — the fence trips.
 */

import type {
  CoarsePublicLocation,
  EventPublic,
  EventPopularity,
  EventRankingSignal,
  EventSearchQuery,
  EventCursor,
  EventState,
  EventSourceLifecycle,
  EventSource,
  EventTime,
} from '../src/index.ts';

const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;
const rawFix = { lat: 12.9716, lon: 77.5946 };
const time: EventTime = { startUTC: 1, endUTC: 2, timezone: 'Asia/Kolkata', allDay: false };
const source: EventSource = {
  provider: 'fixture',
  providerEventId: 'e1',
  providerSourceId: null,
  organizerRef: null,
  sourceName: null,
  url: null,
  revisionUTC: null,
  confidence: null,
  provenance: null,
};

/* A raw {lat,lon} is NOT assignable where the branded venue type is required. */
export const evGood: EventPublic = {
  id: 'fixture:e1', category: 'music', title: 'Gig', description: null,
  time, state: 'upcoming', venue: coarse, distanceBand: 'under1km',
  popularity: null, source, fetchedAtUTC: null,
};
export const evBadVenue: EventPublic = {
  id: 'fixture:e1', category: 'music', title: 'Gig', description: null,
  time, state: 'upcoming',
  // @ts-expect-error a raw device/venue fix cannot be an event venue (privacy brand)
  venue: rawFix,
  distanceBand: 'under1km', popularity: null, source, fetchedAtUTC: null,
};

/* A3: no age/gender filter exists on the query shape. */
export const qAgeBad: EventSearchQuery = {
  category: 'music',
  // @ts-expect-error age is not a supported events filter (A3)
  age: 30,
  cursor: null,
};
export const qGenderBad: EventSearchQuery = {
  category: 'music',
  // @ts-expect-error gender is not a supported events filter (A3)
  gender: 'x',
  cursor: null,
};

/* Popularity is branded: a raw number cannot be dropped in as a crowd (C2). */
export const evBadPop: EventPublic = {
  id: 'fixture:e1', category: 'music', title: 'Gig', description: null,
  time, state: 'upcoming', venue: coarse, distanceBand: 'under1km',
  // @ts-expect-error a raw number is not a sourced, bounded EventPopularity
  popularity: 0.5,
  source, fetchedAtUTC: null,
};

/* The closed ranking signal set: engagement/sponsored are not signals (C2). */
// @ts-expect-error engagement is not a registered events ranking signal
export const sigBad: EventRankingSignal = 'engagement';
// @ts-expect-error sponsored is not a registered events ranking signal
export const sigBad2: EventRankingSignal = 'sponsored';

/* An opaque cursor cannot be built from a plain string (anti-enumeration). */
// @ts-expect-error EventCursor is branded — a plain string is not assignable
export const curBad: EventCursor = 'page-2';

/* State/lifecycle are closed unions. */
// @ts-expect-error 'trending' is not an EventState
export const stateBad: EventState = 'trending';
// @ts-expect-error 'sold-out' is not a source-assertable lifecycle
export const lifeBad: EventSourceLifecycle = 'sold-out';

/* Source attribution is mandatory — a source-less event does not compile (C3). */
// @ts-expect-error EventPublic requires a mandatory source attribution
export const evNoSource: EventPublic = {
  id: 'fixture:e1', category: 'music', title: 'Gig', description: null,
  time, state: 'upcoming', venue: coarse, distanceBand: 'under1km',
  popularity: null, fetchedAtUTC: null,
};
