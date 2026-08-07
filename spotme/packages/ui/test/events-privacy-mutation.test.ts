/**
 * Phase 4C — Events PRIVACY MUTATION battery. A precise fix with distinctive
 * decimals drives browse + detail + save; every OUTBOUND surface is scanned for
 * the raw values. The coarse origin must be present (flow ran) while the precise
 * values appear NOWHERE, and the only coordinate tokens in outbound bodies are
 * the exact coarse origin values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventsController } from '../events/controller';
import { FixtureEventsApi } from '../events/fixtures';
import type { GeolocationPort } from '../discovery/ports';
import { coarsenForPublic } from '../discovery/coarsen';

const PRECISE = { lat: 12.971612345678, lon: 77.594609876543 };
const PRECISE_MARKERS = ['12.971612345678', '77.594609876543', '971612345', '594609876'];
const preciseGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: PRECISE }) };
const COORD_TOKEN = /-?\d{1,3}\.\d{3,}/g;

describe('events: precise coordinates never leave the client boundary', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); logs.length = 0; });

  it('browse + detail + save flows leak nothing precise; only the coarse origin is outbound', async () => {
    const api = new FixtureEventsApi();
    const controller = new EventsController({ api, geo: preciseGeo, selfId: 'me-1' });

    await controller.browse({ category: 'music' });
    await controller.openDetail('fixture:e1');
    await controller.toggleSave('fixture:e1');

    const requestBodies = api.outbound.join('\n');
    const surfaces: Record<string, string> = {
      requestBodies,
      logs: logs.join('\n'),
    };
    for (const [surface, content] of Object.entries(surfaces)) {
      for (const marker of PRECISE_MARKERS) {
        expect(content, `${surface} leaked precise marker ${marker}`).not.toContain(marker);
      }
    }

    // Positive control: the flow ran and carried the COARSE origin outbound.
    const coarse = coarsenForPublic(PRECISE, 'me-1');
    expect(requestBodies).toContain(String(coarse.lat));

    // Structural: the ONLY coordinate tokens in outbound bodies are the coarse
    // origin values (the venue coords live on the RESPONSE, not the request).
    const allowed = new Set([String(coarse.lat), String(coarse.lon)]);
    for (const tok of requestBodies.match(COORD_TOKEN) ?? []) {
      expect(allowed.has(tok), `outbound carried a non-coarse coordinate token ${tok}`).toBe(true);
    }
  });

  it('the coarsening boundary moves the point and is deterministic', () => {
    const a = coarsenForPublic(PRECISE, 'me-1');
    expect(a.lat).not.toBe(PRECISE.lat);
    expect(coarsenForPublic(PRECISE, 'me-1')).toEqual(a);
  });
});
