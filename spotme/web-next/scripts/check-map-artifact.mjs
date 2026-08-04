#!/usr/bin/env node
/**
 * Map-tiles artifact fence (ADR-030) — runs AFTER `vite build` in the test
 * chain, so it scans the artifact this exact source tree produces (the
 * in-test-file dist scans are conditional on a stale dist; this one is not).
 *
 * While the map ships dark (nothing mounts TileMapView), the production
 * bundle must contain: no maplibre, no pmtiles, and — dark or activated —
 * never a third-party tile host. Google stays licensed for AI-Map data only,
 * never tiles.
 *
 *   node scripts/check-map-artifact.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const failures = [];

if (!existsSync(DIST)) {
  console.error('map artifact fence: dist/ missing — run vite build first (fence must not pass vacuously)');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|css|html)$/.test(entry)) out.push(full);
  }
  return out;
}

const THIRD_PARTY_TILE_HOSTS = /api\.mapbox\.com|tiles\.mapbox\.com|maps\.googleapis\.com|mts\d?\.google|maptiler|tile\.openstreetmap\.org|stadiamaps|tomtom|here\.com/i;
const DARK_MODULES = /maplibre|pmtiles/i;

for (const f of walk(DIST)) {
  const rel = relative(ROOT, f);
  const body = readFileSync(f, 'utf8');
  if (THIRD_PARTY_TILE_HOSTS.test(body)) failures.push(`${rel}: third-party tile host in artifact`);
  if (DARK_MODULES.test(body)) failures.push(`${rel}: map renderer present in artifact while the map ships dark`);
}

if (failures.length) {
  console.error('map artifact fence FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('map artifact fence: PASS (no tile renderer, no third-party tile host in dist)');
