/**
 * Stage 1 C4 — CameraPort into the Moments composer: fixture-default and
 * DARK (no camera dep = gallery-only, unchanged behavior), the gallery-
 * import path intact, and the PRIVACY MUTATION battery: a capture flowing
 * through compose → publish must put NO location token from the capture
 * path on any outbound surface — the only coordinates ever outbound are
 * the Moments coarse-attach values the poster explicitly confirmed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MomentsController } from '../src/moments/controller';
import { FixtureMomentsApi, FixtureCameraRoll } from '../src/moments/fixtures';
import { EngineCameraAdapter, UnavailableCameraPort } from '../src/camera/camera-port';
import { createCameraEngine } from '../src/camera/engine';
import { FixtureCameraDevice } from '../src/camera/fixtures';
import { coarsenForPublic } from '../src/discovery/coarsen';
import type { GeolocationPort } from '../src/discovery/ports';

const PRECISE = { lat: 12.971612345678, lon: 77.594609876543 };
const PRECISE_MARKERS = ['12.971612345678', '77.594609876543', '971612345', '594609876'];
const preciseGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: PRECISE }) };

function controllerWith(camera?: ConstructorParameters<typeof MomentsController>[0]['camera']) {
  const api = new FixtureMomentsApi();
  const controller = new MomentsController({
    api, geo: preciseGeo, cameraRoll: new FixtureCameraRoll(), selfId: 'fixture-self', camera,
  });
  return { api, controller };
}

describe('CameraPort wiring — dark by default', () => {
  it('WITHOUT a camera dep the composer is gallery-only and capture is an honest error', async () => {
    const { controller } = controllerWith();
    await controller.captureFromCamera('photo');
    expect(controller.actionError).toBe('Camera capture is not available.');
    expect(controller.draft.media.length).toBe(0);
    await controller.pickFromLibrary(); // the gallery-import path is intact
    expect(controller.draft.media.length).toBe(1);
  });

  it('the UnavailableCameraPort default behaves identically (camera-not-wired)', async () => {
    const { controller } = controllerWith(new UnavailableCameraPort());
    await controller.captureFromCamera('photo');
    expect(controller.actionError).toBe('Camera capture is not available.');
    expect(controller.draft.media.length).toBe(0);
  });

  it('with the ENGINE adapter (explicit test wiring) a capture joins the draft like a library pick', async () => {
    const adapter = new EngineCameraAdapter(createCameraEngine(new FixtureCameraDevice()));
    const { controller } = controllerWith(adapter);
    await controller.captureFromCamera('photo');
    expect(controller.actionError).toBeNull();
    expect(controller.draft.media.length).toBe(1);
    expect(controller.draft.kind).toBe('photo');
    expect(controller.draft.media[0].mediaId).toMatch(/^cam:/);
  });
});

describe('C4 privacy-mutation battery: no location token from capture reaches outbound', () => {
  const logs: string[] = [];
  beforeEach(() => {
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
    }
  });
  afterEach(() => { vi.restoreAllMocks(); logs.length = 0; });

  it('capture → compose → publish (no location attach): ZERO coordinate tokens outbound', async () => {
    const adapter = new EngineCameraAdapter(createCameraEngine(new FixtureCameraDevice()));
    const { api, controller } = controllerWith(adapter);
    await controller.captureFromCamera('photo');
    controller.draft.text = 'captured moment';
    controller.draft.visibility = 'friends';
    await controller.publish();

    const outbound = JSON.stringify(api.outbound ?? api);
    for (const marker of PRECISE_MARKERS) expect(outbound).not.toContain(marker);
    // No lat/lon-shaped token at all on a location-free publish.
    expect(outbound).not.toMatch(/"lat"|"lon"|"latitude"|"longitude"|"gps"|"exif"/i);
    for (const marker of PRECISE_MARKERS) expect(logs.join('\n')).not.toContain(marker);
  });

  it('capture + explicit coarse attach: outbound carries ONLY the confirmed coarse values, never the precise fix', async () => {
    const adapter = new EngineCameraAdapter(createCameraEngine(new FixtureCameraDevice()));
    const { api, controller } = controllerWith(adapter);
    await controller.captureFromCamera('photo');
    controller.draft.text = 'captured nearby';
    controller.setVisibility('nearby');
    controller.requestLocationAttach();
    await controller.confirmLocationAttach(); // the M5 two-step, explicit
    await controller.publish();

    const outbound = JSON.stringify(api.outbound ?? api);
    const expected = coarsenForPublic(PRECISE, 'fixture-self');
    expect(outbound).toContain(String(expected.lat)); // the flow ran (anti-vacuity)
    for (const marker of PRECISE_MARKERS) expect(outbound).not.toContain(marker);
    // Every coordinate token outbound is one of the two coarse values.
    const tokens = outbound.match(/-?\d{1,3}\.\d{3,}/g) ?? [];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect([String(expected.lat), String(expected.lon)]).toContain(t.replace('-', ''));
    }
  });

  it('the captured media object itself carries no location-shaped key end-to-end', async () => {
    const adapter = new EngineCameraAdapter(createCameraEngine(new FixtureCameraDevice()));
    const { controller } = controllerWith(adapter);
    await controller.captureFromCamera('photo');
    expect(JSON.stringify(controller.draft.media)).not.toMatch(/lat|lon|gps|location|exif/i);
  });
});
