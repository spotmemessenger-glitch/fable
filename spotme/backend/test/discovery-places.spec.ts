/**
 * Checkpoint 7 — place provider ports: normalization boundary, deterministic
 * fixture adapter, unavailable fallback, directions honesty.
 */

import {
  looksSecretShaped,
  normalizeProviderPlace,
  straightLineM,
} from '../src/discovery/places/place.normalize';
import {
  DeterministicInMemoryPlaceAdapter,
  StraightLineDirectionsAdapter,
  UnavailablePlaceAdapter,
} from '../src/discovery/places/place.adapters';

const SRC = { provider: 'test', attribution: 'Test Data' };
const ORIGIN = { lat: 12.97, lon: 77.59 };

describe('provider normalization — the T-BADPROVIDER boundary', () => {
  it('keeps only allow-listed fields; the raw payload is dropped', () => {
    const p = normalizeProviderPlace(
      { id: 'x1', name: 'Cafe', lat: 1, lon: 2, category: 'cafe', rawProviderBlob: { secret: 'stuff' }, trackingId: 'trk_123' },
      SRC,
    )!;
    expect(p).not.toBeNull();
    expect(JSON.stringify(p)).not.toContain('rawProviderBlob');
    expect(JSON.stringify(p)).not.toContain('trk_123');
  });

  it('attribution is mandatory — a result without a source does not exist', () => {
    expect(normalizeProviderPlace({ id: 'x', name: 'N', lat: 1, lon: 2 }, { provider: '', attribution: '' })).toBeNull();
  });

  it('secret-shaped values poison the whole record', () => {
    expect(looksSecretShaped('rediss://u:p@host:6385')).toBe(true);
    expect(looksSecretShaped('key_abcdefghijklmnop1234')).toBe(true);
    expect(looksSecretShaped('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(true);
    expect(
      normalizeProviderPlace({ id: 'x', name: 'N', lat: 1, lon: 2, note: 'token_abcdefghijklmnop9999' }, SRC),
    ).toBeNull();
  });

  it('unknown stays unknown: openNow is null unless the source supplies a boolean (A8/P4)', () => {
    expect(normalizeProviderPlace({ id: 'x', name: 'N', lat: 1, lon: 2 }, SRC)!.openNow).toBeNull();
    expect(normalizeProviderPlace({ id: 'x', name: 'N', lat: 1, lon: 2, openNow: 'yes' }, SRC)!.openNow).toBeNull();
    expect(normalizeProviderPlace({ id: 'x', name: 'N', lat: 1, lon: 2, openNow: false }, SRC)!.openNow).toBe(false);
  });

  it('unusable records disappear entirely (no partial trust)', () => {
    expect(normalizeProviderPlace({ name: 'no id', lat: 1, lon: 2 }, SRC)).toBeNull();
    expect(normalizeProviderPlace({ id: 'x', name: 'N', lat: 999, lon: 2 }, SRC)).toBeNull();
    expect(normalizeProviderPlace('junk', SRC)).toBeNull();
  });
});

describe('deterministic in-memory adapter', () => {
  const adapter = new DeterministicInMemoryPlaceAdapter();
  const base = { origin: ORIGIN, radiusKm: 10, limit: 10 };

  it('is deterministic: identical queries return identical ordered results', async () => {
    const a = await adapter.searchPlaces({ ...base, category: 'cafe' });
    const b = await adapter.searchPlaces({ ...base, category: 'cafe' });
    expect(a).toEqual(b);
    expect(a.state).toBe('ok');
  });

  it('A8: an open-now filter EXCLUDES unknown-hours places rather than assuming open', async () => {
    const all = await adapter.searchPlaces({ ...base, category: 'cafe' });
    const open = await adapter.searchPlaces({ ...base, category: 'cafe', openNow: true });
    expect(all.state === 'ok' && all.places.some((p) => p.openNow === null)).toBe(true);
    expect(open.state === 'ok' && open.places.every((p) => p.openNow === true)).toBe(true);
  });

  it('every result carries source attribution', async () => {
    const res = await adapter.searchPlaces({ ...base, text: 'hospital' });
    expect(res.state).toBe('ok');
    if (res.state === 'ok') {
      for (const p of res.places) expect(p.source.attribution.length).toBeGreaterThan(0);
    }
  });

  it('details: unknown fields stay null — nothing invented', async () => {
    const res = await adapter.getDetails('fx-cafe-1');
    expect(res.state).toBe('ok');
    if (res.state === 'ok') expect(res.details).toEqual({ hoursText: null, phone: null, website: null });
    expect((await adapter.getDetails('nope')).state).toBe('not-found');
  });
});

describe('unavailable adapter — the deterministic fallback', () => {
  it('answers every call with the typed unavailable state', async () => {
    const u = new UnavailablePlaceAdapter();
    expect((await u.searchPlaces()).state).toBe('provider-unavailable');
    expect((await u.getDetails()).state).toBe('provider-unavailable');
  });
});

describe('directions — honesty rules', () => {
  it('produces ONLY a labeled straight line + external handoff; never travel time', () => {
    const d = new StraightLineDirectionsAdapter();
    const h = d.handoff(ORIGIN, { lat: 12.98, lon: 77.6, name: 'Riverside Beans' });
    expect(h.kind).toBe('external-handoff');
    expect(h.straightLineLabel).toContain('(straight line)');
    expect(h.straightLineM).toBe(straightLineM(ORIGIN, { lat: 12.98, lon: 77.6 }));
    const json = JSON.stringify(h);
    for (const invented of ['travelTime', 'duration', 'eta', 'route', 'toll', 'traffic', 'driving']) {
      expect(json.toLowerCase()).not.toContain(invented.toLowerCase());
    }
  });
});
