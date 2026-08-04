/**
 * Live Nearby Events — privacy, blocking and safety boundaries (Phase 4B).
 *
 * Events are public listings, so the privacy risk is the OPPOSITE direction from
 * people-presence: the danger is leaking the USER back out (their device-local
 * search origin) or surfacing content from a blocked/unsafe source. Ported from
 * #61 `safety.js`:
 *   1. BLOCKING — an event attributed to a blocked provider/source/organiser is
 *      removed (injected `isBlocked`).
 *   2. SAFETY — a source-flagged unsafe/age-restricted event is removed unless
 *      explicitly allowed (default: remove).
 *   3. ORIGIN PRIVACY — the user's search origin must NEVER appear on an event.
 *      `assertNoOriginLeak` is the mutation-style guard: a future change that
 *      attaches the origin trips the fence.
 */

import type { NormalizedEvent } from './events.types';

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

export interface EventSafetyOptions {
  isBlocked?: (id: string) => boolean;
  allowRestricted?: boolean;
}

/** Apply blocking + safety filtering. Pure filter over normalized events. */
export function filterForSafety<T extends NormalizedEvent>(events: T[], opts: EventSafetyOptions = {}): T[] {
  const isBlocked = typeof opts.isBlocked === 'function' ? opts.isBlocked : () => false;
  const allowRestricted = opts.allowRestricted === true;
  if (!Array.isArray(events)) return [];
  return events.filter((e) => {
    if (!e) return false;
    const ids = [e.source.provider, e.source.sourceName, e.source.organizerRef].filter((x): x is string => Boolean(x));
    if (ids.some((id) => isBlocked(id))) return false;
    if (!allowRestricted && (e.restricted === true || e.unsafe === true)) return false;
    return true;
  });
}

/**
 * Mutation-style guard: the user's precise search origin must not appear on any
 * event record. Throws on a leak. A leak looks like the origin coordinates
 * co-occurring on a record, or an origin-shaped field name.
 */
export function assertNoOriginLeak(events: ReadonlyArray<Record<string, unknown>>, origin: { lat: number; lon: number } | null): boolean {
  if (!origin || !isNum(origin.lat) || !isNum(origin.lon)) return true;
  for (const e of events || []) {
    if (!e) continue;
    for (const k of Object.keys(e)) {
      if (/origin ?lat|origin ?lon|user ?lat|user ?lon|myposition|devicelat|devicelon/i.test(k)) {
        throw new Error(`event ${(e as { id?: string }).id ?? '?'} exposes an origin-shaped field: ${k}`);
      }
    }
    const asRec = e as { originLat?: unknown; originLon?: unknown };
    if (String(asRec.originLat) === String(origin.lat) && String(asRec.originLon) === String(origin.lon)) {
      throw new Error(`event ${(e as { id?: string }).id ?? '?'} leaks the user's search origin`);
    }
  }
  return true;
}
