/**
 * Positive type-level usage — the discovery contracts compose in realistic
 * shapes: a full state machine walk, a mixed result page with mandatory
 * ranking breakdowns, a D9 friend-request gate, a D10 handle result. If any
 * shape drifts, tsc fails here.
 */

import { DISCOVERY_CONTRACTS_VERSION } from '../src/index.ts';
import type {
  CoarsePublicLocation,
  DiscoveryState,
  DiscoveryResultPage,
  DiscoveryResult,
  NearbyPersonPublic,
  NearbyPlacePublic,
  RankingBreakdown,
  VisibilityPreference,
  SearchCursor,
} from '../src/index.ts';

declare const coarse: CoarsePublicLocation;
declare const cursor: SearchCursor;

const ranking: RankingBreakdown = {
  total: 0.78,
  components: [
    { signal: 'proximity', weight: 0.45, value: 1, weighted: 0.45, reason: 'under500m band' },
    { signal: 'freshness', weight: 0.2, value: 0.9, weighted: 0.18, reason: 'observed 2 min ago' },
    { signal: 'textMatch', weight: 0.35, value: 0.43, weighted: 0.15, reason: 'partial name match' },
  ],
  omittedSignals: ['mutual-context'],
  confidence: 0.8,
  source: 'deterministic-baseline',
};

const person: NearbyPersonPublic = {
  userId: 'u1',
  handle: 'priya_k', // D10: opt-in public handle
  displayName: 'Priya',
  distanceBand: 'under500m', // bands only — never metres
  approxLocation: coarse,
  freshness: { observedAt: '2026-08-03T18:00:00Z', expiresAt: '2026-08-03T18:30:00Z' },
  friendRequest: { canSendRequest: true, state: 'none' }, // D9 gate
  safety: { canBlock: true, canReport: true, canHide: true },
};

const place: NearbyPlacePublic = {
  placeId: 'pl1',
  name: 'Cubbon Cafe',
  category: 'cafe',
  approxLocation: coarse,
  deviceDistanceM: 240, // device-local computation — places only
  openNow: true, // present ONLY because the source supports it
  source: { kind: 'place-provider', provider: 'test-fixture', attribution: 'Test Fixture Data' },
  freshness: { observedAt: '2026-08-03T18:00:00Z' },
};

const results: DiscoveryResult[] = [
  { type: 'person', person, ranking },
  { type: 'place', place, ranking },
  { type: 'username', person, exactMatch: true, ranking },
];

const page: DiscoveryResultPage = {
  contractsVersion: DISCOVERY_CONTRACTS_VERSION,
  results,
  radius: { km: 2, expanded: false },
  cursor,
  freshness: { observedAt: '2026-08-03T18:00:05Z' },
};

/* Exhaustive state walk — a missing state variant breaks this switch. */
function describeState(s: DiscoveryState): string {
  switch (s.kind) {
    case 'idle': return 'idle';
    case 'locating': return 'locating';
    case 'permission-required': return 'ask';
    case 'location-unavailable': return s.reason;
    case 'searching': return s.query.scope;
    case 'partial': return `partial:${s.pendingSources.length}`;
    case 'ready': return `ready:${s.page.results.length}`;
    case 'empty': return `empty@${s.radius.km}km`;
    case 'provider-unavailable': return s.providers.join(',');
    case 'offline': return s.cached ? 'offline-cached' : 'offline';
    case 'superseded': return 'superseded';
    case 'failed': return `${s.error.code}: ${s.error.nextStep}`;
    default: {
      const exhaustive: never = s;
      return exhaustive;
    }
  }
}

const vis: VisibilityPreference = {
  enabled: true,
  expiresAt: '2026-08-03T20:00:00Z',
  visibilityVersion: 3,
  updatedAt: '2026-08-03T18:00:00Z',
};

void page; void describeState; void vis;
