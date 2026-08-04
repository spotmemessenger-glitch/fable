/**
 * ADR-030 — TileMapView behavior behind the map component seam. maplibre-gl
 * needs WebGL, which jsdom lacks, so the renderer is mocked at the module
 * boundary; what these tests pin down is OUR contract: structural inertness
 * without TILES_URL, pmtiles protocol registration, style wiring, always-on
 * attribution, and marker a11y parity with the SVG MapView (F7-2).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TileMapView } from '../src/map/TileMapView';
import type { MapMarker } from '../src/discovery/ports';

const calls: {
  maps: { options: Record<string, unknown>; removed: boolean; center: unknown }[];
  markers: { el: HTMLElement; lngLat: unknown; removed: boolean }[];
  protocols: string[];
} = { maps: [], markers: [], protocols: [] };

vi.mock('maplibre-gl', () => {
  class FakeMap {
    rec = { options: {} as Record<string, unknown>, removed: false, center: null as unknown };
    constructor(options: Record<string, unknown>) {
      this.rec.options = options;
      calls.maps.push(this.rec);
    }
    setCenter(c: unknown) { this.rec.center = c; }
    remove() { this.rec.removed = true; }
  }
  class FakeMarker {
    rec = { el: null as unknown as HTMLElement, lngLat: null as unknown, removed: false };
    constructor(opts: { element: HTMLElement }) {
      this.rec.el = opts.element;
      calls.markers.push(this.rec);
    }
    setLngLat(l: unknown) { this.rec.lngLat = l; return this; }
    addTo(map: unknown) { void map; document.body.appendChild(this.rec.el); return this; }
    remove() { this.rec.removed = true; }
  }
  const addProtocol = (name: string) => { calls.protocols.push(name); };
  return { Map: FakeMap, Marker: FakeMarker, addProtocol };
});

vi.mock('pmtiles', () => ({
  Protocol: class { tile = () => Promise.resolve({ data: new Uint8Array() }); },
}));

const URL_ = 'https://tiles.example.test/tiles/india.pmtiles';
const markers: MapMarker[] = [
  { id: 'p1', lat: 12.97, lon: 77.59, kind: 'person', approximate: true, selected: false, label: 'Asha' },
  { id: 'v1', lat: 12.98, lon: 77.6, kind: 'place', approximate: false, selected: false, label: 'Cubbon Park' },
];

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  calls.maps.length = 0;
  calls.markers.length = 0;
  calls.protocols.length = 0;
});

describe('TileMapView — dark by configuration', () => {
  it('without TILES_URL: honest placeholder, NO map constructed, NO protocol registered', () => {
    render(<TileMapView markers={markers} center={null} selectedId={null} onSelect={() => {}} />);
    expect(screen.getByRole('img', { name: /no tile source configured/i })).toBeTruthy();
    expect(calls.maps).toHaveLength(0);
    expect(calls.protocols).toHaveLength(0);
    expect(calls.markers).toHaveLength(0);
  });
});

describe('TileMapView — configured (fixture URL)', () => {
  it('mounts a maplibre map on the pmtiles style with visible attribution', () => {
    render(
      <TileMapView markers={markers} center={{ lat: 12.97, lon: 77.59 }} selectedId={null} onSelect={() => {}} tilesUrl={URL_} />,
    );
    expect(calls.protocols).toEqual(['pmtiles']);
    expect(calls.maps).toHaveLength(1);
    const opts = calls.maps[0].options;
    const style = opts.style as { sources: Record<string, { url: string }> };
    expect(style.sources.basemap.url).toBe(`pmtiles://${URL_}`);
    expect(JSON.stringify(style)).toContain('OpenStreetMap');
    expect(opts.attributionControl).toEqual({ compact: false });
    expect(opts.center).toEqual([77.59, 12.97]);
  });

  it('renders one a11y-labelled button per marker; approximate people keep their halo class', () => {
    render(
      <TileMapView markers={markers} center={null} selectedId={null} onSelect={() => {}} tilesUrl={URL_} />,
    );
    expect(calls.markers).toHaveLength(2);
    const asha = screen.getByRole('button', { name: 'Asha (approximate location)' });
    expect(asha.className).toContain('approximate');
    expect(screen.getByRole('button', { name: 'Cubbon Park' }).className).toContain('place');
    expect(calls.markers[0].lngLat).toEqual([77.59, 12.97]);
  });

  it('selection works by click AND by keyboard (Enter and Space), like the SVG MapView', async () => {
    const seen: string[] = [];
    render(
      <TileMapView markers={markers} center={null} selectedId={null} onSelect={(id) => seen.push(id)} tilesUrl={URL_} />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Asha/ }));
    screen.getByRole('button', { name: 'Cubbon Park' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(seen).toEqual(['p1', 'v1', 'v1']);
  });

  it('unmount tears the map down (no leaked GL contexts at activation time)', () => {
    const { unmount } = render(
      <TileMapView markers={markers} center={null} selectedId={null} onSelect={() => {}} tilesUrl={URL_} />,
    );
    unmount();
    expect(calls.maps[0].removed).toBe(true);
    expect(calls.markers.every((m) => m.removed)).toBe(true);
  });
});
