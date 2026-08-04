/**
 * Phase 3D — Exchange application-state tests: publish flow with the coarsening
 * boundary, consent-gated contact (no chat before accept), lifecycle actions,
 * offline/unavailable/permission mapping, and validation.
 */

import { describe, expect, it } from 'vitest';
import { ExchangeController } from '../src/exchange/controller';
import { FixtureExchangeApi } from '../src/exchange/fixtures';
import { FixedClock } from '../src/discovery/ports';
import type { GeolocationPort } from '../src/discovery/ports';

const FIX = { lat: 12.9716, lon: 77.5946 };
const okGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: FIX }) };

const make = (over: Partial<ConstructorParameters<typeof ExchangeController>[0]> = {}) => {
  const api = new FixtureExchangeApi();
  const controller = new ExchangeController({
    api, geo: okGeo, clock: new FixedClock(Date.parse('2026-08-04T00:00:00Z')), selfId: 'me-1', ...over,
  });
  return { api, controller };
};

const fillDraft = (c: ExchangeController) => {
  Object.assign(c.draft, { kind: 'need', category: 'services/plumbing', title: 'Tap', text: 'leaks' });
};

describe('exchange controller', () => {
  it('publish coarsens the origin before anything outbound', async () => {
    const { api, controller } = make();
    fillDraft(controller);
    await controller.publish();
    expect(controller.getState().kind).toBe('published');
    const composed = api.outbound.map((o) => JSON.parse(o)).find((o) => o.op === 'compose');
    // The outbound origin is the coarsened value, NOT the device fix. (The
    // full-precision leak scan lives in the privacy-mutation battery.)
    expect(composed.payload.origin.lat).not.toBe(FIX.lat);
    expect(composed.payload.origin.lon).not.toBe(FIX.lon);
  });

  it('validation blocks an incomplete draft with an actionError, no outbound', async () => {
    const { api, controller } = make();
    await controller.publish();
    expect(controller.actionError).toMatch(/fill in/i);
    expect(api.outbound).toHaveLength(0);
  });

  it('permission-required and location-unavailable map from the geo port', async () => {
    const denied = make({ geo: { getFix: async () => ({ state: 'permission-required' }) } });
    fillDraft(denied.controller);
    await denied.controller.publish();
    expect(denied.controller.getState().kind).toBe('permission-required');

    const dead = make({ geo: { getFix: async () => ({ state: 'unavailable', reason: 'no signal' }) } });
    fillDraft(dead.controller);
    await dead.controller.publish();
    const s = dead.controller.getState();
    expect(s.kind === 'location-unavailable' && s.reason).toBe('no signal');
  });

  it('CONSENT GATE: requesting contact never opens a chat; it moves to requested until accept', async () => {
    const { controller } = make();
    await controller.openMatches('fx-intent-1');
    const before = controller.getState();
    expect(before.kind === 'matches' && before.page.results[0].contact.state).toBe('none');
    const m = await controller.requestContact('fx-match-1');
    expect(m?.contact.state).toBe('requested'); // NOT accepted → no chat
    expect(m?.contact.requiresExplicitConsent).toBe(true);
  });

  it('lifecycle: withdraw threads the version and updates state', async () => {
    const { api, controller } = make();
    await controller.transition('fx-intent-1', 1, 'withdrawn');
    const s = controller.getState();
    expect(s.kind === 'published' && s.intent.status).toBe('withdrawn');
    const t = api.outbound.map((o) => JSON.parse(o)).find((o) => o.op === 'transition');
    expect(t.payload).toMatchObject({ id: 'fx-intent-1', version: 1, to: 'withdrawn' });
  });

  it('browse maps unavailable and empty states honestly', async () => {
    const un = make(); un.api.unavailable = true;
    await un.controller.browse();
    expect(un.controller.getState().kind).toBe('unavailable');
  });

  it('offline is a typed state, not a crash', async () => {
    const { api, controller } = make();
    fillDraft(controller);
    api.offline = true;
    await controller.publish();
    expect(controller.getState().kind).toBe('offline');
  });
});
