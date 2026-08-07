import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { DiscoveryFilters } from '@spotme/contracts';
import { DiscoveryShell, markersFor, resultsOf } from './discovery/DiscoveryShell';
import { DiscoveryController, MemoryCache } from './discovery/controller';
import { FixtureDiscoveryApi } from './discovery/fixtures';
import { DisabledRealtime } from './discovery/ports';
import type { GeolocationPort } from './discovery/ports';
// Baseline instrumentation (ADR-031) goes through the analytics seam only —
// closed vocabulary, NOOP sink while dark (initAnalytics is never called here).
import { track } from './analytics';

/**
 * The inert Discovery beachhead (checkpoints 10/11). Everything is behind
 * deterministic ports — fixture API, fixed fake geolocation, disabled
 * realtime, in-memory cache. NOT deployed; not referenced by spotme/web; no
 * backend, no routing, no auth. The fixture fix below is a public landmark
 * coordinate, not a user location.
 */

const fixtureGeo: GeolocationPort = {
  async getFix() {
    return { state: 'ok', fix: { lat: 12.9716, lon: 77.5946 } };
  },
};

export function App() {
  const controller = useMemo(
    () =>
      new DiscoveryController({
        api: new FixtureDiscoveryApi(),
        geo: fixtureGeo,
        realtime: new DisabledRealtime(),
        clock: { now: () => Date.now() },
        cache: new MemoryCache(),
        selfId: 'fixture-self',
      }),
    [],
  );

  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  useEffect(() => {
    track({ type: 'screen_view', screen: 'discovery' });
  }, []);

  // error_shown carries a machine category only — never coordinates, reasons,
  // or message text (the closed vocabulary rejects anything else).
  useEffect(() => {
    if (state.kind === 'offline') track({ type: 'error_shown', surface: 'discovery', code: 'offline' });
    else if (state.kind === 'provider-unavailable') track({ type: 'error_shown', surface: 'discovery', code: 'provider_unavailable' });
    else if (state.kind === 'permission-required') track({ type: 'error_shown', surface: 'discovery', code: 'permission_required' });
    else if (state.kind === 'location-unavailable') track({ type: 'error_shown', surface: 'discovery', code: 'location_unavailable' });
  }, [state.kind]);

  // One derivation shared with the Shell — the map and list never disagree,
  // including in offline / provider-unavailable states (F7-3).
  const results = resultsOf(state);

  return (
    <DiscoveryShell
      state={state}
      searchText={controller.searchText}
      mode={controller.mode}
      filters={controller.filters}
      categories={['cafe', 'restaurant', 'hospital', 'gym', 'park']}
      openNowSupported={results.some((r) => r.type === 'place' && r.place.openNow !== null && r.place.openNow !== undefined)}
      visibilityEnabled={controller.visibilityEnabled}
      selectedId={controller.selectedId}
      markers={markersFor(results, controller.selectedId)}
      center={null}
      onSearchText={(v) => { controller.searchText = v; rerender(); }}
      onSubmit={() => { track({ type: 'feature_used', name: 'discovery_search' }); void controller.search(); }}
      onMode={(m) => { track({ type: 'feature_used', name: 'view_mode_toggle' }); controller.mode = m; rerender(); }}
      onFilters={(f: DiscoveryFilters) => { controller.filters = f; rerender(); }}
      onVisibility={(next) => { track({ type: 'feature_used', name: 'discovery_visibility_toggle' }); void controller.setVisibility(next).then(rerender); }}
      onSelect={(id) => { track({ type: 'feature_used', name: 'map_marker_select' }); controller.select(id); rerender(); }}
      onFriendRequest={() => { /* D9 dark: no transport exists this phase */ }}
      onBlock={() => { /* dark: block projection wiring is activation work */ }}
      onReport={() => { /* dark */ }}
      onHide={(id) => { controller.hide(id); rerender(); }}
      onDirections={() => { /* dark: external handoff at activation */ }}
      onSave={() => { /* dark */ }}
      onRetry={() => void controller.search()}
      onEnableLocation={() => void controller.search()}
    />
  );
}
