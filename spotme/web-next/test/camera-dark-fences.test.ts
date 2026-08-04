/**
 * Stage 1 C5 — camera dark fences, BEHAVIORAL half. The source/artifact
 * scans (no mount, no ambient network, no provider/CDN token, artifact
 * scan, non-vacuity) run in `scripts/check-camera-fences.mjs` as part of
 * the npm test chain — plain node, like the isolation fence. Here: the
 * re-proofs only a runtime can give.
 */

import { describe, expect, it } from 'vitest';
import { DisabledCloudVision } from '../src/camera/cloud';
import { loadVerifiedAsset, MODEL_ASSET_MANIFEST } from '../src/camera/model-assets';
import type { CloudConsentContext } from '@spotme/contracts';

describe('camera — behavioral dark fences', () => {
  it('NO model asset can load at Stage 1: the committed manifest is EMPTY and refusal precedes any fetch', async () => {
    expect(MODEL_ASSET_MANIFEST.length).toBe(0);
    let fetches = 0;
    const result = await loadVerifiedAsset('anything', {
      fetchBytes: async () => { fetches++; return new Uint8Array(); },
      digest: async () => 'x',
    });
    expect(result).toEqual({ state: 'unavailable', reason: 'unknown-asset' });
    expect(fetches).toBe(0); // refused BEFORE any fetch — nothing loads at boot or ever
  });

  it('a cloud call WITHOUT the consent parameter cannot run — even past the types', async () => {
    const port = new DisabledCloudVision(() => 1000);
    await expect(
      port.request('recognize', 'ref:1', undefined as unknown as CloudConsentContext),
    ).rejects.toThrow(/cloud-consent: missing/);
  });

  it('a consent object with a non-single-request scope cannot run', async () => {
    const port = new DisabledCloudVision(() => 1000);
    const fake = { kind: 'cloud-vision-consent', scope: 'global', grantedAtUTC: 900, surface: 's' };
    await expect(port.request('recognize', 'ref:1', fake as unknown as CloudConsentContext))
      .rejects.toThrow(/malformed/);
  });
});
