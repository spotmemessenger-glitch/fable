/**
 * Phase 5D — Moments application-state tests: coarse-before-outbound feeds,
 * the M5 two-step location attach (explanation → explicit confirm), tier
 * guards, publish shapes, block/hide reflection, honest states.
 */

import { describe, expect, it } from 'vitest';
import { MomentsController } from '../moments/controller';
import { FixtureMomentsApi, FixtureCameraRoll } from '../moments/fixtures';
import type { GeolocationPort } from '../discovery/ports';

const FIX = { lat: 12.9716, lon: 77.5946 };
const okGeo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: FIX }) };

const make = (geo: GeolocationPort = okGeo) => {
  const api = new FixtureMomentsApi();
  const controller = new MomentsController({ api, geo, cameraRoll: new FixtureCameraRoll(), selfId: 'me-1' });
  return { api, controller };
};

describe('moments controller', () => {
  it('nearby/city feeds coarsen the origin before anything outbound; friends sends none', async () => {
    const { api, controller } = make();
    await controller.loadFeed('nearby');
    const feedCall = api.outbound.map((o) => JSON.parse(o)).find((o) => o.op === 'feed');
    expect(feedCall.payload.origin.lat).not.toBe(FIX.lat);
    await controller.loadFeed('friends');
    const friends = api.outbound.map((o) => JSON.parse(o)).filter((o) => o.op === 'feed').pop();
    expect(friends.payload.origin).toBeNull();
  });

  it('M5: location attach is TWO-step — the explanation must precede the confirm', async () => {
    const { controller } = make();
    controller.setVisibility('nearby');
    // Confirm without the explanation step is refused.
    await controller.confirmLocationAttach();
    expect(controller.actionError).toMatch(/explanation step/i);
    expect(controller.draft.location).toBeNull();
    // The proper flow: request (shows explanation) → confirm (attaches COARSE).
    controller.requestLocationAttach();
    expect(controller.draft.explainingLocation).toBe(true);
    await controller.confirmLocationAttach();
    expect(controller.draft.location).not.toBeNull();
    expect(controller.draft.location!.lat).not.toBe(FIX.lat); // coarse, not precise
  });

  it('M5: private/friends tiers refuse attach; downgrading tiers drops an attached location', async () => {
    const { controller } = make();
    controller.setVisibility('friends');
    controller.requestLocationAttach();
    expect(controller.actionError).toMatch(/nearby or public/i);
    expect(controller.draft.explainingLocation).toBe(false);
    controller.setVisibility('public');
    controller.requestLocationAttach();
    await controller.confirmLocationAttach();
    expect(controller.draft.location).not.toBeNull();
    controller.setVisibility('private'); // downgrade → location dropped
    expect(controller.draft.location).toBeNull();
  });

  it('publish sends the draft shape and resets it; validation blocks empties', async () => {
    const { api, controller } = make();
    await controller.publish();
    expect(controller.actionError).toMatch(/write something/i);
    controller.draft.text = 'hello';
    await controller.publish();
    const composed = api.outbound.map((o) => JSON.parse(o)).find((o) => o.op === 'compose');
    expect(composed.payload).toMatchObject({ kind: 'text', text: 'hello', visibility: 'friends' });
    expect(controller.draft.text).toBe('');
  });

  it('block removes the author from the current feed; hide removes the post', async () => {
    const { controller } = make();
    await controller.loadFeed('nearby');
    await controller.block('u2');
    let s = controller.getState();
    expect(s.kind === 'feed' && s.page.results.every((m) => m.author.userId !== 'u2')).toBe(true);
    await controller.loadFeed('nearby');
    await controller.hide('fx-m1');
    s = controller.getState();
    expect(s.kind === 'feed' && s.page.results.map((m) => m.id)).not.toContain('fx-m1');
  });

  it('honest states: permission-required, unavailable, offline', async () => {
    const denied = make({ getFix: async () => ({ state: 'permission-required' }) });
    await denied.controller.loadFeed('nearby');
    expect(denied.controller.getState().kind).toBe('permission-required');

    const un = make(); un.api.unavailable = true;
    await un.controller.loadFeed('friends');
    expect(un.controller.getState().kind).toBe('unavailable');

    const off = make(); off.api.offline = true;
    await off.controller.loadFeed('friends');
    expect(off.controller.getState().kind).toBe('offline');
  });

  it('camera-roll picking is the FIXTURE port (no camera engine import)', async () => {
    const { controller } = make();
    await controller.pickFromLibrary();
    expect(controller.draft.media[0]).toMatchObject({ mediaId: 'fx-picked-1', kind: 'image' });
    expect(controller.draft.kind).toBe('photo');
  });
});
