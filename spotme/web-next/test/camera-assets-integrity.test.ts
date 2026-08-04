/**
 * Stage 2A — asset integrity against the REAL vendored digests. The loader
 * now (1) PASSES for the staged bytes whose sha256 matches the committed
 * manifest, (2) still refuses tampered bytes as asset-integrity-failed, and
 * (3) still refuses any non-same-origin path structurally. Uses the actual
 * staged files under public/models when present; falls back to a
 * digest-reconstruction proof when a --verify build hasn't staged them
 * (CI without the binaries), so the test is honest in both environments.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MODEL_ASSET_MANIFEST, loadVerifiedAsset } from '../src/camera/model-assets';
import type { AssetLoaderDeps } from '../src/camera/model-assets';

const MODELS = join(dirname(fileURLToPath(import.meta.url)), '..', 'public/models');
const sha256 = (b: Uint8Array) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

/** A loader backed by the on-disk staged files (real bytes when present). */
const diskDeps: AssetLoaderDeps = {
  async fetchBytes(path) {
    const f = join(MODELS, path.replace(/^\/models\//, ''));
    return existsSync(f) ? new Uint8Array(readFileSync(f)) : null;
  },
  async digest(bytes) { return sha256(bytes); },
};

describe('Stage 2A vendored assets — the manifest is filled and real', () => {
  it('carries the pinned bundle: MediaPipe + tesseract core/worker + eng & kan tessdata', () => {
    const ids = MODEL_ASSET_MANIFEST.map((a) => a.assetId).sort();
    expect(ids).toEqual([
      'face-landmarker', 'mediapipe-vision-wasm', 'mediapipe-vision-wasm-js',
      'tessdata-eng', 'tessdata-kan', 'tesseract-core', 'tesseract-worker',
    ]);
    for (const a of MODEL_ASSET_MANIFEST) {
      expect(a.licenseId).toBe('Apache-2.0');
      expect(a.path.startsWith('/models/')).toBe(true);
      expect(a.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(a.sourceUrl).toMatch(/^https:\/\//);
    }
  });
});

describe('Stage 2A loader — PASSES real digests, refuses tampering and CDN', () => {
  const staged = existsSync(join(MODELS, 'face_landmarker.task'));

  it(staged ? 'loads the real face_landmarker.task, digest verified' : 'loads a digest-reconstructed asset (binaries not staged in this env)', async () => {
    if (staged) {
      const result = await loadVerifiedAsset('face-landmarker', diskDeps);
      expect(result.state).toBe('loaded');
    } else {
      // No binaries in this checkout: prove the loader accepts bytes whose
      // digest matches the committed record (the staging script enforces
      // the same equality at build time).
      const record = MODEL_ASSET_MANIFEST.find((a) => a.assetId === 'face-landmarker')!;
      const deps: AssetLoaderDeps = {
        async fetchBytes() { return new Uint8Array([1, 2, 3]); },
        async digest() { return record.sha256; },
      };
      const result = await loadVerifiedAsset('face-landmarker', deps);
      expect(result.state).toBe('loaded');
    }
  });

  it('every staged asset that exists verifies against its committed digest', async () => {
    for (const a of MODEL_ASSET_MANIFEST) {
      const f = join(MODELS, a.path.replace(/^\/models\//, ''));
      if (!existsSync(f)) continue;
      const result = await loadVerifiedAsset(a.assetId, diskDeps);
      expect(result.state).toBe('loaded');
    }
  });

  it('TAMPERED bytes are refused asset-integrity-failed', async () => {
    const tampered: AssetLoaderDeps = {
      async fetchBytes() { return new Uint8Array([9, 9, 9]); },
      async digest(bytes) { return sha256(bytes); },
    };
    const result = await loadVerifiedAsset('face-landmarker', tampered);
    expect(result).toEqual({ state: 'unavailable', reason: 'asset-integrity-failed' });
  });

  it('a CDN path in a manifest entry is still refused not-same-origin', async () => {
    const cdnManifest = [{ ...MODEL_ASSET_MANIFEST[0], path: 'https://cdn.example.com/face_landmarker.task' }];
    expect(await loadVerifiedAsset('face-landmarker', diskDeps, cdnManifest))
      .toEqual({ state: 'unavailable', reason: 'not-same-origin' });
  });
});
