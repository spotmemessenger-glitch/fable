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
 * FILLED AT STAGE 2A: the manifest carries the vendored pins with real
 * digests; `scripts/stage-camera-assets.mjs` stages the binaries into
 * public/models/ reproducibly (package-copy or pinned build-time download,
 * digest-verified — never a runtime fetch from anywhere but our origin).
 * Engines still refuse honestly wherever an asset is unstaged or tampered.
 */

import type { ModelAssetRecord } from '@spotme/contracts';

/**
 * The committed manifest — FILLED at Stage 2A with the vendored pins.
 * Binaries are staged (never committed; repo-light choice) into
 * public/models/ by `scripts/stage-camera-assets.mjs`, which verifies every
 * byte against these digests at BUILD time; the runtime loader re-verifies
 * on load. All paths are same-origin; the C5 fence keeps CDN URLs
 * impossible. Licenses: Apache-2.0 across the bundle (MediaPipe,
 * tesseract.js/-core, tessdata). Languages staged: eng + kan (Kannada, the
 * owner's region) — extend by adding a record + a staging entry.
 */
export const MODEL_ASSET_MANIFEST: readonly ModelAssetRecord[] = Object.freeze([
  {
    assetId: 'face-landmarker', engine: 'mediapipe-face-landmarker', version: '1.0.1/float16-v1',
    path: '/models/face_landmarker.task',
    sha256: 'sha256:64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    licenseId: 'Apache-2.0', sourceUrl: 'https://github.com/google-ai-edge/mediapipe',
  },
  {
    assetId: 'mediapipe-vision-wasm-js', engine: 'mediapipe-face-landmarker', version: '1.0.1',
    path: '/models/vision_wasm_internal.js',
    sha256: 'sha256:e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73',
    licenseId: 'Apache-2.0', sourceUrl: 'https://www.npmjs.com/package/@mediapipe/tasks-vision',
  },
  {
    assetId: 'mediapipe-vision-wasm', engine: 'mediapipe-face-landmarker', version: '1.0.1',
    path: '/models/vision_wasm_internal.wasm',
    sha256: 'sha256:8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886',
    licenseId: 'Apache-2.0', sourceUrl: 'https://www.npmjs.com/package/@mediapipe/tasks-vision',
  },
  {
    assetId: 'tesseract-worker', engine: 'tesseract-js', version: '7.0.0',
    path: '/models/tesseract-worker.min.js',
    sha256: 'sha256:576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
    licenseId: 'Apache-2.0', sourceUrl: 'https://www.npmjs.com/package/tesseract.js',
  },
  {
    assetId: 'tesseract-core', engine: 'tesseract-js', version: '6.1.2',
    path: '/models/tesseract-core-simd-lstm.wasm.js',
    sha256: 'sha256:c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
    licenseId: 'Apache-2.0', sourceUrl: 'https://www.npmjs.com/package/tesseract.js-core',
  },
  {
    assetId: 'tessdata-eng', engine: 'tesseract-js', version: '4.0.0',
    path: '/models/eng.traineddata.gz',
    sha256: 'sha256:ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468',
    licenseId: 'Apache-2.0', sourceUrl: 'https://github.com/naptha/tessdata',
  },
  {
    assetId: 'tessdata-kan', engine: 'tesseract-js', version: '4.0.0',
    path: '/models/kan.traineddata.gz',
    sha256: 'sha256:6013fea593d5d8dab6668e1de6b6fe97efc026b6ccd85f003b43938f7428d498',
    licenseId: 'Apache-2.0', sourceUrl: 'https://github.com/naptha/tessdata',
  },
]);

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
