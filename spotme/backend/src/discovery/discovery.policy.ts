/**
 * Discovery policy — validation, ceilings, and the precise-location refusal.
 *
 * Every limit is a named configuration value with a documented default —
 * nothing magic, everything conservative (threat model §14.3). This is the
 * server half of the privacy boundary: the client's branded type makes a
 * precise fix unassignable at compile time; THIS file makes a
 * precise-location-SHAPED payload a refusal at runtime (T-EXACT, T-FAKELOC).
 */

import { DiscoveryError, preciseLocationRefused } from './discovery.errors';
import {
  DISCOVERY_CONTRACTS_VERSION,
  DecodedCursor,
  DiscoveryFilters,
  DiscoveryQueryWire,
  DistanceBand,
  ValidatedDiscoveryQuery,
} from './discovery.types';

/** Config defaults — deliberately conservative; override via config, not edits. */
export const DISCOVERY_POLICY_DEFAULTS = {
  /** Hard radius ceiling (km). Queries above are refused, not clamped silently. */
  maxRadiusKm: 25,
  /** Default radius when the client sends none it may widen to. */
  defaultRadiusKm: 2,
  /** Page-size ceiling — the pagination ceiling of T-SCRAPE / C-PAGE. */
  maxPageSize: 30,
  defaultPageSize: 20,
  /** Per-principal query rate (requests / minute) — enforcement wiring is an
   *  activation-time concern; the ceiling is contract now (T-SCRAPE/C-RATE). */
  maxQueriesPerMinute: 30,
  /** Max cursor depth (pages) per query context — enumeration bound. */
  maxCursorDepth: 20,
} as const;

/** The exact key sets we accept. ANY unknown key is a refusal, not a warning —
 *  this is how the A3 exclusion is enforced server-side: an `age` or `gender`
 *  filter key is structurally unsupported. */
const QUERY_KEYS = new Set(['contractsVersion', 'intent', 'scope', 'origin', 'radius', 'filters', 'cursor']);
const ORIGIN_KEYS = new Set(['lat', 'lon', 'cell']);
const FILTER_KEYS = new Set(['distanceBand', 'category', 'openNow']);
const RADIUS_KEYS = new Set(['km', 'expanded']);

/** Fields whose PRESENCE marks a device-precise GeolocationCoordinates shape. */
const PRECISE_SHAPE_MARKERS = ['accuracy', 'altitude', 'altitudeAccuracy', 'heading', 'speed', 'timestamp', 'coords'];

const DISTANCE_BANDS: DistanceBand[] = ['under500m', 'under1km', 'under2km', 'under5km', 'over5km'];

const bad = (msg: string, nextStep: string) => new DiscoveryError('MALFORMED_QUERY', msg, false, nextStep);

function assertExactKeys(obj: Record<string, unknown>, allowed: Set<string>, what: string): void {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) {
      if (what === 'filters') {
        throw new DiscoveryError(
          'UNSUPPORTED_FILTER',
          `unsupported filter '${k}' — filters are distanceBand, category, openNow only`,
          false,
          'remove the unsupported filter; age/gender filters do not exist in this phase (A3)',
        );
      }
      throw bad(`unknown key '${k}' in ${what}`, `send only the documented ${what} fields`);
    }
  }
}

export function decodeCursor(raw: string): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new DiscoveryError('INVALID_CURSOR', 'cursor is not decodable', false, 'restart from the first page');
  }
  const c = parsed as Partial<DecodedCursor>;
  if (typeof c?.d !== 'number' || !Number.isFinite(c.d) || c.d < 0 || typeof c?.u !== 'string' || !c.u) {
    throw new DiscoveryError('INVALID_CURSOR', 'cursor is not one we issued', false, 'restart from the first page');
  }
  return { d: c.d, u: c.u };
}

export function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify({ d: Math.round(c.d), u: c.u }), 'utf8').toString('base64url');
}

/**
 * Validate a wire query into the internal shape, refusing anything malformed,
 * precise-location-shaped, over-ceiling, or carrying unsupported filters.
 */
