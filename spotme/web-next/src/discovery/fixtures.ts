/**
 * Deterministic fixture API (checkpoints 10/11) — the only DiscoveryApiPort
 * implementation this phase. No network: pages are synthesized locally from
 * the query's coarse origin, so the inert app renders realistically while
 * remaining fully dark. Also the RECORDING double for the privacy mutation
 * tests: everything that "left" through the port is captured for scanning.
 */

import type {
  CoarsePublicLocation,
  DiscoveryQuery,
  DiscoveryResult,
  DiscoveryResultPage,
  RankingBreakdown,
  VisibilityPreference,
} from '@spotme/contracts';
import type { DiscoveryApiPort } from './ports';

const ranking = (band: string): RankingBreakdown => ({
  total: 0.6,
  components: [{ signal: 'proximity', weight: 0.3, value: 1, weighted: 0.3, reason: `${band} band` }],
  omittedSignals: ['mutual-context'],
  confidence: 0.8,
  source: 'deterministic-baseline',
});

export class FixtureDiscoveryApi implements DiscoveryApiPort {
  /** Everything that crossed the port, serialized — the privacy scan surface. */
  readonly outbound: string[] = [];
  /** Canonical URL rendering of each request (what a real transport would send). */
  readonly urls: string[] = [];
  visibility: VisibilityPreference = { enabled: false, visibilityVersion: 0, updatedAt: '2026-08-03T00:00:00Z' };
  /** Set to simulate network loss. */
  offline = false;
  /** Set to return zero results (exercises adaptive radius). */
  empty = false;

  async query(q: DiscoveryQuery, _signal?: AbortSignal): Promise<DiscoveryResultPage> {
    this.outbound.push(JSON.stringify(q));
    this.urls.push(`/v2/discovery/query?o=${q.origin.lat},${q.origin.lon}&r=${q.radius.km}`);
    if (this.offline) {
      const e = new TypeError('network request failed');
      throw e;
    }
    if (this.empty) {
      return { contractsVersion: 1, results: [], radius: q.radius, cursor: null, freshness: {} };
    }
    const near = (dLat: number, dLon: number): CoarsePublicLocation =>
      ({ lat: q.origin.lat + dLat, lon: q.origin.lon + dLon, cell: q.origin.cell } as CoarsePublicLocation);

    const results: DiscoveryResult[] = [
      {
        type: 'person',
        person: {
          userId: 'fx-person-1', handle: 'priya_k', displayName: 'Priya', distanceBand: 'under500m',
          approxLocation: near(0.002, 0.001),
          freshness: { observedAt: '2026-08-03T18:00:00Z', expiresAt: '2099-01-01T00:00:00Z' },
          friendRequest: { canSendRequest: true, state: 'none' },
          safety: { canBlock: true, canReport: true, canHide: true },
        },
        ranking: ranking('under500m'),
      },
      {
        type: 'place',
        place: {
          placeId: 'fx-place-1', name: 'Cubbon Coffee House', category: 'cafe',
          approxLocation: near(-0.003, 0.002), deviceDistanceM: 380, openNow: true,
          source: { kind: 'place-provider', provider: 'in-memory-fixture', attribution: 'Deterministic Test Fixture Data' },
          freshness: {},
        },
        ranking: ranking('under500m'),
      },
    ];
    return { contractsVersion: 1, results, radius: q.radius, cursor: null, freshness: { observedAt: '2026-08-03T18:00:05Z' } };
  }

  async setVisibility(v: { enabled: boolean; origin: CoarsePublicLocation | null; expiresInMinutes: number }): Promise<VisibilityPreference> {
    this.outbound.push(JSON.stringify(v));
    this.urls.push(`/v2/discovery/visibility?enabled=${v.enabled}${v.origin ? `&o=${v.origin.lat},${v.origin.lon}` : ''}`);
    this.visibility = {
      enabled: v.enabled,
      visibilityVersion: this.visibility.visibilityVersion + 1,
      updatedAt: '2026-08-03T18:00:00Z',
      ...(v.enabled ? { expiresAt: '2026-08-03T18:30:00Z' } : {}),
    };
    return this.visibility;
  }
}
