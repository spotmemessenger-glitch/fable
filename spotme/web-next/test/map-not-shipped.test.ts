/**
 * ADR-030 — dark fence for the self-hosted map. The tile renderer exists,
 * is exercised by tests, and is NOT wired into the live surface: App and the
 * Discovery shell keep the deterministic SVG MapView. And whether dark or
 * activated, no third-party tile host (mapbox / google / maptiler / …) may
 * appear anywhere in web-next source. scripts/check-map-artifact.mjs makes
 * the same third-party assertion — plus renderer absence — against the
 * artifact `vite build` produces after these tests run.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}
// Comments may NAME forbidden vendors (that is how the rule is documented in
// source); only code is scanned, mirroring check-boundaries.mjs.
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const srcFiles = walk(join(ROOT, 'src')).map((f) => {
  const body = readFileSync(f, 'utf8');
  return { rel: relative(ROOT, f).replace(/\\/g, '/'), body, code: stripComments(body) };
});

describe('map-tiles dark fence', () => {
  it('the map module exists (fence is not vacuous)', () => {
    const mapFiles = srcFiles.filter((f) => f.rel.startsWith('src/map/'));
    expect(mapFiles.map((f) => f.rel)).toEqual(
      expect.arrayContaining(['src/map/TileMapView.tsx', 'src/map/style.ts', 'src/map/tiles-config.ts']),
    );
  });

  it('NOT wired in: no live surface imports the tile map', () => {
    const importers = srcFiles.filter(
      (f) => !f.rel.startsWith('src/map/') && /from\s+['"][^'"]*\/map\/|import\s*\(\s*['"][^'"]*\/map\//.test(f.body),
    );
    expect(importers.map((f) => f.rel)).toEqual([]);
    // Belt and braces on the two live entry files:
    expect(readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8')).not.toMatch(/TileMapView|maplibre|pmtiles/);
    expect(readFileSync(join(ROOT, 'src', 'discovery', 'DiscoveryShell.tsx'), 'utf8')).not.toMatch(/TileMapView|maplibre|pmtiles/);
  });

  it('…but exercised: the renderer, style, and fixture all have tests', () => {
    const tests = walk(join(ROOT, 'test')).map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(tests).toContain('TileMapView');
    expect(tests).toContain('createBaseStyle');
    expect(tests).toContain('sample.pmtiles');
  });

  it('FENCE: no third-party tile host anywhere in web-next source', () => {
    const FORBIDDEN = /api\.mapbox\.com|tiles\.mapbox\.com|maps\.googleapis\.com|maptiler|tile\.openstreetmap\.org|stadiamaps|here\.com|tomtom/i;
    const hits = srcFiles.filter((f) => FORBIDDEN.test(f.code));
    expect(hits.map((f) => f.rel)).toEqual([]);
  });

  it('maplibre/pmtiles imports stay confined to src/map/', () => {
    const outside = srcFiles.filter(
      (f) => !f.rel.startsWith('src/map/') && /from\s+['"](maplibre-gl|pmtiles)/.test(f.code),
    );
    expect(outside.map((f) => f.rel)).toEqual([]);
  });
});
