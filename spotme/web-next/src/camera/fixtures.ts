/**
 * Camera fixtures (Stage 1 C2) — deterministic device-port doubles for the
 * engine tests. Synthetic frames only (seeded scenes, no camera). The
 * fixture reports its capabilities HONESTLY so tests can prove both the
 * happy paths and the refusal laws (no exposure range → no HDR, etc.).
 */

import type { CameraDevicePort, ExposureCapability } from './engine';
import type { RgbaImage } from './types';

/** FNV-1a over the bytes — deterministic contentHash for tests. */
export function fnvHash(image: RgbaImage): string {
  let h = 2166136261;
  for (let i = 0; i < image.data.length; i++) {
    h ^= image.data[i];
    h = Math.imul(h, 16777619);
  }
  return `sha256:${(h >>> 0).toString(16).padStart(8, '0')}`;
}

/** The structured 64×64 scene from the source-branch golden suite. */
export function scene64(): RgbaImage {
  const width = 64; const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      let v = 40 + ((x + y) % 32) * 3;
      if (x >= 12 && x < 24 && y >= 12 && y < 20) v = 220;
      if (x >= 36 && x < 52 && y >= 30 && y < 44) v = 130;
      data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

export interface FixtureDeviceOptions {
  exposure?: ExposureCapability;
  /** Frames served in order; the last repeats. Defaults to scene64. */
  frames?: readonly RgbaImage[];
  denyPermission?: boolean;
}

export class FixtureCameraDevice implements CameraDevicePort {
  released: string[] = [];
  opened = 0;
  private served = 0;

  constructor(private readonly opts: FixtureDeviceOptions = {}) {}

  async listDevices() {
    return [{ deviceId: 'fixture-cam-0', facing: 'environment' as const }];
  }

  async open() {
    if (this.opts.denyPermission) return { state: 'unavailable' as const, reason: 'permission-denied' as const };
    this.opened++;
    return { state: 'open' as const, sessionId: `s${this.opened}` };
  }

  exposureCapability(): ExposureCapability {
    return this.opts.exposure ?? { available: false, min: 0, max: 0 };
  }

  async setExposureCompensation(): Promise<boolean> { return true; }

  async grabFrame() {
    const frames = this.opts.frames ?? [scene64()];
    const image = frames[Math.min(this.served, frames.length - 1)];
    this.served++;
    return { image, label: 'fixture' };
  }

  async release(sessionId: string): Promise<void> {
    this.released.push(sessionId);
  }

  contentHash(image: RgbaImage): string { return fnvHash(image); }
}
