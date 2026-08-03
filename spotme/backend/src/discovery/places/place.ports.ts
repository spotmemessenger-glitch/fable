/**
 * Place provider ports (checkpoint 7) — interfaces only, provider-neutral (P9).
 *
 * NO production provider, NO API key, NO network activation exists in this
 * phase: the only adapters are the deterministic in-memory fixture (tests/dev)
 * and the unavailable adapter (the deterministic fallback). Every provider
 * result passes the normalizer (place.normalize.ts) before it can exist as a
 * NormalizedPlace — raw provider payloads are dropped at the boundary
 * (threat model T-BADPROVIDER / C-NORMALIZE).
 *
 * HONESTY RULES (P4), enforced by the types:
 *  - unknown stays null/absent — openNow, hours, rating only when the SOURCE
 *    supports them (A8);
 *  - DirectionsPort NEVER invents travel time, route geometry, road
 *    conditions, or tolls: it returns a straight-line distance EXPLICITLY
 *    labeled as such plus a handoff descriptor for an external navigator —
 *    a straight line is never presented as a driving distance.
 */

export interface CoarseOrigin {
  lat: number;
  lon: number;
}

/** A provider place AFTER normalization — the only shape that leaves the port. */
export interface NormalizedPlace {
  placeId: string;
  name: string;
  category: string | null;
  /** Provider-supplied coarse position for the marker (places are public). */
  lat: number;
  lon: number;
  /** Present ONLY when the source supports opening hours (A8). */
  openNow: boolean | null;
  /** REQUIRED attribution — a result without a source does not exist (P4/P9). */
  source: { provider: string; attribution: string };
  localityLabel: string | null;
}

export type PlaceSearchResult =
  | { state: 'ok'; places: NormalizedPlace[] }
  | { state: 'no-results' }
  | { state: 'provider-unavailable'; provider: string };

export interface PlaceSearchPort {
  readonly name: string;
  /** Text/category search around a COARSE origin (never a precise fix). */
  searchPlaces(query: { text?: string; category?: string; openNow?: boolean; origin: CoarseOrigin; radiusKm: number; limit: number }): Promise<PlaceSearchResult>;
}

export type PlaceDetailsResult =
  | { state: 'ok'; place: NormalizedPlace; details: { hoursText: string | null; phone: string | null; website: string | null } }
  | { state: 'not-found' }
  | { state: 'provider-unavailable'; provider: string };

export interface PlaceDetailsPort {
  readonly name: string;
  getDetails(placeId: string): Promise<PlaceDetailsResult>;
}

/** A handoff to an external navigator — never a route we computed. */
export interface DirectionsHandoff {
  kind: 'external-handoff';
  /** Straight-line metres, labeled as such; NEVER travel time or road distance. */
  straightLineM: number;
  straightLineLabel: string; // e.g. "~1.2 km away (straight line)"
  /** Destination the external app should navigate to (place coords are public). */
  destination: { lat: number; lon: number; name: string };
}

export interface DirectionsPort {
  readonly name: string;
  handoff(origin: CoarseOrigin, dest: { lat: number; lon: number; name: string }): DirectionsHandoff;
}

export const PLACE_SEARCH_PORT = Symbol('PLACE_SEARCH_PORT');
export const PLACE_DETAILS_PORT = Symbol('PLACE_DETAILS_PORT');
export const DIRECTIONS_PORT = Symbol('DIRECTIONS_PORT');
