/**
 * TileMapView (ADR-030) — the self-hosted vector-tile renderer behind the
 * existing map component seam: prop-compatible with discovery/MapView, so
 * swapping the SVG placeholder for real tiles is a one-line change in
 * DiscoveryShell *at activation time*. Nothing mounts this component today —
 * the live app keeps MapView, and the map-tiles fence proves it.
 *
 * Structural darkness: without a configured TILES_URL this component renders
 * an honest static placeholder and never constructs a maplibre Map, registers
 * a protocol, or issues a request. With one, every byte it fetches (tiles,
 * glyphs) comes from that single self-hosted origin via the pmtiles protocol.
 *
 * Privacy posture matches MapView: markers are already-coarse by contract;
 * nothing here reads geolocation or adds precision.
 */

import { useEffect, useRef } from 'react';
import { Map as MapLibreMap, Marker, addProtocol } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';
import './map.css';
import type { MapMarker } from '../discovery/ports';
import { resolveTilesUrl, tilesConfigured } from './tiles-config';
import { createBaseStyle, MAP_ATTRIBUTION, type MapTheme } from './style';

let protocolRegistered = false;
function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  addProtocol('pmtiles', new Protocol().tile);
  protocolRegistered = true;
}

const DEFAULT_CENTER = { lat: 20.5937, lon: 78.9629 }; // India centroid — matches the owner's extract
const DEFAULT_ZOOM = 13;

export function TileMapView(props: {
  markers: MapMarker[];
  center: { lat: number; lon: number } | null;
  selectedId: string | null;
  onSelect(id: string): void;
  /** Test/override seam; defaults to the build-time TILES_URL. */
  tilesUrl?: string;
  theme?: MapTheme;
}) {
  const { markers, center, selectedId, theme = 'light' } = props;
  const tilesUrl = resolveTilesUrl(props.tilesUrl);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerObjsRef = useRef<Marker[]>([]);
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;

  // Construct/destroy the map. Only runs live when a tile source is configured.
  useEffect(() => {
    if (!tilesConfigured(tilesUrl) || !containerRef.current) return;
    ensurePmtilesProtocol();
    const c = center ?? DEFAULT_CENTER;
    const map = new MapLibreMap({
      container: containerRef.current,
      style: createBaseStyle(tilesUrl, theme) as never,
      center: [c.lon, c.lat],
      zoom: DEFAULT_ZOOM,
      attributionControl: { compact: false }, // OSM/Protomaps credit always visible
    });
    mapRef.current = map;
    return () => {
      markerObjsRef.current.forEach((m) => m.remove());
      markerObjsRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // Theme/source changes rebuild the map — both are activation-time constants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tilesUrl, theme]);

  // Render markers with the same a11y contract as the SVG MapView (F7-2).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    markerObjsRef.current.forEach((m) => m.remove());
    markerObjsRef.current = markers.map((m) => {
      const el = document.createElement('div');
      el.className =
        `tile-marker ${m.kind}` +
        (m.approximate ? ' approximate' : '') +
        (m.selected || selectedId === m.id ? ' selected' : '');
      el.setAttribute('role', 'button');
      el.setAttribute('tabindex', '0');
      el.setAttribute(
        'aria-label',
        `${m.label ?? `${m.kind} marker`}${m.approximate ? ' (approximate location)' : ''}`,
      );
      el.addEventListener('click', () => onSelectRef.current(m.id));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelectRef.current(m.id);
        }
      });
      return new Marker({ element: el }).setLngLat([m.lon, m.lat]).addTo(map);
    });
  }, [markers, selectedId]);

  useEffect(() => {
    if (mapRef.current && center) mapRef.current.setCenter([center.lon, center.lat]);
  }, [center]);

  if (!tilesConfigured(tilesUrl)) {
    // Honest inert state: no tile source configured, nothing fetched.
    return (
      <div className="tile-map tile-map-unconfigured" role="img" aria-label="Map unavailable — no tile source configured">
        <p>Map tiles are not configured.</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`tile-map tile-map-${theme}`}
      role="application"
      aria-label={`Map with ${markers.length} nearby markers (positions approximate)`}
      // Attribution is rendered by the maplibre control from MAP_ATTRIBUTION;
      // referencing it here keeps the credit requirement visible in source.
      data-attribution={MAP_ATTRIBUTION ? 'osm-protomaps' : undefined}
    />
  );
}
