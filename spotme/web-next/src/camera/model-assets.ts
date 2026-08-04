/**
 * Model-asset integrity (C3, ADR-029 §4) — the committed manifest + the
 * loader that enforces it. THE LAW: an engine registers ONLY through
 * `loadVerifiedAsset`, which (1) accepts same-origin paths only — any
 * absolute/CDN URL is refused structurally, there is NO runtime CDN
 * fallback of any kind; (2) verifies the fetched bytes against the
 * manifest's committed sha256 via the injected digest, refusing with
 * `asset-integrity-failed` on any mismatch; (3) never fetches at boot —
 * loading is always an explicit call.
 *
 * THE MANIFEST SHIPS EMPTY THIS STAGE — honestly. Vendoring the pinned
 * MediaPipe face-landmarker `.task` and tesseract.js worker/wasm/traineddata
 * binaries (with their real digests and license records) is a named Stage-2
 * prerequisite: it requires fetching multi-MB model binaries, which this
 * dark stage neither needs (jsdom cannot run either engine) nor should do
 * silently. Until entries exist every engine that depends on an asset
 * reports its honest refusal ('no-landmark-engine' / 'not-loaded').
 */

import type { ModelAssetRecord } from '@spotme/contracts';

/**
 * The committed manifest. EMPTY at Stage 1 (see header); Stage 2 adds one
 * entry per vendored asset — pinned version, same-origin path, sha256,
 * license, source — and the C5 fence keeps CDN URLs impossible.
 */
export const MODEL_ASSET_MANIFEST: readonly ModelAssetRecord[] = Object.freeze([]);

export type AssetLoadResult =
  | { state: 'loaded'; assetId: string; bytes: Uint8Array }
  | { state: 'unavailable'; reason: 'unknown-asset' | 'asset-integrity-failed' | 'not-same-origin' | 'fetch-failed' };

export interface AssetLoaderDeps {
  /** Same-origin byte fetch — injected (no ambient network capability). */
  fetchBytes(path: string): Promise<Uint8Array | null>;
  /** sha256 hex digest of bytes — injected (subtle.crypto at activation). */
  digest(bytes: Uint8Array): Promise<string>;
}

const SAME_ORIGIN_PATH = /^\/[^/]/; // absolute-path-only: no scheme, no host, no protocol-relative

export async function loadVerifiedAsset(
  assetId: string,
  deps: AssetLoaderDeps,
  manifest: readonly ModelAssetRecord[] = MODEL_ASSET_MANIFEST,
): Promise<AssetLoadResult> {
  const record = manifest.find((a) => a.assetId === assetId);
  if (!record) return { state: 'unavailable', reason: 'unknown-asset' };
  // Same-origin only — a CDN URL in a manifest entry is refused HERE too,
  // so even a bad manifest edit cannot open a runtime CDN path.
  if (!SAME_ORIGIN_PATH.test(record.path) || /^[a-z]+:|^\/\//i.test(record.path)) {
    return { state: 'unavailable', reason: 'not-same-origin' };
  }
  const bytes = await deps.fetchBytes(record.path);
  if (!bytes) return { state: 'unavailable', reason: 'fetch-failed' };
  const digest = await deps.digest(bytes);
  const expected = record.sha256.replace(/^sha256:/, '');
  if (digest.replace(/^sha256:/, '') !== expected) {
    return { state: 'unavailable', reason: 'asset-integrity-failed' };
  }
  return { state: 'loaded', assetId, bytes };
}
