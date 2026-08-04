/**
 * Base map style (ADR-030) — a clean, minimal MapLibre style over the
 * Protomaps basemap vector schema, self-hosted as a single PMTiles archive.
 *
 * Two themes, both deliberately quiet so the product's teal accent (#14b8a6,
 * used by markers and selection) reads as the loudest colour on the map.
 * Attribution is mandatory: OpenStreetMap contributors (data) and Protomaps
 * (basemap build) — rendered by MapLibre's attribution control from the
 * source's `attribution` string.
 *
 * The style is a pure function of (tilesUrl, theme): no hidden defaults, no
 * third-party fallback host. Glyphs resolve under the same base path as the
 * archive (see build-tiles.md for what the owner uploads alongside it).
 */

import { assetsBaseFor } from './tiles-config';

export type MapTheme = 'light' | 'dark';

export const MAP_ATTRIBUTION =
  '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · <a href="https://protomaps.com">Protomaps</a>';

/** Palette per theme. Keep every colour muted; teal stays reserved for UI accents. */
const PALETTES = {
  light: {
    background: '#f6f8fa',
    earth: '#f1f4f6',
    park: '#e2efe4',
    water: '#c9e2e8',
    building: '#e6eaee',
    roadMinor: '#ffffff',
    roadMajor: '#fde9c8',
    roadCasing: '#dde3e8',
    boundary: '#b7c3cc',
    label: '#3d4a55',
    labelHalo: '#ffffff',
  },
  dark: {
    background: '#101720',
    earth: '#141c26',
    park: '#16241e',
    water: '#0e2733',
    building: '#1a2430',
    roadMinor: '#232f3d',
    roadMajor: '#3a3428',
    roadCasing: '#0c1219',
    boundary: '#3c4a58',
    label: '#aebac6',
    labelHalo: '#101720',
  },
} as const;

/**
 * Build the style object for a configured PMTiles archive. Layer `source-layer`
 * names follow the Protomaps basemap tile schema (earth, landuse, water,
 * roads, buildings, boundaries, places).
 */
export function createBaseStyle(tilesUrl: string, theme: MapTheme): Record<string, unknown> {
  const c = PALETTES[theme];
  return {
    version: 8,
    name: `spotme-base-${theme}`,
    glyphs: `${assetsBaseFor(tilesUrl)}/fonts/{fontstack}/{range}.pbf`,
    sources: {
      basemap: {
        type: 'vector',
        url: `pmtiles://${tilesUrl}`,
        attribution: MAP_ATTRIBUTION,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': c.background } },
      {
        id: 'earth', type: 'fill', source: 'basemap', 'source-layer': 'earth',
        paint: { 'fill-color': c.earth },
      },
      {
        id: 'landuse-park', type: 'fill', source: 'basemap', 'source-layer': 'landuse',
        filter: ['in', ['get', 'kind'], ['literal', ['park', 'nature_reserve', 'forest', 'grass', 'garden', 'cemetery']]],
        paint: { 'fill-color': c.park },
      },
      {
        id: 'water', type: 'fill', source: 'basemap', 'source-layer': 'water',
        paint: { 'fill-color': c.water },
      },
      {
        id: 'buildings', type: 'fill', source: 'basemap', 'source-layer': 'buildings',
        minzoom: 13,
        paint: { 'fill-color': c.building },
      },
      {
        id: 'roads-casing', type: 'line', source: 'basemap', 'source-layer': 'roads',
        minzoom: 11,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': c.roadCasing,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 1.5, 18, 14],
        },
      },
      {
        id: 'roads-minor', type: 'line', source: 'basemap', 'source-layer': 'roads',
        minzoom: 12,
        filter: ['in', ['get', 'kind'], ['literal', ['minor_road', 'other', 'path']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': c.roadMinor,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.5, 18, 8],
        },
      },
      {
        id: 'roads-major', type: 'line', source: 'basemap', 'source-layer': 'roads',
        filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': c.roadMajor,
          'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 6, 0.75, 18, 12],
        },
      },
      {
        id: 'boundaries', type: 'line', source: 'basemap', 'source-layer': 'boundaries',
        paint: { 'line-color': c.boundary, 'line-dasharray': [2, 2], 'line-width': 1 },
      },
      {
        id: 'places', type: 'symbol', source: 'basemap', 'source-layer': 'places',
        layout: {
          'text-field': ['coalesce', ['get', 'name:en'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 12, 15],
        },
        paint: {
          'text-color': c.label,
          'text-halo-color': c.labelHalo,
          'text-halo-width': 1.2,
        },
      },
    ],
  };
}
