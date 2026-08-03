/**
 * DiscoveryShell (checkpoint 10) — prop-driven layout for the Nearby surface.
 * Map + synchronized list (selection flows both ways through the SAME
 * onSelect), mode toggle, filter sheet, visibility control, explicit state
 * banner. All behavior arrives via props from the application layer
 * (checkpoint 11); this file wires no port and performs no I/O.
 */

import type { DiscoveryFilters, DiscoveryResult, DiscoveryState } from '@spotme/contracts';
import type { MapMarker } from './ports';
import { FilterSheet, ModeToggle, ResultList, SearchBar, StateBanner, VisibilityControl, idOf } from './components';
import type { ViewMode } from './components';
import { MapView } from './MapView';
import './discovery.css';

export interface DiscoveryShellProps {
  state: DiscoveryState;
  searchText: string;
  mode: ViewMode;
  filters: DiscoveryFilters;
  categories: string[];
  openNowSupported: boolean;
  visibilityEnabled: boolean;
  selectedId: string | null;
  markers: MapMarker[];
  center: { lat: number; lon: number } | null;

  onSearchText(v: string): void;
  onSubmit(): void;
  onMode(m: ViewMode): void;
  onFilters(f: DiscoveryFilters): void;
  onVisibility(next: boolean): void;
  onSelect(id: string): void;
  onFriendRequest(id: string): void;
  onBlock(id: string): void;
  onReport(id: string): void;
  onHide(id: string): void;
  onDirections(id: string): void;
  onSave(id: string): void;
  onRetry(): void;
  onEnableLocation(): void;
}

export function DiscoveryShell(p: DiscoveryShellProps) {
  const results: readonly DiscoveryResult[] =
    p.state.kind === 'ready' ? p.state.page.results
    : p.state.kind === 'partial' ? p.state.page.results
    : p.state.kind === 'provider-unavailable' && p.state.page ? p.state.page.results
    : p.state.kind === 'offline' && p.state.cached ? p.state.cached.results
    : [];

  const showMap = p.mode === 'map' || p.mode === 'split';
  const showList = p.mode === 'list' || p.mode === 'split';

  return (
    <main className="disc-shell" aria-label="Nearby discovery">
      <SearchBar value={p.searchText} onChange={p.onSearchText} onSubmit={p.onSubmit} busy={p.state.kind === 'searching'} />
      <ModeToggle mode={p.mode} onMode={p.onMode} />
      <FilterSheet filters={p.filters} categories={p.categories} openNowSupported={p.openNowSupported} onChange={p.onFilters} />
      <VisibilityControl enabled={p.visibilityEnabled} onToggle={p.onVisibility} />
      <StateBanner state={p.state} onRetry={p.onRetry} onEnableLocation={p.onEnableLocation} />

      {showMap && <MapView markers={p.markers} center={p.center} selectedId={p.selectedId} onSelect={p.onSelect} />}
      {showList && results.length > 0 && (
        <ResultList
          results={results}
          selectedId={p.selectedId}
          onSelect={p.onSelect}
          onFriendRequest={p.onFriendRequest}
          onBlock={p.onBlock}
          onReport={p.onReport}
          onHide={p.onHide}
          onDirections={p.onDirections}
          onSave={p.onSave}
        />
      )}
    </main>
  );
}

/** Build map markers from results — people are ALWAYS approximate. */
export function markersFor(results: readonly DiscoveryResult[], selectedId: string | null): MapMarker[] {
  const markers: MapMarker[] = [];
  for (const r of results) {
    if (r.type === 'place') {
      markers.push({
        id: r.place.placeId, lat: r.place.approxLocation.lat, lon: r.place.approxLocation.lon,
        kind: 'place', approximate: true, selected: selectedId === r.place.placeId,
      });
    } else if (r.person.approxLocation) {
      markers.push({
        id: r.person.userId, lat: r.person.approxLocation.lat, lon: r.person.approxLocation.lon,
        kind: 'person', approximate: true, selected: selectedId === r.person.userId,
      });
    }
  }
  void idOf; // shared id helper is the single source for list/map identity
  return markers;
}
