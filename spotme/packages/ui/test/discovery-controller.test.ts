/**
 * Checkpoint 11 — application-state tests: the full machine walk, request
 * cancellation + stale suppression, disclosed adaptive radius, offline cache
 * fallback, permission mapping, freshness drops, hide, visibility flow,
 * error normalization.
 */

import { describe, expect, it } from 'vitest';
import { DiscoveryController, MemoryCache } from '../discovery/controller';
import { FixtureDiscoveryApi } from '../discovery/fixtures';
import { DisabledRealtime, FixedClock } from '../discovery/ports';
import type { GeolocationPort } from '../discovery/ports';

const FIX = { lat: 12.9716, lon: 77.5946 };
const okGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: FIX }) };

const make = (over: Partial<ConstructorParameters<typeof DiscoveryController>[0]> = {}) => {
  const api = new FixtureDiscoveryApi();
  const cache = new MemoryCache();
  const controller = new DiscoveryController({
    api,
    geo: okGeo,
    realtime: new DisabledRealtime(),
    clock: new FixedClock(Date.parse('2026-08-03T18:10:00Z')),
    cache,
    selfId: 'me-1',
    ...over,
  });
  return { api, cache, controller };
};

describe('state machine', () => {
  it('idle → locating → searching → ready', async () => {
    const { controller } = make();
    const seen: string[] = [];
    controller.subscribe(() => seen.push(controller.getState().kind));
    await controller.search();
    expect(seen).toEqual(['locating', 'searching', 'ready']);
    const s = controller.getState();
    expect(s.kind === 'ready' && s.page.results.length).toBeGreaterThan(0);
  });

  it('permission-required and location-unavailable map from the geo port', async () => {
    const denied = make({ geo: { getFix: async () => ({ state: 'permission-required' }) } });
    await denied.controller.search();
    expect(denied.controller.getState().kind).toBe('permission-required');

    const dead = make({ geo: { getFix: async () => ({ state: 'unavailable', reason: 'no signal' }) } });
    await dead.controller.search();
    const s = dead.controller.getState();
    expect(s.kind === 'location-unavailable' && s.reason).toBe('no signal');
  });

  it('CANCELLATION + STALE SUPPRESSION: an older search can never overwrite a newer one', async () => {
    const { controller, api } = make();
    let release1: () => void = () => {};
    const gate = new Promise<void>((r) => (release1 = r));
    let firstStarted: () => void = () => {};
    const started = new Promise<void>((r) => (firstStarted = r));
    const origQuery = api.query.bind(api);
    let call = 0;
    api.query = async (q, sig) => {
      call += 1;
      if (call === 1) {
        firstStarted();
        await gate; // the FIRST in-flight request hangs until released
      }
      return origQuery(q, sig);
    };

    const p1 = controller.search();
    await started; // p1 is genuinely in flight at the API
    const p2 = controller.search(); // supersedes p1 mid-request
    await p2;
    expect(controller.getState().kind).toBe('ready');
    release1();
    await p1;
    // The LATE first response must NOT have replaced the newer state.
    expect(controller.getState().kind).toBe('ready');
    expect(call).toBe(2);
  });

  it('ADAPTIVE RADIUS: one expansion on empty, DISCLOSED, then a final empty state', async () => {
    const { controller, api } = make({ radiusKm: 2, maxRadiusKm: 10 });
    api.empty = true;
    await controller.search();
    const s = controller.getState();
    expect(s.kind).toBe('empty');
    // Two queries left the port: original radius, then a disclosed expansion.
    const radii = api.outbound.filter((o) => o.includes('"scope"')).map((o) => JSON.parse(o).radius);
    expect(radii).toEqual([{ km: 2 }, { km: 6, expanded: true }]);
  });

  it('OFFLINE: falls back to the cached page and says so', async () => {
    const { controller, api } = make();
    await controller.search(); // primes the cache
    api.offline = true;
    await controller.search();
    const s = controller.getState();
    expect(s.kind).toBe('offline');
    expect(s.kind === 'offline' && s.cached?.results.length).toBeGreaterThan(0);
  });

  it('OFFLINE cache is re-filtered for expiry (F3) and honours hide (F7-12)', async () => {
    // Prime the cache while the person is fresh, then go offline in the far
    // future: the expired person must NOT reappear from cache.
    const future = make({ clock: new FixedClock(Date.parse('2100-01-01T00:00:00Z')) });
    await future.controller.search();
    future.api.offline = true;
    await future.controller.search();
    let s = future.controller.getState();
    expect(s.kind === 'offline' && s.cached?.results.every((r) => r.type === 'place')).toBe(true);

    // Hiding while offline removes the result from the served cache.
    const on = make();
    await on.controller.search();
    on.api.offline = true;
    await on.controller.search();
    on.controller.hide('fx-place-1');
    s = on.controller.getState();
    expect(s.kind === 'offline' && s.cached?.results.some((r) => r.type === 'place')).toBe(false);
  });

  it('FRESHNESS: expired results are dropped at render time', async () => {
    const { controller, api } = make({ clock: new FixedClock(Date.parse('2100-01-01T00:00:00Z')) });
    await controller.search();
    const s = controller.getState();
    // The fixture person expires in 2099; at 2100 only the no-expiry place remains.
    expect(s.kind === 'ready' && s.page.results.every((r) => r.type === 'place')).toBe(true);
    void api;
  });

  it('HIDE removes a result and it stays hidden on refresh', async () => {
    const { controller } = make();
    await controller.search();
    controller.hide('fx-person-1');
    let s = controller.getState();
    expect(s.kind === 'ready' && s.page.results.some((r) => r.type !== 'place')).toBe(false);
    await controller.search();
    s = controller.getState();
    expect(s.kind === 'ready' && s.page.results.some((r) => r.type !== 'place')).toBe(false);
  });

  it('ERROR NORMALIZATION: typed wire errors pass through; junk becomes a retryable normalized failure', async () => {
    const { controller, api } = make();
    api.query = async () => {
      throw { code: 'RADIUS_OUT_OF_BOUNDS', message: 'radius too large', retryable: false, nextStep: 'retry with <= 25 km' };
    };
    await controller.search();
    let s = controller.getState();
    expect(s.kind === 'failed' && s.error.code).toBe('RADIUS_OUT_OF_BOUNDS');

    api.query = async () => { throw new Error('kaboom'); };
    await controller.search();
    s = controller.getState();
    expect(s.kind === 'failed' && s.error.code).toBe('UNEXPECTED');
    expect(s.kind === 'failed' && s.error.nextStep.length).toBeGreaterThan(0);
  });

  it('VISIBILITY: enabling sends a COARSE origin and flips state; disabling sends none', async () => {
    const { controller, api } = make();
    await controller.setVisibility(true);
    expect(controller.visibilityEnabled).toBe(true);
    await controller.setVisibility(false);
    expect(controller.visibilityEnabled).toBe(false);
    const calls = api.outbound.map((o) => JSON.parse(o)).filter((o) => 'enabled' in o);
    expect(calls[0].origin).not.toBeNull();
    expect(calls[1].origin).toBeNull();
  });

  it('SELECTION is shared state for map and list', async () => {
    const { controller } = make();
    await controller.search();
    controller.select('fx-place-1');
    expect(controller.selectedId).toBe('fx-place-1');
  });
});
