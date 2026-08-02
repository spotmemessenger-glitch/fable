import { AccountPreference } from './preference.types';

/**
 * Timezone-correct Do-Not-Disturb evaluation (design §9.2 "recipient-local now").
 *
 * The window is evaluated against the RECIPIENT's local clock, never the
 * server's. We use the built-in `Intl` timezone database — no dependency — to
 * read the recipient-local hour/minute. A missing or invalid tz disables DND
 * (the documented safe default), so a mis-set profile never silences a user by
 * surprise.
 */

/**
 * Formatter cache. Constructing an `Intl.DateTimeFormat` per call dominated the
 * evaluation cost (measured ~62 µs/op); caching one per tz makes DND evaluation
 * an order of magnitude cheaper. `null` caches a known-bad tz so it is not
 * re-probed. Bounded by the number of distinct IANA zones (~350).
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>();

function formatterFor(tz: string): Intl.DateTimeFormat | null {
  if (FORMATTERS.has(tz)) return FORMATTERS.get(tz) ?? null;
  let fmt: Intl.DateTimeFormat | null = null;
  try {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    fmt = null; // invalid tz
  }
  FORMATTERS.set(tz, fmt);
  return fmt;
}

/** Minutes since local midnight in `tz`, or null if the tz is unusable. */
export function localMinutesInTz(now: Date, tz: string): number | null {
  try {
    const fmt = formatterFor(tz);
    if (!fmt) return null;
    const parts = fmt.formatToParts(now);
    let hh: number | null = null;
    let mm: number | null = null;
    for (const p of parts) {
      if (p.type === 'hour') hh = parseInt(p.value, 10);
      else if (p.type === 'minute') mm = parseInt(p.value, 10);
    }
    if (hh === null || mm === null || Number.isNaN(hh) || Number.isNaN(mm)) {
      return null;
    }
    // Intl can emit "24" for midnight in some engines; normalise to 0.
    if (hh === 24) hh = 0;
    return hh * 60 + mm;
  } catch {
    return null; // invalid tz → DND disabled
  }
}

/**
 * Is `now` inside the account's DND window? Supports windows that cross
 * midnight (start > end, e.g. 22:00→07:00). Returns false unless DND is enabled
 * with a valid tz and a well-formed [start,end) pair.
 */
export function isDndActive(pref: AccountPreference, now: Date): boolean {
  if (!pref.dndEnabled) return false;
  if (!pref.dndTz) return false;
  const start = pref.dndStart;
  const end = pref.dndEnd;
  if (start == null || end == null) return false;
  if (!inRange(start) || !inRange(end)) return false;
  if (start === end) return false; // zero-width window = disabled

  const mins = localMinutesInTz(now, pref.dndTz);
  if (mins == null) return false;

  if (start < end) {
    // Same-day window, e.g. 01:00 → 06:00.
    return mins >= start && mins < end;
  }
  // Crosses midnight, e.g. 22:00 → 07:00 : active if after start OR before end.
  return mins >= start || mins < end;
}

function inRange(m: number): boolean {
  return Number.isInteger(m) && m >= 0 && m < 24 * 60;
}
