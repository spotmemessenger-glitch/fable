/**
 * Phase 4B — Events time-state engine (C5). Deterministic; `now` is injected.
 */

import {
  deriveEventState, effectiveEndUTC, assertValidWindow, isExpired, isFresh,
  pruneStaleEvents, retentionExpiryUTC, displayTime,
  DEFAULT_RETENTION_MS, DEFAULT_TTL_MS, ALL_DAY_DURATION_MS,
} from '../src/events/events.time';
import { EventsError } from '../src/events/events.errors';
import type { NormalizedEvent } from '../src/events/events.types';

const base: NormalizedEvent = {
  id: 'p:1', category: 'music', title: 'Gig', description: null,
  startUTC: 1000, endUTC: 2000, timezone: 'Asia/Kolkata', allDay: false, occurrenceId: null,
  lifecycle: 'scheduled', coarseLat: 12.972, coarseLon: 77.595, coarseCell: 'g12.972:77.595',
  popularity: null, fetchedAtUTC: null, restricted: false, unsafe: false,
  source: { provider: 'p', providerEventId: '1', providerSourceId: null, organizerRef: null, sourceName: null, url: null, revisionUTC: null, confidence: null, provenance: null },
};

describe('events time-state engine (C5)', () => {
  it('derives upcoming / happening-now / ended from the clock', () => {
    expect(deriveEventState(base, 500)).toBe('upcoming');
    expect(deriveEventState(base, 1500)).toBe('happening-now');
    expect(deriveEventState(base, 3000)).toBe('ended');
  });

  it('SOURCE cancelled/postponed WINS over the clock', () => {
    expect(deriveEventState({ ...base, lifecycle: 'cancelled' }, 1500)).toBe('cancelled');
    expect(deriveEventState({ ...base, lifecycle: 'postponed', startUTC: null }, 1500)).toBe('postponed');
    // Even a "clearly happening now" window is cancelled if the source says so.
    expect(deriveEventState({ ...base, lifecycle: 'cancelled', startUTC: 0, endUTC: 9e12 }, 1500)).toBe('cancelled');
  });

  it('REJECTS an inverted window (end < start)', () => {
    expect(() => assertValidWindow(2000, 1000)).toThrow(EventsError);
    expect(() => assertValidWindow(1000, 1000)).not.toThrow(); // equal is allowed
    expect(() => assertValidWindow(null, 1000)).not.toThrow(); // tbd start is fine
  });

  it('ALL-DAY events get a day-long effective window', () => {
    const allDay = { ...base, endUTC: null, allDay: true, startUTC: 10_000 };
    expect(effectiveEndUTC(allDay)).toBe(10_000 + ALL_DAY_DURATION_MS);
    expect(deriveEventState(allDay, 10_000 + ALL_DAY_DURATION_MS - 1)).toBe('happening-now');
    expect(deriveEventState(allDay, 10_000 + ALL_DAY_DURATION_MS + 1)).toBe('ended');
  });

  it('a tbd (null start) scheduled event is upcoming, not ended', () => {
    expect(deriveEventState({ ...base, startUTC: null }, 9e12)).toBe('upcoming');
  });

  it('retention: an ended event past the window expires; cancelled/postponed do not', () => {
    const endedLongAgo = { ...base, startUTC: 0, endUTC: 1000 };
    expect(isExpired(endedLongAgo, 1000 + DEFAULT_RETENTION_MS + 1)).toBe(true);
    expect(isExpired(endedLongAgo, 1000 + DEFAULT_RETENTION_MS - 1)).toBe(false);
    expect(isExpired({ ...endedLongAgo, lifecycle: 'cancelled' }, 9e12)).toBe(false);
    expect(retentionExpiryUTC(endedLongAgo)).toBe(1000 + DEFAULT_RETENTION_MS);
    expect(retentionExpiryUTC({ ...base, lifecycle: 'postponed' })).toBeNull();
  });

  it('freshness: unknown fetchedAt is kept; stale is dropped only when asked', () => {
    expect(isFresh({ fetchedAtUTC: null }, 1000)).toBe(true);
    expect(isFresh({ fetchedAtUTC: 0 }, DEFAULT_TTL_MS + 1)).toBe(false);
    const events = [{ ...base, fetchedAtUTC: 0, startUTC: 9e12, endUTC: 9e12 + 1 }];
    expect(pruneStaleEvents(events, DEFAULT_TTL_MS + 1, { dropStale: true })).toHaveLength(0);
    expect(pruneStaleEvents(events, DEFAULT_TTL_MS + 1, { dropStale: false })).toHaveLength(1);
  });

  it('displayTime uses the source tz and NEVER guesses an offset for an unknown zone', () => {
    const t = Date.parse('2026-08-05T12:00:00Z');
    expect(displayTime(t, 'Asia/Kolkata').timezone).toBe('Asia/Kolkata');
    // Unknown zone → falls back to UTC ISO, not an invented offset.
    const bad = displayTime(t, 'Not/AZone');
    expect(bad.timezone).toBe('UTC');
    expect(bad.iso).toBe(new Date(t).toISOString());
  });

  it('DST-safe: reasoning is on UTC instants, unaffected by a tz that observes DST', () => {
    // Two instants 1h apart reason identically regardless of the display tz.
    const dstEvent = { ...base, timezone: 'America/New_York', startUTC: Date.parse('2026-03-08T06:30:00Z'), endUTC: Date.parse('2026-03-08T07:30:00Z') };
    expect(deriveEventState(dstEvent, Date.parse('2026-03-08T07:00:00Z'))).toBe('happening-now');
    expect(deriveEventState(dstEvent, Date.parse('2026-03-08T08:00:00Z'))).toBe('ended');
  });
});
