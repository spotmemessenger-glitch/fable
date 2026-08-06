/**
 * COMPILE-TIME NEGATIVE TESTS — the privacy boundary as a type error.
 *
 * Each `@ts-expect-error` line asserts that the marked assignment DOES NOT
 * compile. If a refactor ever makes raw latitude/longitude assignable to a
 * public discovery payload, the expected error disappears and `tsc` fails
 * with "unused @ts-expect-error" — the fence trips in CI, not in review.
 */

import type {
  CoarsePublicLocation,
  DiscoveryQuery,
  NearbyPersonPublic,
  NearbyPlacePublic,
  DiscoveryFilters,
  SearchCursor,
} from '../src/index.ts';

/* A raw device fix — the PRECISE shape that must never cross the boundary. */
const rawFix = { lat: 12.9716, lon: 77.5946 };

/* 1. A raw {lat, lon} is NOT a CoarsePublicLocation. */
// @ts-expect-error — precise fix cannot be assigned to the branded coarse type
const bad1: CoarsePublicLocation = rawFix;

/* 2. …not even written inline. */
// @ts-expect-error — object literal lacks the coarsening brand
const bad2: CoarsePublicLocation = { lat: 1.23, lon: 4.56 };

/* 3. A query origin cannot smuggle a raw fix. */
declare const cursor: SearchCursor;
const bad3: DiscoveryQuery = {
  contractsVersion: 1,
  intent: { kind: 'people' },
  scope: 'people',
  // @ts-expect-error — origin requires the branded coarse type
  origin: rawFix,
  radius: { km: 2 },
  cursor,
};

/* 4. A person's approxLocation cannot be a raw fix. */
declare const person: Omit<NearbyPersonPublic, 'approxLocation'>;
// @ts-expect-error — approxLocation requires the branded coarse type
const bad4: NearbyPersonPublic = { ...person, approxLocation: rawFix };

/* 5. A person result has NO numeric distance field at all. */
declare const p2: NearbyPersonPublic;
// @ts-expect-error — exact person distance does not exist (bands only)
const bad5: number = p2.deviceDistanceM;

/* 6. A place's location cannot be a raw fix either. */
declare const place: Omit<NearbyPlacePublic, 'approxLocation'>;
// @ts-expect-error — approxLocation requires the branded coarse type
const bad6: NearbyPlacePublic = { ...place, approxLocation: rawFix };

/* 7. A3: the filter sheet has no age or gender dimension. */
// @ts-expect-error — no gender filter exists in this phase (D6/D7 retained)
const bad7: DiscoveryFilters = { gender: 'x' };
// @ts-expect-error — no age filter exists in this phase (D6/D7 retained)
const bad8: DiscoveryFilters = { minAge: 18 };

/* 8. Cursors are opaque: a plain string is not a SearchCursor. */
// @ts-expect-error — cursor is branded-opaque
const bad9: SearchCursor = 'page-2';

/* 9. A8: no availability/open-now signal of any kind attaches to people. */
// @ts-expect-error — people carry no openNow field
const bad10: boolean = p2.openNow;
declare const anyPerson: NearbyPersonPublic;
// @ts-expect-error — people carry no availability field
const bad11: unknown = anyPerson.availability;

/* Positive control — the file itself must be seen by tsc (non-vacuous). */
declare const coarse: CoarsePublicLocation;
const good: DiscoveryQuery = {
  contractsVersion: 1,
  intent: { kind: 'category', category: 'cafe', openNow: true },
  scope: 'places',
  origin: coarse,
  radius: { km: 2 },
  filters: { distanceBand: 'under2km', category: 'cafe', openNow: true },
  cursor: null,
};

void bad1; void bad2; void bad3; void bad4; void bad5; void bad6; void bad7; void bad8; void bad9; void good;
