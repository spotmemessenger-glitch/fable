#!/usr/bin/env node
/**
 * Camera Stage 2A — REPRODUCIBLE asset staging (ADR-029 §4).
 *
 * Populates public/models/ with the pinned model/runtime assets for
 * SAME-ORIGIN serving, verifying EVERY byte against the committed sha256
 * digests in src/camera/model-assets.ts before it lands. Binaries do NOT
 * enter git (repo-light choice, documented in the Stage 2A report): the
 * wasm/worker files copy from the exact-pinned npm packages
 * (@mediapipe/tasks-vision@1.0.1, tesseract.js@7.0.0,
 * tesseract.js-core@6.1.2 — package-lock is the second integrity layer),
 * and the two model files download ONCE AT BUILD TIME from their pinned
 * upstream URLs — this is a build step, NOT a runtime CDN: the app only
 * ever loads /models/* from its own origin, and a digest mismatch fails
 * the build loudly.
 *
 *   node scripts/stage-camera-assets.mjs          # stage + verify
 *   node scripts/stage-camera-assets.mjs --verify # verify only (no fetch)
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public/models');

/** The pinned set — MUST stay in lockstep with MODEL_ASSET_MANIFEST. */
const ASSETS = [
  {
    file: 'face_landmarker.task',
    sha256: '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff',
    source: { kind: 'download', url: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task' },
  },
  {
    file: 'vision_wasm_internal.js',
    sha256: 'e170ee67dd4e16c1a6fcd8840a206687e5a59b22c20e4a902bc445b095454d73',
    source: { kind: 'package', path: 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js' },
  },
  {
    file: 'vision_wasm_internal.wasm',
    sha256: '8da277a733926eacd0474b8704b36742d6ec3231c57a860c5b889dff8f1df886',
    source: { kind: 'package', path: 'node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm' },
  },
  {
    file: 'tesseract-worker.min.js',
    sha256: '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
    source: { kind: 'package', path: 'node_modules/tesseract.js/dist/worker.min.js' },
  },
  {
    file: 'tesseract-core-simd-lstm.wasm.js',
    sha256: 'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
    source: { kind: 'package', path: 'node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js' },
  },
  {
    file: 'eng.traineddata.gz',
    sha256: 'ed350f3752f81ee8f38769edc14d92d997dababe23b565c59879372cc46a2468',
    source: { kind: 'download', url: 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/eng.traineddata.gz' },
  },
  {
    file: 'kan.traineddata.gz',
    sha256: '6013fea593d5d8dab6668e1de6b6fe97efc026b6ccd85f003b43938f7428d498',
    source: { kind: 'download', url: 'https://raw.githubusercontent.com/naptha/tessdata/gh-pages/4.0.0/kan.traineddata.gz' },
  },
];

const verifyOnly = process.argv.includes('--verify');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

mkdirSync(OUT, { recursive: true });
let failures = 0;

for (const asset of ASSETS) {
  const dest = join(OUT, asset.file);
  if (!existsSync(dest) && !verifyOnly) {
    if (asset.source.kind === 'package') {
      copyFileSync(join(ROOT, asset.source.path), dest);
    } else {
      const res = await fetch(asset.source.url);
      if (!res.ok) { console.error(`  FAIL  ${asset.file}: fetch ${res.status}`); failures++; continue; }
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
  }
  if (!existsSync(dest)) { console.error(`  FAIL  ${asset.file}: not staged`); failures++; continue; }
  const got = digest(readFileSync(dest));
  if (got !== asset.sha256) {
    console.error(`  FAIL  ${asset.file}: digest mismatch (integrity)`);
    failures++;
    continue;
  }
  console.log(`  OK    ${asset.file}`);
}

console.log(failures === 0 ? `\nstaged + verified ${ASSETS.length}/${ASSETS.length} assets` : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