export function validateDiscoveryQuery(
  principalId: string,
  body: unknown,
  policy = DISCOVERY_POLICY_DEFAULTS,
): ValidatedDiscoveryQuery {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw bad('query must be an object', 'send the documented DiscoveryQuery shape');
  }
  const q = body as Record<string, unknown> & Partial<DiscoveryQueryWire>;
  // Precise-shape refusal takes precedence over generic unknown-key errors so
  // the caller learns the SPECIFIC boundary they crossed (T-EXACT).
  if (PRECISE_SHAPE_MARKERS.some((m) => m in q)) throw preciseLocationRefused();
  assertExactKeys(q, QUERY_KEYS, 'query');

  if (q.contractsVersion !== DISCOVERY_CONTRACTS_VERSION) {
    throw new DiscoveryError(
      'INVALID_CONTRACTS_VERSION',
      `contractsVersion must be ${DISCOVERY_CONTRACTS_VERSION}`,
      false,
      'upgrade the client contracts package',
    );
  }

  /* ---- origin: coarse contract ONLY ---- */
  const origin = q.origin as Record<string, unknown> | undefined;
  if (!origin || typeof origin !== 'object') throw bad('origin missing', 'send a coarse origin {lat, lon}');
  for (const marker of PRECISE_SHAPE_MARKERS) {
    if (marker in origin) throw preciseLocationRefused();
  }
  if ('coords' in q || PRECISE_SHAPE_MARKERS.some((m) => m in q)) throw preciseLocationRefused();
  assertExactKeys(origin, ORIGIN_KEYS, 'origin');
  const lat = origin.lat, lon = origin.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw bad('origin lat/lon must be finite numbers', 'send the coarse origin produced on-device');
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw bad('origin out of range', 'send WGS84 coordinates');
  }
  if ('cell' in origin && typeof origin.cell !== 'string') {
    throw bad('origin.cell must be a string when present', 'omit cell or send the coarse cell id');
  }

  /* ---- radius: bounded, never silently clamped ---- */
  const radius = (q.radius ?? { km: policy.defaultRadiusKm }) as Record<string, unknown>;
  if (typeof radius !== 'object' || radius === null) throw bad('radius must be an object', 'send {km}');
  assertExactKeys(radius, RADIUS_KEYS, 'radius');
  const km = radius.km;
  if (typeof km !== 'number' || !Number.isFinite(km) || km <= 0) {
    throw bad('radius.km must be a positive number', 'send a radius in kilometres');
  }
  if (km > policy.maxRadiusKm) {
    throw new DiscoveryError(
      'RADIUS_OUT_OF_BOUNDS',
      `radius ${km} km exceeds the ${policy.maxRadiusKm} km ceiling`,
      false,
      `retry with radius <= ${policy.maxRadiusKm} km`,
    );
  }

  /* ---- intent & scope ---- */
  const intent = q.intent as ValidatedDiscoveryQuery['intent'] | undefined;
  const INTENTS = new Set(['people', 'username', 'place', 'category', 'unavailable-domain']);
  if (!intent || typeof intent !== 'object' || !INTENTS.has((intent as { kind?: string }).kind ?? '')) {
    throw bad('intent.kind must be one of the documented kinds', 'send a routed DiscoveryIntent');
  }
  const SCOPES = new Set(['people', 'places', 'usernames', 'mixed']);
  if (typeof q.scope !== 'string' || !SCOPES.has(q.scope)) {
    throw bad('scope must be people|places|usernames|mixed', 'send a documented scope');
  }

  /* ---- filters: A3 allow-list; A8 places-only openNow ---- */
  const filters = (q.filters ?? {}) as Record<string, unknown>;
  if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
    throw bad('filters must be an object', 'send the documented filters');
  }
  assertExactKeys(filters, FILTER_KEYS, 'filters');
  if ('distanceBand' in filters && !DISTANCE_BANDS.includes(filters.distanceBand as DistanceBand)) {
    throw bad('unknown distanceBand', `use one of ${DISTANCE_BANDS.join(', ')}`);
  }
  if ('category' in filters && (typeof filters.category !== 'string' || filters.category.length > 64)) {
    throw bad('category must be a short string', 'send a category label');
  }
  if ('openNow' in filters) {
    if (typeof filters.openNow !== 'boolean') throw bad('openNow must be boolean', 'send true/false');
    // A8: openNow may only accompany place-capable scopes; it never filters people.
    if (q.scope === 'people' || q.scope === 'usernames') {
      throw new DiscoveryError(
        'UNSUPPORTED_FILTER',
        'openNow applies only to place results (A8); it cannot filter people or usernames',
        false,
        'remove openNow or use a place scope',
      );
    }
  }

  /* ---- cursor ---- */
  const cursor = q.cursor == null ? null : decodeCursor(String(q.cursor));

  return {
    principalId,
    intent,
    scope: q.scope,
    origin: { lat, lon, ...(typeof origin.cell === 'string' ? { cell: origin.cell } : {}) },
    radiusKm: km,
    filters: filters as DiscoveryFilters,
    cursor,
    pageSize: policy.defaultPageSize,
  };
}
