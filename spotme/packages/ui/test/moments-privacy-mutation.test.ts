/**
 * Phase 5D — Moments PRIVACY MUTATION battery. A precise fix with distinctive
 * decimals drives feed + attach + publish + social flows; every OUTBOUND
 * surface is scanned for the raw values. The coarse origin must be present
 * (flow ran) while the precise values appear NOWHERE, and the only coordinate
 * tokens outbound are the exact coarse values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MomentsController } from '../moments/controller';
import { FixtureMomentsApi, FixtureCameraRoll } from '../moments/fixtures';
import type { GeolocationPort } from '../discovery/ports';
import { coarsenForPublic } from '../discovery/coarsen';

const PRECISE = { lat: 12.971612345678, lon: 77.594609876543 };
const PRECISE_MARKERS = ['12.971612345678', '77.594609876543', '971612345', '594609876'];
const preciseGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: PRECISE }) };
const COORD_TOKEN = /-?\d{1,3}\.\d{3,}/g;

describe('moments: precise coordinates never leave the client boundary', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); logs.length = 0; });

  it('feed + location-attach + publish + social flows leak nothing precise', async () => {
    const api = new FixtureMomentsApi();
    const controller = new MomentsController({ api, geo: preciseGeo, cameraRoll: new FixtureCameraRoll(), selfId: 'me-1' });

    await controller.loadFeed('nearby');
    await controller.loadFeed('city');
    controller.setVisibility('public');
    controller.draft.text = 'posting with a location';
    controller.requestLocationAttach();
    await controller.confirmLocationAttach();
    await controller.publish();
    await controller.react('fx-m1', 'like');
    await controller.comment('fx-m1', 'nice place', null);
    await controller.report('moment', 'fx-m2', 'spam');

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

    // Positive control: the flows ran and carried the COARSE projection.
    const coarse = coarsenForPublic(PRECISE, 'me-1');
    expect(surfaces.requestBodies).toContain(String(coarse.lat));

    // Structural: the ONLY coordinate tokens outbound are the coarse values.
    const allowed = new Set([String(coarse.lat), String(coarse.lon)]);
    for (const tok of surfaces.requestBodies.match(COORD_TOKEN) ?? []) {
      expect(allowed.has(tok), `outbound carried a non-coarse coordinate token ${tok}`).toBe(true);
    }
  });

  it('the coarsening boundary moves the point and is deterministic', () => {
    const a = coarsenForPublic(PRECISE, 'me-1');
    expect(a.lat).not.toBe(PRECISE.lat);
    expect(coarsenForPublic(PRECISE, 'me-1')).toEqual(a);
  });
});
