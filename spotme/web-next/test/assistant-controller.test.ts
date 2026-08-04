/**
 * Phase 6D — assistant controller: state machine over the fixture API; every
 * honest answer state reachable; citations in a results answer resolve within
 * their own envelope; review/route loading is best-effort and honest.
 */

import { describe, expect, it } from 'vitest';
import { AssistantController } from '../src/assistant/controller';
import { FixtureAssistantApi } from '../src/assistant/fixtures';
import { DisabledVoiceInput } from '../src/assistant/ports';
import type { GeolocationPort } from '../src/discovery/ports';

const geo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: { lat: 12.9716, lon: 77.5946 } }) };
const noGeo: GeolocationPort = { getFix: async () => ({ state: 'permission-required' }) };

function make(g: GeolocationPort = geo) {
  const api = new FixtureAssistantApi();
  const controller = new AssistantController({ api, geo: g, voice: new DisabledVoiceInput(), selfId: 'fixture-self' });
  return { api, controller };
}

describe('assistant controller', () => {
  it('answers a places query with cited results whose citations resolve in-envelope', async () => {
    const { controller } = make();
    controller.queryText = 'quiet cafe near the plaza';
    await controller.ask();
    const s = controller.getState();
    expect(s.kind).toBe('answered');
    if (s.kind !== 'answered') return;
    const answer = s.response.answer;
    expect(answer.kind).toBe('results');
    if (answer.kind !== 'results') return;
    const ids = new Set(answer.summary.sources.map((r) => r.id as string));
    for (const claim of answer.summary.claims) {
      expect(claim.citationIds.length).toBeGreaterThanOrEqual(1);
      for (const cid of claim.citationIds) expect(ids.has(cid as string)).toBe(true);
    }
  });

  it('reaches every honest state: insufficient-evidence, domain-not-active, unavailable', async () => {
    const { controller } = make();
    for (const [text, kind] of [
      ['there is nothing here', 'insufficient-evidence'],
      ['events tonight', 'domain-not-active'],
      ['offline please', 'unavailable'],
    ] as const) {
      controller.queryText = text;
      await controller.ask();
      const s = controller.getState();
      expect(s.kind).toBe('answered');
      if (s.kind === 'answered') expect(s.response.answer.kind).toBe(kind);
    }
  });

  it('surfaces the sensitive notice as data alongside a normal typed answer', async () => {
    const { controller } = make();
    controller.queryText = 'clinic nearby';
    await controller.ask();
    const s = controller.getState();
    if (s.kind !== 'answered') throw new Error('expected answer');
    expect(s.response.sensitiveCategory).toBe('health');
    expect(s.response.sensitiveNotice).toMatch(/qualified healthcare professional/);
    expect(s.response.sensitiveNotice).not.toMatch(/[0-9]/); // no invented numbers
  });

  it('asks fine without location permission — origin is simply null', async () => {
    const { api, controller } = make(noGeo);
    controller.queryText = 'coffee';
    await controller.ask();
    expect(controller.getState().kind).toBe('answered');
    const q = api.outbound[0] as { payload: { origin: unknown } };
    expect(q.payload.origin).toBeNull();
  });

  it('empty queries do not fire', async () => {
    const { api, controller } = make();
    controller.queryText = '   ';
    await controller.ask();
    expect(controller.getState().kind).toBe('idle');
    expect(api.outbound.length).toBe(0);
  });

  it('loads review intelligence with a mixed facet keeping both sides', async () => {
    const { controller } = make();
    await controller.loadReview('place:cafe-azul');
    const noise = controller.review!.facets.find((f) => f.field === 'noise-level')!;
    expect(noise.state).toBe('mixed');
    expect(noise.claims.length).toBe(2);
  });

  it('loads a provider route and a labeled straight-line; unknown destinations are unavailable', async () => {
    const { controller } = make();
    await controller.loadRoute('place:cafe-azul');
    expect(controller.route!.kind).toBe('provider-route');
    await controller.loadRoute('place:faraway');
    expect(controller.route!.kind).toBe('straight-line');
    if (controller.route!.kind === 'straight-line') {
      expect(controller.route!.estimate.label).toBe('straight-line estimate');
    }
    await controller.loadRoute('place:nowhere');
    expect(controller.route!.kind).toBe('unavailable');
  });

  it('failure path surfaces a FIXED message — never an error that could echo the query', async () => {
    const api = new FixtureAssistantApi();
    api.query = async () => { throw new Error('boom with secret text'); };
    const controller = new AssistantController({ api, geo, voice: new DisabledVoiceInput(), selfId: 's' });
    controller.queryText = 'anything';
    await controller.ask();
    const s = controller.getState();
    expect(s.kind).toBe('failed');
    if (s.kind === 'failed') {
      expect(s.message).toBe('The assistant could not answer. Try again.');
      expect(s.message).not.toContain('secret');
    }
  });
});
