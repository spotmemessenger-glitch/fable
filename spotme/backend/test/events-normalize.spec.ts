/**
 * Phase 4B — Events normalize boundary (C2/C3/C5). The allow-list builder that
 * coarsens the venue, mints bounded popularity, enforces source attribution,
 * and refuses inverted windows — dropping every raw provider field.
 */

import { normalizeEvent } from '../src/events/events.normalize';
import { EventsError } from '../src/events/events.errors';

const cand = (over: Record<string, unknown> = {}) => ({
  providerEventId: 'e1', title: 'Rooftop set', lat: 12.9716123, lon: 77.5946098,
  startUTC: 1000, endUTC: 2000, timezone: 'Asia/Kolkata', category: 'music',
  ...over,
});

describe('events normalize boundary', () => {
  it('coarsens the venue to the public grid and derives the cell (no precise point survives)', () => {
    const e = normalizeEvent(cand(), 'fixture')!;
    expect(e.coarseLat).toBe(12.972);
    expect(e.coarseLon).toBe(77.595);
    expect(e.coarseCell).toBe('g12.972:77.595');
    // The precise input digits do not appear anywhere on the record.
    expect(JSON.stringify(e)).not.toContain('12.9716123');
    expect(JSON.stringify(e)).not.toContain('77.5946098');
  });

  it('mints popularity ONLY from a bounded source number; absent stays null (C2)', () => {
    expect(normalizeEvent(cand({ popularity: 0.7 }), 'f')!.popularity).toBe(0.7);
    expect(normalizeEvent(cand({ popularity: 5 }), 'f')!.popularity).toBe(1); // clamped
    expect(normalizeEvent(cand({ popularity: -2 }), 'f')!.popularity).toBe(0);
    expect(normalizeEvent(cand({}), 'f')!.popularity).toBeNull(); // unknown ⇒ null, not 0
    expect(normalizeEvent(cand({ popularity: 'lots' }), 'f')!.popularity).toBeNull(); // non-number ignored
  });

  it('carries mandatory source attribution + provenance for a cancel (C3)', () => {
    const e = normalizeEvent(cand({ lifecycle: 'cancelled', source: 'Acme', url: 'https://x.test/e', organizerRef: 'org:1', providerSourceId: 'feed-2', confidence: 0.8, provenance: { assertedBy: 'Acme', assertedAtUTC: 999, note: 'venue closed' } }), 'fixture')!;
    expect(e.source.provider).toBe('fixture');
    expect(e.source.sourceName).toBe('Acme');
    expect(e.source.organizerRef).toBe('org:1');
    expect(e.source.providerSourceId).toBe('feed-2');
    expect(e.source.confidence).toBe(0.8);
    expect(e.source.provenance).toEqual({ lifecycle: 'cancelled', assertedBy: 'Acme', assertedAtUTC: 999, note: 'venue closed' });
  });

  it('DROPS raw provider payload — only whitelisted fields survive (T-EV-4)', () => {
    const e = normalizeEvent(cand({ trackingId: 'abc', billing: { plan: 'x' }, apiKey: 'sk-secret', rawBlob: { a: 1 } }), 'f')!;
    const json = JSON.stringify(e);
    expect(json).not.toContain('trackingId');
    expect(json).not.toContain('billing');
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('rawBlob');
  });

  it('REFUSES an inverted window (end < start) (C5)', () => {
    expect(() => normalizeEvent(cand({ startUTC: 5000, endUTC: 1000 }), 'f')).toThrow(EventsError);
  });

  it('recurrence occurrenceId is copied ONLY when the provider supplied one (C5)', () => {
    expect(normalizeEvent(cand({ occurrenceId: 'occ-7' }), 'f')!.occurrenceId).toBe('occ-7');
    expect(normalizeEvent(cand({}), 'f')!.occurrenceId).toBeNull();
  });

  it('returns null (never a fabricated event) when the minimum is missing', () => {
    expect(normalizeEvent(cand({ providerEventId: '' }), 'f')).toBeNull();
    expect(normalizeEvent(cand({ title: '' }), 'f')).toBeNull();
    expect(normalizeEvent(cand({ lat: undefined, lon: undefined }), 'f')).toBeNull();
    expect(normalizeEvent(cand({ lat: 999 }), 'f')).toBeNull(); // out of range
  });

  it('an unknown category collapses to other; ISO start strings are accepted', () => {
    expect(normalizeEvent(cand({ category: 'crypto-pump' }), 'f')!.category).toBe('other');
    const e = normalizeEvent(cand({ startUTC: '2026-08-05T18:00:00Z', endUTC: undefined }), 'f')!;
    expect(e.startUTC).toBe(Date.parse('2026-08-05T18:00:00Z'));
  });
});
