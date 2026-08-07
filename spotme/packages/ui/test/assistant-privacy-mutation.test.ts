/**
 * Phase 6D — assistant PRIVACY MUTATION battery (X9 + the coarsening bar).
 * A precise fix with distinctive decimals drives query + review + route
 * flows; every outbound payload and every console surface is scanned: the
 * precise values appear NOWHERE, the only coordinate tokens outbound are the
 * exact coarse values, and the QUERY TEXT never reaches a console/log surface
 * (it may appear ONLY in the api query payload itself).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantController } from '../assistant/controller';
import { FixtureAssistantApi } from '../assistant/fixtures';
import { DisabledVoiceInput } from '../assistant/ports';
import { coarsenForPublic } from '../discovery/coarsen';
import type { GeolocationPort } from '../discovery/ports';

const PRECISE = { lat: 12.971612345678, lon: 77.594609876543 };
const PRECISE_MARKERS = ['12.971612345678', '77.594609876543', '971612345', '594609876'];
const QUERY_MARKER = 'zq-unique-assistant-query-7x';
const preciseGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: PRECISE }) };
const COORD_TOKEN = /-?\d{1,3}\.\d{3,}/g;

describe('assistant: precise coordinates and query text never leak', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); logs.length = 0; });

  it('query + review + route flows leak nothing precise; outbound coords are exactly the coarse values', async () => {
    const api = new FixtureAssistantApi();
    const controller = new AssistantController({
      api, geo: preciseGeo, voice: new DisabledVoiceInput(), selfId: 'fixture-self',
    });

    controller.queryText = `${QUERY_MARKER} cafes near me`;
    await controller.ask();
    await controller.loadReview('place:cafe-azul');
    await controller.loadRoute('place:faraway');

    const outbound = JSON.stringify(api.outbound);
    const expected = coarsenForPublic(PRECISE, 'fixture-self');

    // 1. The flows RAN and carried an origin (guard against vacuity).
    expect(api.outbound.length).toBeGreaterThanOrEqual(3);
    expect(outbound).toContain(String(expected.lat));

    // 2. No precise marker anywhere outbound.
    for (const marker of PRECISE_MARKERS) expect(outbound).not.toContain(marker);

    // 3. Every coordinate token outbound is one of the two coarse values.
    const tokens = outbound.match(COORD_TOKEN) ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect([String(expected.lat), String(expected.lon)]).toContain(t.replace('-', ''));
    }

    // 4. The controller state (what the UI can render) has no precise value.
    const stateJson = JSON.stringify({ s: controller.getState(), r: controller.review, rt: controller.route });
    for (const marker of PRECISE_MARKERS) expect(stateJson).not.toContain(marker);

    // 5. Console surfaces: no precise value AND no query text (X9 — the text
    //    may exist ONLY inside the api query payload).
    const logged = logs.join('\n');
    for (const marker of PRECISE_MARKERS) expect(logged).not.toContain(marker);
    expect(logged).not.toContain(QUERY_MARKER);
  });

  it('the query text appears in the query payload ONLY — not in review/route payloads', async () => {
    const api = new FixtureAssistantApi();
    const controller = new AssistantController({
      api, geo: preciseGeo, voice: new DisabledVoiceInput(), selfId: 'fixture-self',
    });
    controller.queryText = `${QUERY_MARKER} anything`;
    await controller.ask();
    await controller.loadReview('place:cafe-azul');
    await controller.loadRoute('place:cafe-azul');

    const [query, ...rest] = api.outbound as { endpoint: string }[];
    expect(JSON.stringify(query)).toContain(QUERY_MARKER);
    expect(JSON.stringify(rest)).not.toContain(QUERY_MARKER);
  });

  it('a failed ask leaves no query text in the rendered failure state', async () => {
    const api = new FixtureAssistantApi();
    api.query = async () => { throw new Error('provider blew up'); };
    const controller = new AssistantController({
      api, geo: preciseGeo, voice: new DisabledVoiceInput(), selfId: 'fixture-self',
    });
    controller.queryText = `${QUERY_MARKER} secret`;
    await controller.ask();
    expect(JSON.stringify(controller.getState())).not.toContain(QUERY_MARKER);
  });
});
