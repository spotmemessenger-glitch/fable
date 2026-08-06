/**
 * Location & privacy contracts.
 *
 * Mirrors the on-device coarsening contract in
 * `spotme/web/src/lib/discovery.js` (`coarse()`): the precise fix stays on the
 * device; only a coarsened projection — ~110 m rounding plus a stable
 * per-identity jitter — is ever shared (ADR-018, ADR-024). These types make
 * that boundary explicit so a caller cannot accidentally pass a precise fix
 * where a coarse projection is required.
 *
 * OWNERSHIP: the coarsening ALGORITHM (rounding granularity, jitter constants)
 * is owned by `discovery.js` and deliberately NOT duplicated here — this
 * package describes the privacy-safe public SHAPE, never the implementation.
 * If the algorithm ever moves, it moves as one owner-reviewed change; these
 * types stay stable because they never encoded its numbers.
 */

/**
 * A raw device-side geographic fix. NEVER leaves the device un-coarsened.
 * Present in the type system so the coarsening boundary is expressible, not so
 * precise coordinates travel.
 */
export interface PreciseLocation {
  readonly lat: number;
  readonly lon: number;
}

/**
 * The public projection of a location: the output of `coarse(lat, lon, seed)`.
 * Structurally identical to {@link PreciseLocation} but nominally distinct in
 * intent — a `CoarseLocation` is safe to share; a `PreciseLocation` is not.
 */
export interface CoarseLocation {
  readonly lat: number;
  readonly lon: number;
  /** Marks a value as already coarsened (documentation aid; not on the wire). */
  readonly coarsened?: true;
}

/**
 * Precision an Exchange item may request for its location (PRD §8.3).
 * `exact-on-connect` reveals a precise fix only after both parties consent via
 * the handoff path — never in a listing or search result.
 */
export type LocationPrecision =
  | 'approximate'
  | 'neighbourhood'
  | 'exact-on-connect';

/** A discretized cell id used for server-side indexing (ADR-018). Opaque. */
export type GeoCell = string;

/** A radius in kilometres for nearby queries. */
export type RadiusKm = number;

/**
 * A location as it may appear in a public/API context: a coarse point and/or a
 * cell id, plus the precision the owner chose. There is deliberately no field
 * for a precise fix here — that shape does not exist on any projection type.
 */
export interface PublicLocation {
  readonly precision: LocationPrecision;
  readonly approx: CoarseLocation;
  readonly geoCell?: GeoCell;
}
