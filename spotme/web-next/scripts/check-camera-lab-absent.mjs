#!/usr/bin/env node
/**
 * Camera Stage 2A — prove the camera lab is ABSENT from the production
 * artifact. Runs in the test chain after the (flag-false) production build:
 *
 *  1. no `src/` file imports anything from `lab/` — the lab is one-directional
 *     (lab → src, never src → lab), so it cannot be pulled into the app;
 *  2. the production dist/ (built with CAMERA_LAB_ENABLED unset) contains NO
 *     camera-lab HTML entry and no lab identifier in any chunk;
 *  3. non-vacuity: the lab source actually exists.
 *
 * The lab's OWN network/engine code is deliberately out of the isolation
 * fence's `src/` scope — this fence is what keeps that safe: the lab can
 * only ever ship in a CAMERA_LAB_ENABLED build, never the production one.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const check = (name, pass) => results.push([name, pass === true]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const read = (p) => readFileSync(p, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

// 1. src never imports lab.
const srcFiles = walk(join(ROOT, 'src')).filter((f) => /\.(tsx?|jsx?)$/.test(f));
check('no src file imports from lab/',
  srcFiles.every((f) => !/from\s+['"][^'"]*\/lab\//.test(stripComments(read(f))) && !/from\s+['"]\.\.\/lab/.test(stripComments(read(f)))));

// 2. production dist (built flag-false) carries no lab.
const dist = join(ROOT, 'dist');
if (existsSync(dist)) {
  const distFiles = walk(dist);
  check('production dist has no camera-lab.html entry',
    !distFiles.some((f) => /camera-lab\.html$/.test(f)));
  check('no dist chunk contains a lab identifier',
    distFiles.filter((f) => /\.(js|css|html)$/.test(f)).every((f) => {
      const s = read(f);
      return !s.includes('lab-root') && !s.includes('Camera Lab (Stage 2B)') &&
        !s.includes('createNavigatorDevicePort') && !s.includes('face_landmarker.task');
    }));
} else {
  check('production dist present for the artifact scan', false);
}

// 3. non-vacuity.
check('fence is not vacuous (lab source exists)', existsSync(join(ROOT, 'lab/CameraLab.tsx')));

console.log('\ncamera lab — absent-from-production fence');
let passed = 0;
for (const [name, ok] of results) { console.log(`  ${ok ? 'PASS ' : 'FAIL '} ${name}`); if (ok) passed++; }
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
