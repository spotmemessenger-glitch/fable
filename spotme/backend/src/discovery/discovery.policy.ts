/**
 * Discovery policy — validation, ceilings, and the precise-location refusal.
 *
 * Every limit is a named configuration value with a documented default —
 * nothing magic, everything conservative (threat model §14.3). This is the
 * server half of the privacy boundary: the client's branded type makes a
 * precise fix unassignable at compile time; THIS file makes a
 * precise-location-SHAPED payload a refusal at runtime (T-EXACT, T-FAKELOC).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DiscoveryError, preciseLocationRefused } from './discovery.errors';
import {
  DISCOVERY_CONTRACTS_VERSION,
  DecodedCursor,
  DiscoveryFilters,
  DiscoveryQueryWire,
  DistanceBand,
  ValidatedDiscoveryQuery,
} from './discovery.types';
import { VisibilityUpsert } from './discovery.repository';

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
  /** Max cursor depth (pages) per query context — enumeration bound, ENFORCED
   *  in validateDiscoveryQuery via the signed cursor's depth field (F5). */
  maxCursorDepth: 20,
  /** Visibility presence TTL ceiling (minutes) — the consent window the UI
   *  promises (P3); server-computed, never client-set beyond this. */
  maxVisibilityTtlMinutes: 60,
  defaultVisibilityTtlMinutes: 30,
  /** Public-location grid: coordinates are re-quantized to this many decimals
   *  server-side so a stored value is coarse BY CONSTRUCTION regardless of the
   *  client (~110 m at the equator; ADR-018 cell model supersedes at activation). */
  coarseGridDecimals: 3,
} as const;

/**
 * Cursor signing key. A signed, opaque cursor prevents a client forging
 * `{d, u}` into a metre-precision distance oracle (F6) and lets the server
 * trust the embedded depth (F5). In dark/dev with no configured secret we mint
 * a per-process random key: cursors simply do not survive a restart, which is
 * correct for a not-yet-activated feature and is documented at activation.
 */
const CURSOR_KEY: Buffer =
  process.env.DISCOVERY_CURSOR_SECRET && process.env.DISCOVERY_CURSOR_SECRET.length >= 16
    ? Buffer.from(process.env.DISCOVERY_CURSOR_SECRET, 'utf8')
    : randomBytes(32);

const b64url = (b: Buffer) => b.toString('base64url');
const cursorSig = (payload: string) => b64url(createHmac('sha256', CURSOR_KEY).update(payload).digest()).slice(0, 22);

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

const invalidCursor = () =>
  new DiscoveryError('INVALID_CURSOR', 'cursor is not one we issued', false, 'restart from the first page');

