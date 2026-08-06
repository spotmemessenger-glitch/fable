/**
 * Phase 4C — Events application-state tests: browse with the coarsening
 * boundary, honest state mapping (permission/offline/unavailable/empty), detail,
 * and save toggling.
 */

import { describe, expect, it } from 'vitest';
import { EventsController } from '../src/events/controller';
import { FixtureEventsApi } from '../src/events/fixtures';
import type { GeolocationPort } from '../src/discovery/ports';

const FIX = { lat: 12.9716, lon: 77.5946 };
const okGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: FIX }) };

const make = (over: Partial<ConstructorParameters<typeof EventsController>[0]> = {}) => {
  const api = new FixtureEventsApi();
  const controller = new EventsController({ api, geo: okGeo, selfId: 'me-1', ...over });
  return { api, controller };
};

describe('events controller', () => {
  it('browse coarsens the origin before anything outbound', async () => {
    const { api, controller } = make();
    await controller.browse();
    expect(controller.getState().kind).toBe('browsing');
    const browse = api.outbound.map((o) => JSON.parse(o)).find((o) => o.op === 'browseNearby');
    expect(browse.payload.origin.lat).not.toBe(FIX.lat);
    expect(browse.payload.origin.lon).not.toBe(FIX.lon);
  });

  it('permission-required and location-unavailable map from the geo port', async () => {
    const denied = make({ geo: { getFix: async () => ({ state: 'permission-required' }) } });
    await denied.controller.browse();
    expect(denied.controller.getState().kind).toBe('permission-required');

    const dead = make({ geo: { getFix: async () => ({ state: 'unavailable', reason: 'no signal' }) } });
    await dead.controller.browse();
    const s = dead.controller.getState();
    expect(s.kind === 'location-unavailable' && s.reason).toBe('no signal');
  });

  it('unavailable and empty are honest typed states', async () => {
    const un = make(); un.api.unavailable = true;
    await un.controller.browse();
    expect(un.controller.getState().kind).toBe('unavailable');
  });

  it('offline is a typed state, not a crash', async () => {
    const { api, controller } = make();
    api.offline = true;
    await controller.browse();
    expect(controller.getState().kind).toBe('offline');
  });

  it('openDetail loads a single event', async () => {
    const { controller } = make();
    await controller.openDetail('fixture:e1');
    const s = controller.getState();
    expect(s.kind === 'detail' && s.event.id).toBe('fixture:e1');
  });

  it('toggleSave flips saved and records the outbound op', async () => {
    const { api, controller } = make();
    await controller.browse();
    await controller.toggleSave('fixture:e1');
    const s = controller.getState();
    const saved = s.kind === 'browsing' && s.page.results.find((e) => e.id === 'fixture:e1')?.saved;
    expect(saved).toBe(true);
    expect(api.outbound.map((o) => JSON.parse(o)).some((o) => o.op === 'save')).toBe(true);
  });
});
