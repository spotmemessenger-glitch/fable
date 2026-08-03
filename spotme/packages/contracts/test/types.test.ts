/**
 * Type-level usage checks. This file is type-checked (tsc --noEmit) but never
 * shipped — it proves the contracts compose in realistic usage and that the
 * privacy invariants hold at the type level. If a shape drifts, tsc fails here.
 */

import type {
  CoarseLocation,
  ExchangeItemInput,
  ExchangeSearchResult,
  StructuredIntent,
  Match,
} from '../src/index.ts';

// A coarsened point is constructible and self-labels.
const here: CoarseLocation = { lat: 12.97, lon: 77.59, coarsened: true };

// A well-formed "need" item, location already coarsened on-device.
const need: ExchangeItemInput = {
  type: 'need',
  category: 'services/plumbing',
  text: 'Leaking kitchen tap, need it fixed tonight',
  radiusKm: 10,
  locationPrecision: 'approximate',
  approxLocation: here,
  timeframe: { from: '2026-08-03T18:00:00Z', to: '2026-08-03T23:00:00Z' },
  budgetBand: 'low',
  expiresInHours: 24,
};

const intent: StructuredIntent = {
  type: 'offer',
  category: 'services/plumbing',
  keywords: ['leak', 'tap', 'tonight'],
  confidence: 0.82,
};

const result: ExchangeSearchResult = {
  state: 'ok',
  results: [],
  radiusKm: 10,
  cursor: null,
};

const match: Match = {
  id: 'm1',
  needId: 'n1',
  offerId: 'o1',
  status: 'proposed',
  score: 0.91,
  rankReason: { distance: 0.4, category: 0.3, freshness: 0.21 },
  epoch: 1,
  createdAt: '2026-08-03T18:05:00Z',
};

// Reference the bindings so noUnusedLocals (if ever enabled) and readers both
// see them exercised; `void` keeps this runtime-inert.
void here;
void need;
void intent;
void result;
void match;