export function decodeCursor(raw: string): DecodedCursor {
  const dot = raw.indexOf('.');
  if (dot <= 0) throw invalidCursor();
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  // Constant-time signature check BEFORE trusting any embedded field (F6).
  const expected = cursorSig(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalidCursor();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
  const c = parsed as Partial<DecodedCursor>;
  // `d` is an EXACT float (never rounded, F10.1); depth is a non-negative int.
  if (
    typeof c?.d !== 'number' || !Number.isFinite(c.d) || c.d < 0 ||
    typeof c?.u !== 'string' || !c.u ||
    typeof c?.depth !== 'number' || !Number.isInteger(c.depth) || c.depth < 0
  ) {
    throw invalidCursor();
  }
  return { d: c.d, u: c.u, depth: c.depth };
}

export function encodeCursor(c: DecodedCursor): string {
  // Serialize the EXACT distance float — rounding it re-emits or skips keyset
  // boundary rows against `d > cursor.d OR (d = cursor.d AND u > …)` (F10.1).
  const payload = Buffer.from(JSON.stringify({ d: c.d, u: c.u, depth: c.depth }), 'utf8').toString('base64url');
  return `${payload}.${cursorSig(payload)}`;
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

  /* ---- cursor (signed; depth ENFORCED as the enumeration bound, F5) ---- */
  const cursor = q.cursor == null ? null : decodeCursor(String(q.cursor));
  if (cursor && cursor.depth >= policy.maxCursorDepth) {
    throw new DiscoveryError(
      'CURSOR_TOO_DEEP',
      `pagination depth ${cursor.depth} reaches the ${policy.maxCursorDepth}-page enumeration bound`,
      false,
      'narrow the search (smaller radius, add a category) rather than paging further',
    );
  }

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

/** Exact key set for a visibility write — `age`/`gender`/precise keys refused. */
const VISIBILITY_KEYS = new Set(['enabled', 'origin', 'expiresInMinutes']);

/**
 * Validate + COARSEN a visibility write. This is the second half of the
 * privacy boundary the query path already guards: a precise-shaped payload is
 * refused (F1), coordinates are re-quantized to the coarse grid server-side so
 * a buggy or hostile client can never persist a precise fix, and the presence
 * TTL is computed server-side within a bounded ceiling so the consent window
 * the UI promises cannot be defeated (F4.1).
 */
export function validateVisibilityUpsert(
  body: unknown,
  now = new Date(),
  policy = DISCOVERY_POLICY_DEFAULTS,
): VisibilityUpsert {
  const refuse = (msg: string, nextStep: string) => new DiscoveryError('VISIBILITY_REFUSED', msg, false, nextStep);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw refuse('visibility body must be an object', 'send { enabled, origin?, expiresInMinutes? }');
  }
  const b = body as Record<string, unknown>;
  if (PRECISE_SHAPE_MARKERS.some((m) => m in b)) throw preciseLocationRefused();
  assertExactKeys(b, VISIBILITY_KEYS, 'visibility');

  const enabled = b.enabled === true;

  // Bounded, server-computed TTL — the client may REQUEST a window, never exceed it.
  let ttl: number = policy.defaultVisibilityTtlMinutes;
  if ('expiresInMinutes' in b) {
    const m = b.expiresInMinutes;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) {
      throw refuse('expiresInMinutes must be a positive number', 'omit it or send minutes within the ceiling');
    }
    ttl = Math.min(m, policy.maxVisibilityTtlMinutes);
  }
  const expiresAt = new Date(now.getTime() + ttl * 60_000);

  // Disabling needs no coordinates; the row is excluded by `enabled = false`.
  if (!enabled) {
    return { enabled: false, coarseLat: 0, coarseLon: 0, coarseCell: '', expiresAt };
  }

  const origin = b.origin as Record<string, unknown> | undefined;
  if (!origin || typeof origin !== 'object' || Array.isArray(origin)) {
    throw refuse('enabling visibility requires a coarse origin', 'send origin { lat, lon, cell? }');
  }
  if (PRECISE_SHAPE_MARKERS.some((m) => m in origin)) throw preciseLocationRefused();
  assertExactKeys(origin, ORIGIN_KEYS, 'origin');
  const lat = origin.lat, lon = origin.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw refuse('origin lat/lon must be finite numbers', 'send the coarse origin produced on-device');
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw refuse('origin out of range', 'send WGS84 coordinates');
  }
  if ('cell' in origin && typeof origin.cell !== 'string') {
    throw refuse('origin.cell must be a string when present', 'omit cell or send the coarse cell id');
  }
  // Re-quantize to the coarse grid: stored coordinates are coarse BY
  // CONSTRUCTION, whatever the client sent (defence in depth behind the
  // on-device coarsening — F1).
  const q = 10 ** policy.coarseGridDecimals;
  const coarseLat = Math.round(lat * q) / q;
  const coarseLon = Math.round(lon * q) / q;
  const coarseCell = typeof origin.cell === 'string' && origin.cell ? origin.cell : `g${coarseLat.toFixed(policy.coarseGridDecimals)}:${coarseLon.toFixed(policy.coarseGridDecimals)}`;

  return { enabled: true, coarseLat, coarseLon, coarseCell, expiresAt };
}
