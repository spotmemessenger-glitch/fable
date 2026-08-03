/**
 * MapView (checkpoint 10) — the deterministic test renderer. NO production map
 * SDK: markers are projected onto a plain SVG viewport. People markers are
 * ALWAYS the approximate ones (no precise location exists client-side for
 * others by contract) and render with an "approximate" ring; nothing in the
 * DOM carries more precision than the coarse values it was given.
 */

import type { MapMarker } from './ports';

export function MapView(props: {
  markers: MapMarker[];
  center: { lat: number; lon: number } | null;
  selectedId: string | null;
  onSelect(id: string): void;
}) {
  const { markers, center } = props;
  const c = center ?? (markers.length ? { lat: markers[0].lat, lon: markers[0].lon } : { lat: 0, lon: 0 });
  const SPAN = 0.06; // degrees rendered across the viewport

  const x = (lon: number) => 50 + ((lon - c.lon) / SPAN) * 100;
  const y = (lat: number) => 50 - ((lat - c.lat) / SPAN) * 100;

  return (
    <svg
      className="disc-map"
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Map with ${markers.length} nearby markers (positions approximate)`}
    >
      <rect x="0" y="0" width="100" height="100" className="disc-map-bg" />
      {markers.map((m) => (
        <g
          key={m.id}
          role="button"
          aria-label={`Map marker ${m.id}${m.approximate ? ' (approximate)' : ''}`}
          tabIndex={0}
          onClick={() => props.onSelect(m.id)}
          onKeyDown={(e) => e.key === 'Enter' && props.onSelect(m.id)}
          className={`disc-marker ${m.kind} ${m.selected || props.selectedId === m.id ? 'selected' : ''}`}
        >
          {m.approximate && <circle cx={x(m.lon)} cy={y(m.lat)} r={6} className="disc-approx-ring" />}
          <circle cx={x(m.lon)} cy={y(m.lat)} r={2.6} />
        </g>
      ))}
    </svg>
  );
}
