#!/usr/bin/env node
/**
 * Camera Stage 1 — DARK FENCE source/artifact scans (C5, run in the test
 * chain before typecheck). Plain-node like check-boundaries.mjs; the
 * BEHAVIORAL fences live in test/camera-dark-fences.test.ts.
 *
 *  nothing mounted · no ambient network capability in src/camera · no
 *  provider SDK/endpoint token (gateway-only) · no CDN token near a
 *  model-loader path · no location-shaped identifier on capture/port
 *  sources · built-artifact scan · non-vacuity.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CAMERA = join(ROOT, 'src/camera');

const results = [];
const check = (name, pass) => results.push([name, pass === true]);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css)$/.test(e)) out.push(full);
  }
  return out;
}
const read = (p) => readFileSync(p, 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const cameraFiles = walk(CAMERA);
const offenders = (files, patterns) => {
  const bad = [];
  for (const f of files) {
    const s = stripComments(read(f));
    for (const b of patterns) if (b.test(s)) bad.push(`${f} ~ ${b}`);
  }
  return bad;
};

// 1. Mounted nowhere.
check('App/main import nothing from the camera subtree',
  !/camera/i.test(read(join(ROOT, 'src/App.tsx'))) && !/camera/i.test(read(join(ROOT, 'src/main.tsx'))));

check('no surface outside src/camera imports camera internals',
  walk(join(ROOT, 'src')).filter((f) => !f.includes('/camera/'))
    .every((f) => !/from\s+['"][^'"]*\/camera\//.test(stripComments(read(f)))));

// 2. No ambient network capability — every loader is injected.
check('no fetch/XHR/WebSocket/beacon in src/camera',
  offenders(cameraFiles, [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/, /sendBeacon/, /node:https?/]).length === 0);

// 3. Gateway-only: no provider SDK/endpoint token.
check('no cloud-provider SDK/endpoint token in src/camera',
  offenders(cameraFiles, [/openai/i, /anthropic/i, /gemini/i, /rekognition/i, /cognitiveservices/i, /vision\.googleapis/i, /@google-cloud/i, /aws-sdk/i, /https?:\/\//i]).length === 0);

// 4. No CDN token near model-loader paths.
check('no CDN token in src/camera (model-loader paths included)',
  offenders(cameraFiles, [/\bcdn\./i, /unpkg/i, /jsdelivr/i, /storage\.googleapis/i, /cdnjs/i]).length === 0);

// 5. T-CA-2 at fence level.
check('no location-shaped identifier in engine/camera-port sources',
  offenders([join(CAMERA, 'engine.ts'), join(CAMERA, 'camera-port.ts')], [/\b(latitude|longitude|geolocation|gps)\b/i]).length === 0);

// 6. Built-artifact scan (when a build exists).
const dist = join(ROOT, 'dist/assets');
check('built artifact carries no camera identifier (or no build present)',
  !existsSync(dist) || readdirSync(dist).every((f) => {
    const s = read(join(dist, f));
    return !s.includes('camera-not-wired') && !s.includes('night-stack') &&
      !s.includes('hdr-fusion') && !s.includes('face_landmarker');
  }));

// 7. Non-vacuity.
check('fence is not vacuous (camera subtree exists, non-trivial)', cameraFiles.length >= 12);

console.log('\ncamera — dark fence scans');
let passed = 0;
for (const [name, ok] of results) {
  console.log(`  ${ok ? 'PASS ' : 'FAIL '} ${name}`);
  if (ok) passed++;
}
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
