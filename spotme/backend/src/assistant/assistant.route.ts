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

function isOnCoarseGrid(value: number): boolean {
  const factor = 10 ** GRID_DECIMALS;
  return Number.isFinite(value) && Math.round(value * factor) === value * factor;
}

/**
 * Validate a route origin (X6). A coarse origin must sit EXACTLY on the
 * public grid — any extra precision means a device fix leaked, and the
 * boundary THROWS instead of rounding (rounding here would normalize a leak
 * into silence; the coarsening boundary is device-local, not ours).
 */
export function validateRouteOrigin(origin: RouteOrigin): RouteOrigin {
  if (origin.kind === 'place-ref') {
    if (typeof origin.placeRefId !== 'string' || !origin.placeRefId.length || origin.placeRefId.length > 128) {
      throw new AssistantError('malformed-evidence', 'placeRefId');
    }
    return origin;
  }
  const { lat, lon } = origin.origin;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new AssistantError('malformed-evidence', 'origin-range');
  }
  if (!isOnCoarseGrid(lat) || !isOnCoarseGrid(lon)) {
    throw new AssistantError('precise-route-origin');
  }
  return origin;
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
  if (!isOnCoarseGrid(destination.lat) || !isOnCoarseGrid(destination.lon)) {
    throw new AssistantError('precise-route-origin');
  }

  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(destination.lat - checkedOrigin.origin.lat);
  const dLon = toRad(destination.lon - checkedOrigin.origin.lon);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(checkedOrigin.origin.lat)) * Math.cos(toRad(destination.lat)) *
    Math.sin(dLon / 2) ** 2;
  const distanceM = Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a)));

  return {
    kind: 'straight-line',
    origin: checkedOrigin,
    estimate: { label: 'straight-line estimate', distanceM },
  };
}
