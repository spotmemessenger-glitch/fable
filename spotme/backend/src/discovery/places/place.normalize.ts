/**
 * Provider-result normalization — the T-BADPROVIDER boundary (checkpoint 7).
 *
 * Every provider payload passes through here and ONLY the allow-listed,
 * validated fields survive: the raw payload is dropped, attribution is
 * mandatory, secret-shaped values are rejected outright (a provider echoing an
 * API key or bearer token must not lodge it in our results), and anything the
 * provider does not know stays null — never invented (P4).
 */

import { NormalizedPlace } from './place.ports';

/** Secret-shaped content: credentialed URLs, bearer/key-looking strings. */
const SECRET_SHAPES = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]*@[^\s'"]*/i, // credentialed URL
  /\b(sk|pk|key|token|bearer)[-_][a-z0-9]{16,}/i,
  /\beyJ[A-Za-z0-9_-]{20,}/, // JWT-shaped
];

export function looksSecretShaped(v: unknown): boolean {
  return typeof v === 'string' && SECRET_SHAPES.some((r) => r.test(v));
}

const str = (v: unknown, max = 256): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;

/**
 * Normalize one raw provider record. Returns null when the record is unusable
 * (missing identity/name/position or carrying secret-shaped values) — an
 * unusable record disappears; it is never partially trusted.
 */
export function normalizeProviderPlace(
  raw: unknown,
  source: { provider: string; attribution: string },
): NormalizedPlace | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  // Reject records carrying secret-shaped values anywhere in their top level.
  for (const v of Object.values(r)) {
    if (looksSecretShaped(v)) return null;
  }

  const placeId = str(r.placeId ?? r.id, 128);
  const name = str(r.name);
  const lat = typeof r.lat === 'number' && Number.isFinite(r.lat) && Math.abs(r.lat) <= 90 ? r.lat : null;
  const lon = typeof r.lon === 'number' && Number.isFinite(r.lon) && Math.abs(r.lon) <= 180 ? r.lon : null;
  if (!placeId || !name || lat === null || lon === null) return null;
  if (!source.provider || !source.attribution) return null; // attribution is mandatory

  return {
    placeId,
    name,
    category: str(r.category, 64),
    lat,
    lon,
    // A8/P4: openNow ONLY when the provider evidently supports it — a missing
    // or non-boolean value is UNKNOWN (null), never defaulted.
    openNow: typeof r.openNow === 'boolean' ? r.openNow : null,
    source,
    localityLabel: str(r.localityLabel, 128),
    // Everything else in `raw` is DROPPED here — no passthrough field exists.
  };
}

/** Haversine metres — used ONLY for the labeled straight-line handoff. */
export function straightLineM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(s)));
}

export function straightLineLabel(m: number): string {
  return m < 1000 ? `~${m} m away (straight line)` : `~${(m / 1000).toFixed(1)} km away (straight line)`;
}
