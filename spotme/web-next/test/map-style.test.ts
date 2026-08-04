/**
 * ADR-030 — base style unit tests: the style is a pure function of
 * (tilesUrl, theme), reads ONLY the self-hosted PMTiles archive, credits
 * OSM + Protomaps, and stays teal-accent-compatible (muted palette).
 */
import { describe, expect, it } from 'vitest';
import { createBaseStyle, MAP_ATTRIBUTION } from '../src/map/style';
import { assetsBaseFor, resolveTilesUrl, tilesConfigured } from '../src/map/tiles-config';

const URL_ = 'https://tiles.example.test/tiles/india.pmtiles';

describe('tiles config', () => {
  it('explicit override wins; build-time default is empty in tests (map inert)', () => {
    expect(resolveTilesUrl('x')).toBe('x');
    expect(resolveTilesUrl()).toBe('');
    expect(tilesConfigured('')).toBe(false);
    expect(tilesConfigured('  ')).toBe(false);
    expect(tilesConfigured(URL_)).toBe(true);
  });

  it('map assets (glyphs) resolve under the archive base — one host only', () => {
    expect(assetsBaseFor(URL_)).toBe('https://tiles.example.test/tiles');
  });
});

describe('base style', () => {
  const light = createBaseStyle(URL_, 'light');
  const dark = createBaseStyle(URL_, 'dark');

  it('single vector source reading the archive via the pmtiles protocol', () => {
    const sources = light.sources as Record<string, { type: string; url: string; attribution: string }>;
    expect(Object.keys(sources)).toEqual(['basemap']);
    expect(sources.basemap.type).toBe('vector');
    expect(sources.basemap.url).toBe(`pmtiles://${URL_}`);
  });

  it('honours OpenStreetMap and Protomaps attribution', () => {
    const sources = light.sources as Record<string, { attribution: string }>;
    expect(sources.basemap.attribution).toBe(MAP_ATTRIBUTION);
    expect(MAP_ATTRIBUTION).toContain('OpenStreetMap');
    expect(MAP_ATTRIBUTION).toContain('Protomaps');
  });

  it('glyphs stay on the archive host — no second origin for labels', () => {
    expect(light.glyphs).toBe('https://tiles.example.test/tiles/fonts/{fontstack}/{range}.pbf');
  });

  it('light and dark are distinct themes over the same layers', () => {
    const layerIds = (s: Record<string, unknown>) => (s.layers as { id: string }[]).map((l) => l.id);
    expect(layerIds(dark)).toEqual(layerIds(light));
    const bg = (s: Record<string, unknown>) =>
      ((s.layers as { id: string; paint: Record<string, string> }[]).find((l) => l.id === 'background')!).paint['background-color'];
    expect(bg(light)).not.toBe(bg(dark));
  });

  it('FENCE: no third-party tile host anywhere in either style', () => {
    const FORBIDDEN = /mapbox|googleapis|google\.com|maptiler|tile\.openstreetmap\.org|stadiamaps|here\.com|tomtom/i;
    expect(JSON.stringify(light)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(dark)).not.toMatch(FORBIDDEN);
  });
});
