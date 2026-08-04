/**
 * Route phase-1 (Phase 6C, X6) — the DirectionsPort discipline applied to
 * assistant routes:
 *
 *  - a route origin is EITHER the coarse public projection (validated against
 *    the discovery grid — a device-precision fix THROWS) or a user-chosen
 *    place reference; there is no third door;
 *  - provider legs are ATTRIBUTED PASSTHROUGH: distance/duration come only
 *    from provider-supplied fields (null stays null — nothing is computed
 *    the provider didn't supply), every leg cites a CURRENT route-leg
 *    evidence record (X4);
 *  - the fallback is ALWAYS the labeled 'straight-line estimate' with a
 *    distance only — the shape has no duration field, so a straight line can
 *    never masquerade as an ETA.
 *
 * Community road-reports are NAMED here as a FUTURE seam only: a Moments
 * content-type ('road-condition' evidence category exists in the contracts)
 * that would flow through the same mint boundary once Moments is activated
 * and a consent/licensing model is owner-approved. Nothing is built.
 *
 * Adapters this phase: fixture (test-only, assistant.fixtures.ts) +
 * unavailable (assistant.ports.ts). No network, no keys.
 */

import { AssistantError } from './assistant.errors';
import type {
  CoarseOriginInput, EvidenceRecord, NonEmptyArray, RouteAdvice, RouteLeg, RouteOrigin,
} from './assistant.types';

/** The public coarse grid step (discovery discipline: 3-decimal rounding). */
const GRID_DECIMALS = 3;

/** Quantize to the public grid — float-safe. */
export function snapToPublicGrid(value: number): number {
  const factor = 10 ** GRID_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Validate a route origin (X6) — REVIEW REPAIR F1. The original boundary
 * threw on any coordinate not EXACTLY on the 3-decimal grid; that was doubly
 * wrong: (a) float representation falsely rejects ~1.6% of legitimate grid
 * values, and (b) the client's canonical `coarsenForPublic` output carries
 * per-identity jitter (±0.0009°), so the platform's own branded coarse
 * values would ALWAYS be rejected. Numerically, a raw device fix is at most
 * 0.0005° from the grid — closer than the jitter envelope — so an off-grid
 * detector for "precise" simply cannot exist server-side.
 *
 * The honest enforcement (events venue-coarsening precedent): the PRIMARY
 * X6 boundary is the client's branded type + device-local coarsening; here,
 * defence in depth QUANTIZES to the public grid before anything downstream,
 * so nothing finer than cell resolution can reach a route adapter or an
 * estimate BY CONSTRUCTION — even if a raw fix were smuggled in. The
 * 'precise-route-origin' code stays in the closed registry, reserved for an
 * activation-time origin-provenance model (e.g. signed coarse origins).
 */
export function validateRouteOrigin(origin: RouteOrigin): RouteOrigin {
  if (origin.kind === 'place-ref') {
    if (typeof origin.placeRefId !== 'string' || !origin.placeRefId.length || origin.placeRefId.length > 128) {
      throw new AssistantError('malformed-evidence', 'placeRefId');
    }
    return origin;
  }
  const { lat, lon } = origin.origin;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new AssistantError('malformed-evidence', 'origin-range');
  }
  return { kind: 'coarse', origin: { lat: snapToPublicGrid(lat), lon: snapToPublicGrid(lon) } };
}

/** A provider-supplied candidate leg — ONLY these fields are read. */
export interface ProviderLegCandidate {
  readonly mode: 'walk' | 'drive' | 'transit';
  /** Provider distance/duration — absent means ABSENT (null), never computed. */
  readonly providerDistanceM?: number | null;
  readonly providerDurationS?: number | null;
  readonly attribution: string;
  readonly citationId: string;
}

const LEG_MODES: readonly string[] = ['walk', 'drive', 'transit'];

/**
 * Build a provider route: attributed passthrough with per-leg citations into
 * CURRENT route-leg evidence (X4 — a stale route is not a route).
 */
export function buildProviderRoute(
  origin: RouteOrigin,
  candidates: readonly ProviderLegCandidate[],
  records: readonly EvidenceRecord[],
): RouteAdvice {
  const checkedOrigin = validateRouteOrigin(origin);
  if (!candidates.length) return { kind: 'unavailable', reason: 'error' };

  const recordsById = new Map(records.map((r) => [r.id, r]));
  const legs: RouteLeg[] = [];
  const citedRecordIds = new Set<string>();

  for (const c of candidates) {
    if (!LEG_MODES.includes(c.mode)) throw new AssistantError('malformed-evidence', 'mode');
    if (typeof c.attribution !== 'string' || !c.attribution.length) {
      throw new AssistantError('malformed-evidence', 'attribution');
    }
    const record = recordsById.get(c.citationId);
    if (!record || record.category !== 'route-leg') {
      throw new AssistantError('citation-unresolved', 'route-leg');
    }
    if (record.freshness !== 'current') throw new AssistantError('stale-current-state', 'route-leg');

    legs.push({
      mode: c.mode,
      providerDistanceM: typeof c.providerDistanceM === 'number' && Number.isFinite(c.providerDistanceM)
        ? c.providerDistanceM : null,
      providerDurationS: typeof c.providerDurationS === 'number' && Number.isFinite(c.providerDurationS)
        ? c.providerDurationS : null,
      attribution: c.attribution,
      citationId: c.citationId,
    });
    citedRecordIds.add(record.id);
  }

  return {
    kind: 'provider-route',
    origin: checkedOrigin,
    legs: legs as unknown as NonEmptyArray<RouteLeg>,
    sources: records.filter((r) => citedRecordIds.has(r.id)) as unknown as NonEmptyArray<EvidenceRecord>,
  };
}

const EARTH_RADIUS_M = 6_371_000;

/** Haversine over two COARSE points — the only computation route phase-1
 *  performs, and it ships under the fixed straight-line label. */
export function buildStraightLineEstimate(
  origin: RouteOrigin,
  destination: CoarseOriginInput,
): RouteAdvice {
  const checkedOrigin = validateRouteOrigin(origin);
  if (checkedOrigin.kind !== 'coarse') {
    // A place-ref origin has no coordinates here — phase-1 cannot estimate.
    return { kind: 'unavailable', reason: 'provider-unconfigured' };
  }
  if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lon) ||
      Math.abs(destination.lat) > 90 || Math.abs(destination.lon) > 180) {
    throw new AssistantError('malformed-evidence', 'destination-range');
  }
  // F1: the destination is quantized like the origin — only grid-resolution
  // values enter the computation.
  const dest = { lat: snapToPublicGrid(destination.lat), lon: snapToPublicGrid(destination.lon) };

  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(dest.lat - checkedOrigin.origin.lat);
  const dLon = toRad(dest.lon - checkedOrigin.origin.lon);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(checkedOrigin.origin.lat)) * Math.cos(toRad(dest.lat)) *
    Math.sin(dLon / 2) ** 2;
  const distanceM = Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));

  return {
    kind: 'straight-line',
    origin: checkedOrigin,
    estimate: { label: 'straight-line estimate', distanceM },
  };
}
