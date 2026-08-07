/**
 * Phase 3D — Exchange PRIVACY MUTATION battery. A precise fix with distinctive
 * decimals drives the publish flow; every outbound surface is scanned for the
 * raw values. The coarse origin must be present (flow ran) while the precise
 * values appear NOWHERE. Also: no coordinate token of any kind leaks — only the
 * exact coarse values may appear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeController } from '../exchange/controller';
import { FixtureExchangeApi } from '../exchange/fixtures';
import { FixedClock } from '../discovery/ports';
import type { GeolocationPort } from '../discovery/ports';
import { coarsenForPublic } from '../discovery/coarsen';

const PRECISE = { lat: 12.971612345678, lon: 77.594609876543 };
const PRECISE_MARKERS = ['12.971612345678', '77.594609876543', '971612345', '594609876'];
const preciseGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: PRECISE }) };

const COORD_TOKEN = /-?\d{1,3}\.\d{3,}/g;

describe('exchange: precise coordinates never leave the client boundary', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); logs.length = 0; });

  it('publish + lifecycle + browse + contact flows leak nothing precise', async () => {
    const api = new FixtureExchangeApi();
    const controller = new ExchangeController({ api, geo: preciseGeo, clock: new FixedClock(Date.parse('2026-08-04T00:00:00Z')), selfId: 'me-1' });
    Object.assign(controller.draft, { kind: 'need', category: 'services/plumbing', title: 'Tap', text: 'leaks', informationalPrice: '~₹500' });

    await controller.publish();
    await controller.browse();
    await controller.openMatches('fx-intent-1');
    await controller.requestContact('fx-match-1');
    await controller.transition('fx-intent-1', 1, 'withdrawn');

    const surfaces: Record<string, string> = {
      requestBodies: api.outbound.join('\n'),
      logs: logs.join('\n'),
      finalState: JSON.stringify(controller.getState()),
      draft: JSON.stringify(controller.draft),
    };
    for (const [surface, content] of Object.entries(surfaces)) {
      for (const marker of PRECISE_MARKERS) {
        expect(content, `${surface} leaked precise marker ${marker}`).not.toContain(marker);
      }
    }

    // Positive control: the flow ran and carried the COARSE origin.
    const coarse = coarsenForPublic(PRECISE, 'me-1');
    expect(surfaces.requestBodies).toContain(String(coarse.lat));

    // Structural: the ONLY coordinate tokens in outbound bodies are the coarse values.
    const allowed = new Set([String(coarse.lat), String(coarse.lon)]);
    for (const tok of surfaces.requestBodies.match(COORD_TOKEN) ?? []) {
      expect(allowed.has(tok), `outbound carried a non-coarse coordinate token ${tok}`).toBe(true);
    }
  });

  it('the coarsening boundary is the discovery boundary (single brand-cast site) and moves the point', () => {
    const a = coarsenForPublic(PRECISE, 'me-1');
    expect(a.lat).not.toBe(PRECISE.lat);
    expect(coarsenForPublic(PRECISE, 'me-1')).toEqual(a); // deterministic
  });
});
