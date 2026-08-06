/**
 * The device-local coarsening boundary (checkpoint 11) — the ONLY place in the
 * client that may mint a CoarsePublicLocation from a precise fix.
 *
 * Mirrors the LIVE public-location behavior on master (ADR-024 interim
 * `coarse()`: ~110 m rounding + stable per-identity jitter). When PR #60's
 * ADR-018 cell/window model lands, this boundary swaps implementations — its
 * callers and the branded return type do not change. The algorithm's numbers
 * are owned by the live web module; this mirror is pinned by tests to the same
 * observable bounds (≤ ~250 m displacement), not to identical outputs.
 *
 * PRIVACY BUDGET — READ HONESTLY (review finding F2): the anonymity this
 * provides is the **3-decimal rounding grid (~110 m)**, NOT the jitter. The
 * jitter is seeded by `selfId`, which is public (it is served in every person
 * result), so an informed adversary can recompute and subtract it to recover
 * the rounded grid point. Its purpose is ANTI-CORRELATION (two users sharing a
 * grid cell do not collapse to a single identical public point), never added
 * displacement privacy. A stronger model — a secret per-user salt, or the
 * ADR-018 equal-area cell with a rotating server-side offset — is an
 * ACTIVATION decision, deliberately not pre-empted here. Longitude cells also
 * shrink by cos(latitude); the equal-area cell model supersedes this at
 * activation. The controlling privacy guarantee remains: the PRECISE fix never
 * leaves the device, proven by the mutation battery.
 */

import type { CoarsePublicLocation } from '@spotme/contracts';
import type { DeviceFix } from './ports';

/** FNV-1a hash → stable [0,1) — same construction as the live coarse(). */
function unitHash(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 16) & 1023) / 1023;
}

/**
 * Coarsen a precise device fix for public use. Deterministic per (fix, id).
 * The brand cast happens HERE and nowhere else in the client.
 */
export function coarsenForPublic(fix: DeviceFix, selfId: string): CoarsePublicLocation {
  const jLat = (unitHash(selfId) - 0.5) * 0.0018;
  const jLon = (unitHash(`${selfId}:lon`) - 0.5) * 0.0018;
  const lat = Math.round(fix.lat * 1000) / 1000 + jLat;
  const lon = Math.round(fix.lon * 1000) / 1000 + jLon;
  const cell = `${lat.toFixed(2)}:${lon.toFixed(2)}`;
  return { lat, lon, cell } as CoarsePublicLocation;
}
