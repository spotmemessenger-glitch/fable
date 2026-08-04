/**
 * Stage 1 C2 — engine facade + CameraPort adapter: the CAM honesty and
 * release laws, re-proven on the port. No camera, no mount — fixtures only.
 */

import { describe, expect, it } from 'vitest';
import { createCameraEngine } from '../src/camera/engine';
import { EngineCameraAdapter, UnavailableCameraPort } from '../src/camera/camera-port';
import { FixtureCameraDevice, scene64 } from '../src/camera/fixtures';
import { negotiateMime, startRecording } from '../src/camera/video';
import type { RecorderPort } from '../src/camera/video';

describe('camera engine (fixture device)', () => {
  it('captures a still with the real path label and NO location-shaped field', async () => {
    const device = new FixtureCameraDevice();
    const engine = createCameraEngine(device);
    const result = await engine.capture({ kind: 'still' });
    expect(result.state).toBe('captured');
    if (result.state !== 'captured') return;
    expect(result.media.captureLabel).toBe('fixture');
    expect(result.media.contentHash).toMatch(/^sha256:/);
    const keys = Object.keys(result.media).join(',');
    expect(keys).not.toMatch(/lat|lon|gps|location|exif/i);
  });

  it('REFUSES HDR without a real exposure range — fake HDR never ships', async () => {
    const engine = createCameraEngine(new FixtureCameraDevice());
    expect(await engine.capture({ kind: 'hdr' })).toEqual({ state: 'unavailable', reason: 'no-exposure-control' });
  });

  it('fuses an HDR bracket when the device honestly has an EV range', async () => {
    const device = new FixtureCameraDevice({ exposure: { available: true, min: -2, max: 2 } });
    const engine = createCameraEngine(device);
    const result = await engine.capture({ kind: 'hdr' });
    expect(result.state).toBe('captured');
    if (result.state === 'captured') expect(result.media.captureLabel).toMatch(/^hdr-fusion:/);
  });

  it('night capture stacks frames and labels the path', async () => {
    const engine = createCameraEngine(new FixtureCameraDevice());
    const result = await engine.capture({ kind: 'night' });
    expect(result.state).toBe('captured');
    if (result.state === 'captured') expect(result.media.captureLabel).toMatch(/^night-stack:/);
  });

  it('burst respects the byte budget: an impossible budget refuses, a bounded one truncates', async () => {
    const engine = createCameraEngine(new FixtureCameraDevice());
    expect(await engine.capture({ kind: 'burst', maxBytes: 10 }))
      .toEqual({ state: 'unavailable', reason: 'byte-budget-exceeded' });
    const frameBytes = scene64().data.byteLength;
    const partial = await engine.capture({ kind: 'burst', maxBytes: frameBytes * 3 });
    expect(partial.state).toBe('captured-burst');
    if (partial.state === 'captured-burst') expect(partial.media.length).toBeLessThanOrEqual(3);
  });

  it('permission denial is the closed refusal, and NO session leaks open', async () => {
    const device = new FixtureCameraDevice({ denyPermission: true });
    const engine = createCameraEngine(device);
    expect(await engine.capture({ kind: 'still' })).toEqual({ state: 'unavailable', reason: 'permission-denied' });
    expect(engine.hasOpenSession()).toBe(false);
  });

  it('THE RELEASE GUARANTEE: every opened session is released, on success AND refusal paths', async () => {
    const device = new FixtureCameraDevice();
    const engine = createCameraEngine(device);
    await engine.capture({ kind: 'still' });
    await engine.capture({ kind: 'hdr' });   // refuses (no EV range) AFTER opening
    await engine.capture({ kind: 'night' });
    expect(device.opened).toBe(3);
    expect(device.released.length).toBe(3);
    expect(engine.hasOpenSession()).toBe(false);
  });

  it('video/timelapse/slow-mo through the facade refuse honestly (recorder layer owns them)', async () => {
    const engine = createCameraEngine(new FixtureCameraDevice());
    for (const kind of ['video', 'timelapse', 'slow-mo'] as const) {
      expect(await engine.capture({ kind })).toEqual({ state: 'unavailable', reason: 'unsupported' });
    }
  });
});

describe('recorder layer', () => {
  const recorder = (over: Partial<RecorderPort> = {}): RecorderPort => ({
    isTypeSupported: (m) => m === 'video/webm',
    trackFrameRate: () => 30,
    start: () => ({ state: 'recording' }),
    stop: () => ({ bytes: 1000, durationMs: 2000 }),
    ...over,
  });

  it('negotiates the preferred supported mime; none supported means honest unavailable', () => {
    expect(negotiateMime(recorder())).toBe('video/webm');
    expect(negotiateMime(recorder({ isTypeSupported: () => false }))).toBeNull();
    expect(startRecording(recorder({ isTypeSupported: () => false })))
      .toEqual({ state: 'unavailable', reason: 'unsupported' });
  });

  it('SLOW-MO refuses without an honest >=100fps track — zero interpolation, ever', () => {
    expect(startRecording(recorder(), { kind: 'slow-mo' }))
      .toEqual({ state: 'unavailable', reason: 'no-high-fps-track' });
    const fast = startRecording(recorder({ trackFrameRate: () => 120 }), { kind: 'slow-mo' });
    expect('stop' in fast).toBe(true);
  });

  it('a timelapse take is LABELED as the realtime-recorder path — no offline path is pretended', () => {
    const take = startRecording(recorder(), { kind: 'timelapse' });
    if (!('stop' in take)) throw new Error('expected take');
    const done = take.stop();
    expect(done.state).toBe('recorded');
    if (done.state === 'recorded') expect(done.timelapsePath).toBe('realtime-recorder');
  });

  it('caps report stoppedBy honestly', () => {
    const take = startRecording(recorder({ stop: () => ({ bytes: 5000, durationMs: 100 }) }), { maxBytes: 1000 });
    if (!('stop' in take)) throw new Error('expected take');
    const done = take.stop();
    if (done.state === 'recorded') {
      expect(done.stoppedBy).toBe('byte-cap');
      expect(done.bytes).toBe(1000);
    }
  });
});

describe('CameraPort adapter (the Moments-5D seam)', () => {
  it('the UNAVAILABLE default answers camera-not-wired — the dark posture', async () => {
    const port = new UnavailableCameraPort();
    expect(await port.capturePhoto()).toEqual({ state: 'unavailable', reason: 'camera-not-wired' });
    expect(await port.captureVideo()).toEqual({ state: 'unavailable', reason: 'camera-not-wired' });
  });

  it('the engine adapter maps a still onto PickedMedia with no location-shaped key', async () => {
    const adapter = new EngineCameraAdapter(createCameraEngine(new FixtureCameraDevice()));
    const result = await adapter.capturePhoto();
    expect(result.state).toBe('captured');
    if (result.state !== 'captured') return;
    expect(result.media.kind).toBe('image');
    expect(Object.keys(result.media).join(',')).not.toMatch(/lat|lon|gps|location|exif/i);
  });

  it('refusals thread through as honest unavailable, never a fake capture', async () => {
    const adapter = new EngineCameraAdapter(createCameraEngine(new FixtureCameraDevice({ denyPermission: true })));
    expect(await adapter.capturePhoto()).toEqual({ state: 'unavailable', reason: 'permission-denied' });
    // video refuses at the facade (recorder layer owns it) before any session opens
    expect(await adapter.captureVideo()).toEqual({ state: 'unavailable', reason: 'unsupported' });
  });
});
