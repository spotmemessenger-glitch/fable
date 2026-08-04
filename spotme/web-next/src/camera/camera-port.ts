/**
 * The Moments-5D `CameraPort` implementation seam (Stage 1 C2) — the
 * adapter a future owner-authorized wiring registers into the Moments
 * composer. DARK: nothing constructs it in the app; the C4 wiring keeps
 * the FIXTURE default and the C5 fence proves no mount.
 *
 * `EngineCameraAdapter` maps CameraPort's capture calls onto the engine
 * with honest unavailability threaded through (a refusal becomes the
 * seam's `{ state: 'unavailable', reason }`, never a fake). The captured
 * bytes flow ONLY into the existing media pipeline (EXIF-strip first —
 * Phase 5B); this adapter never touches location, and the media ref it
 * emits has no field to carry one (contract law).
 */

import type { CameraPort, PickedMedia } from '../moments/ports';
import type { CameraEngine } from './engine';

export class EngineCameraAdapter implements CameraPort {
  constructor(private readonly engine: CameraEngine) {}

  async capturePhoto(): Promise<{ state: 'captured'; media: PickedMedia } | { state: 'unavailable'; reason: string }> {
    const result = await this.engine.capture({ kind: 'still' });
    if (result.state !== 'captured') {
      return { state: 'unavailable', reason: result.state === 'unavailable' ? result.reason : 'unsupported' };
    }
    return {
      state: 'captured',
      media: { mediaId: result.media.mediaId, kind: 'image', name: `capture-${result.media.contentHash.slice(0, 12)}` },
    };
  }

  async captureVideo(): Promise<{ state: 'captured'; media: PickedMedia } | { state: 'unavailable'; reason: string }> {
    const result = await this.engine.capture({ kind: 'video' });
    if (result.state !== 'captured') {
      return { state: 'unavailable', reason: result.state === 'unavailable' ? result.reason : 'unsupported' };
    }
    return {
      state: 'captured',
      media: { mediaId: result.media.mediaId, kind: 'video', name: `capture-${result.media.contentHash.slice(0, 12)}` },
    };
  }
}

/** The honest no-camera default — what the Moments composer sees until an
 *  owner-authorized wiring change registers the engine adapter. */
export class UnavailableCameraPort implements CameraPort {
  async capturePhoto(): Promise<{ state: 'unavailable'; reason: string }> {
    return { state: 'unavailable', reason: 'camera-not-wired' };
  }

  async captureVideo(): Promise<{ state: 'unavailable'; reason: string }> {
    return { state: 'unavailable', reason: 'camera-not-wired' };
  }
}
