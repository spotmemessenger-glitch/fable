import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import type { DiscoveryFilters } from '@spotme/contracts';
import { DiscoveryShell, markersFor } from './discovery/DiscoveryShell';
import { DiscoveryController, MemoryCache } from './discovery/controller';
import { FixtureDiscoveryApi } from './discovery/fixtures';
import { DisabledRealtime } from './discovery/ports';
import type { GeolocationPort } from './discovery/ports';

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

  const results =
    state.kind === 'ready' ? state.page.results
    : state.kind === 'partial' ? state.page.results
    : [];

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
      onSubmit={() => void controller.search()}
      onMode={(m) => { controller.mode = m; rerender(); }}
      onFilters={(f: DiscoveryFilters) => { controller.filters = f; rerender(); }}
      onVisibility={(next) => void controller.setVisibility(next).then(rerender)}
      onSelect={(id) => { controller.select(id); rerender(); }}
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
