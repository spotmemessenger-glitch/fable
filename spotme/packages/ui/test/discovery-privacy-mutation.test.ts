/**
 * Checkpoint 11 — PRIVACY MUTATION TESTS (the load-bearing battery).
 *
 * A precise fix with distinctive decimals drives full flows; every surface a
 * coordinate could leak through is then scanned for the raw values: request
 * bodies · URLs · logs (console spy) · cache contents · realtime events ·
 * error objects. The coarsened origin must be present (proving the flows ran)
 * while the precise values appear NOWHERE.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryController, MemoryCache } from '../discovery/controller';
import { FixtureDiscoveryApi } from '../discovery/fixtures';
import { FixedClock } from '../discovery/ports';
import type { GeolocationPort, RealtimePort } from '../discovery/ports';
import { coarsenForPublic } from '../discovery/coarsen';

/** Distinctive precise fix — these exact substrings must never escape. */
const PRECISE = { lat: 12.971612345678, lon: 77.594609876543 };
const PRECISE_MARKERS = ['12.971612345678', '77.594609876543', '971612345', '594609876'];

/**
 * Truncated-precision leak guard (F11.1). A substring scan misses a leak of
 * `lat.toFixed(6)` ("12.971612"). But a naive truncated marker is UNSAFE here:
 * the coarse output is `round(lat,3) + jitter` with jitter up to ~±100 m, so a
 * legitimate coarse value CAN coincidentally share a 6-decimal prefix with the
 * precise fix. So instead of guessing markers we assert STRUCTURALLY: every
 * coordinate-shaped number that appears in an outbound body must be exactly a
 * coarsened value (never a longer-precision one). This can't false-positive.
 */
const COORD_TOKEN = /-?\d{1,3}\.\d{3,}/g;
function assertOnlyCoarseCoords(body: string, allowed: Set<string>): void {
  for (const tok of body.match(COORD_TOKEN) ?? []) {
    // A coordinate-shaped number in an outbound body is only allowed if it is
    // exactly one of the coarsened values we produced.
    expect(allowed.has(tok), `outbound body carried a non-coarse coordinate token ${tok}`).toBe(true);
  }
}

const preciseGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: PRECISE }) };

class RecordingRealtime implements RealtimePort {
  events: unknown[] = [];
  enabled() {
    return false;
  }
  onInvalidated() {
    /* records nothing — disabled; array stays scannable */
  }
}

describe('precise coordinates never leave the client boundary', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    logs.length = 0;
  });

  it('search + pagination + visibility + offline + error flows leak nothing', async () => {
    const api = new FixtureDiscoveryApi();
    const cache = new MemoryCache();
    const realtime = new RecordingRealtime();
    const controller = new DiscoveryController({
      api,
      geo: preciseGeo,
      realtime,
      clock: new FixedClock(Date.parse('2026-08-03T18:10:00Z')),
      cache,
      selfId: 'me-1',
    });

    // Full flows, including failure paths (errors are a leak surface too).
    await controller.search();
    await controller.setVisibility(true);
    await controller.setVisibility(false);
    api.empty = true;
    await controller.search();
    api.empty = false;
    api.offline = true;
    await controller.search();
    api.offline = false;
    let caught: unknown = null;
    api.query = async () => {
      const e = new Error('provider exploded');
      caught = e;
      throw e;
    };
    await controller.search();

    /* ---- the scan ---- */
    const surfaces: Record<string, string> = {
      requestBodies: api.outbound.join('\n'),
      urls: api.urls.join('\n'),
      logs: logs.join('\n'),
      cache: JSON.stringify(cache.dump()),
      realtimeEvents: JSON.stringify(realtime.events),
      errorObjects: JSON.stringify(caught, Object.getOwnPropertyNames(caught ?? {})),
      finalState: JSON.stringify(controller.getState()),
    };

    for (const [surface, content] of Object.entries(surfaces)) {
      for (const marker of PRECISE_MARKERS) {
        expect(content, `${surface} leaked precise marker ${marker}`).not.toContain(marker);
      }
    }

    // Positive control: the flows really ran and carried the COARSE origin.
    const coarse = coarsenForPublic(PRECISE, 'me-1');
    expect(surfaces.requestBodies).toContain(String(coarse.lat));
    expect(surfaces.urls.length).toBeGreaterThan(0);

    // Structural truncated-leak guard (F11.1): the ONLY coordinate-shaped
    // numbers allowed in outbound bodies/URLs are the exact coarse values.
    const allowed = new Set([String(coarse.lat), String(coarse.lon)]);
    assertOnlyCoarseCoords(surfaces.requestBodies, allowed);
    assertOnlyCoarseCoords(surfaces.urls, allowed);
  });

  it('the coarsening boundary bounds displacement (~≤250 m) and is deterministic', () => {
    const a = coarsenForPublic(PRECISE, 'me-1');
    const b = coarsenForPublic(PRECISE, 'me-1');
    expect(a).toEqual(b); // deterministic per (fix, id)
    const dLat = Math.abs(a.lat - PRECISE.lat) * 111_320;
    const dLon = Math.abs(a.lon - PRECISE.lon) * 111_320 * Math.cos((PRECISE.lat * Math.PI) / 180);
    expect(Math.hypot(dLat, dLon)).toBeLessThan(250);
    expect(Math.hypot(dLat, dLon)).toBeGreaterThan(1); // it DID move — not a no-op
    // Different identities coarsen differently (anti-correlation jitter).
    expect(coarsenForPublic(PRECISE, 'someone-else')).not.toEqual(a);
  });

  it('a raw fix cannot even be typed into an outbound query (compile-time, restated at runtime)', async () => {
    const api = new FixtureDiscoveryApi();
    // The ONLY constructor of CoarsePublicLocation in the client is coarsenForPublic;
    // grep-level fences (C12) assert no other `as CoarsePublicLocation` cast exists.
    const coarse = coarsenForPublic(PRECISE, 'me-1');
    await api.query({
      contractsVersion: 1,
      intent: { kind: 'people' },
      scope: 'people',
      origin: coarse,
      radius: { km: 2 },
      cursor: null,
    });
    expect(api.outbound[0]).toContain('"lat":' + String(coarse.lat));
  });
});
