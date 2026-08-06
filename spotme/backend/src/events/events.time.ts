/**
 * Live Nearby Events — time, timezone, lifecycle and freshness (Phase 4B, C5).
 *
 * Ports #61 `time.js` and HARDENS it for the corrections:
 *   - All temporal reasoning is on UTC instants (epoch ms) — timezone-safe and
 *     deterministic; `timezone` is DISPLAY metadata only, never used in maths.
 *   - The SOURCE wins: a cancelled/postponed listing is that, whatever the clock
 *     says. We never override a provider's lifecycle with time maths (C3).
 *   - end < start is REJECTED at the boundary (see assertValidWindow) — a valid
 *     record never carries an inverted window.
 *   - all-day events are handled explicitly (a day-long effective window).
 *   - Nothing here reads the wall clock; `now` is always injected, so DST and
 *     boundary behaviour are pinned by tests without faking globals.
 */

import type { NormalizedEvent, EventState, StatedEvent } from './events.types';
import { invalidTimeWindow } from './events.errors';

/** When a source gives no end, assume this much for happening-now (timed event). */
export const DEFAULT_EVENT_DURATION_MS = 3 * 60 * 60 * 1000;
/** An all-day event's effective duration from its start-of-day instant. */
export const ALL_DAY_DURATION_MS = 24 * 60 * 60 * 1000;
/** Ended events older than this are pruned from the surface (config seam). */
export const DEFAULT_RETENTION_MS = 6 * 60 * 60 * 1000;
/** A fetched record older than this is considered stale (config seam). */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

function isNum(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Reject an inverted window (end < start). Called at the normalize boundary so a
 * stored/served event never has end before start (C5). Equal is allowed
 * (zero-length instant). A null bound is fine (tbd).
 */
export function assertValidWindow(startUTC: number | null, endUTC: number | null): void {
  if (isNum(startUTC) && isNum(endUTC) && endUTC < startUTC) throw invalidTimeWindow();
}

/** The effective end instant: explicit end, else start + a default duration
 *  (all-day → a day; timed → the default event duration). */
export function effectiveEndUTC(event: Pick<NormalizedEvent, 'startUTC' | 'endUTC' | 'allDay'>): number | null {
  if (isNum(event.endUTC)) return event.endUTC;
  if (isNum(event.startUTC)) return event.startUTC + (event.allDay ? ALL_DAY_DURATION_MS : DEFAULT_EVENT_DURATION_MS);
  return null;
}

/**
 * Derive the lifecycle state at instant `now`. Source cancelled/postponed ALWAYS
 * win over the clock (C3). Ported from #61 `deriveEventState`.
 */
export function deriveEventState(event: Pick<NormalizedEvent, 'lifecycle' | 'startUTC' | 'endUTC' | 'allDay'>, now: number): EventState {
  if (!event) return 'ended';
  if (event.lifecycle === 'cancelled') return 'cancelled';
  if (event.lifecycle === 'postponed') return 'postponed';
  if (!isNum(now)) return 'upcoming';
  if (!isNum(event.startUTC)) return 'upcoming'; // scheduled but tbd
  if (now < event.startUTC) return 'upcoming';
  const end = effectiveEndUTC(event);
  if (end != null && now <= end) return 'happening-now';
  return 'ended';
}

/** Attach the derived `state` (new object; input not mutated). */
export function withState(event: NormalizedEvent, now: number): StatedEvent {
  return { ...event, state: deriveEventState(event, now) };
}

/** True when a record was fetched recently enough to trust (unknown ⇒ keep). */
export function isFresh(event: Pick<NormalizedEvent, 'fetchedAtUTC'>, now: number, ttlMs = DEFAULT_TTL_MS): boolean {
  if (!isNum(event.fetchedAtUTC) || !isNum(now)) return true;
  return now - event.fetchedAtUTC <= ttlMs;
}

/** True when an ended event has aged past retention. Cancelled/postponed never
 *  "expire" this way — their provenance keeps them explainable until swept. */
export function isExpired(event: Pick<NormalizedEvent, 'lifecycle' | 'startUTC' | 'endUTC' | 'allDay'>, now: number, retentionMs = DEFAULT_RETENTION_MS): boolean {
  if (!isNum(now)) return false;
  if (event.lifecycle === 'cancelled' || event.lifecycle === 'postponed') return false;
  const end = effectiveEndUTC(event);
  if (end == null) return false;
  return now > end + retentionMs;
}

/** The retention expiry instant for a stored event, or null if it never expires
 *  by time (tbd/cancelled/postponed). Used to set Event.expiresAt. */
export function retentionExpiryUTC(event: Pick<NormalizedEvent, 'lifecycle' | 'startUTC' | 'endUTC' | 'allDay'>, retentionMs = DEFAULT_RETENTION_MS): number | null {
  if (event.lifecycle === 'cancelled' || event.lifecycle === 'postponed') return null;
  const end = effectiveEndUTC(event);
  return end == null ? null : end + retentionMs;
}

/** Remove events that should no longer be shown: expired, and (optionally) stale. */
export function pruneStaleEvents<T extends NormalizedEvent>(events: T[], now: number, opts: { retentionMs?: number; ttlMs?: number; dropStale?: boolean } = {}): T[] {
  const retentionMs = isNum(opts.retentionMs) ? opts.retentionMs : DEFAULT_RETENTION_MS;
  const ttlMs = isNum(opts.ttlMs) ? opts.ttlMs : DEFAULT_TTL_MS;
  const dropStale = opts.dropStale === true;
  if (!Array.isArray(events)) return [];
  return events.filter((e) => {
    if (isExpired(e, now, retentionMs)) return false;
    if (dropStale && !isFresh(e, now, ttlMs)) return false;
    return true;
  });
}

/**
 * Best-effort local-time parts for DISPLAY, using the event's IANA timezone.
 * Deterministic given (instant, timezone). Falls back to a UTC ISO string when
 * the zone is unknown or Intl is unavailable — never guesses an offset (C5).
 */
export function displayTime(epochMs: number | null, timezone: string | null): { iso: string; timezone: string } {
  if (!isNum(epochMs)) return { iso: '', timezone: 'UTC' };
  const date = new Date(epochMs);
  if (timezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      return { iso: fmt.format(date), timezone };
    } catch { /* unknown zone → fall through to UTC */ }
  }
  return { iso: date.toISOString(), timezone: 'UTC' };
}
