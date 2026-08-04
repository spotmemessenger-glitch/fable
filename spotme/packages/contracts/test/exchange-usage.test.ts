/**
 * Positive type-level usage — the Phase 3 Exchange contracts compose in
 * realistic shapes and the lifecycle/match discriminants narrow exhaustively.
 * Compile-only (the contracts package's test IS `tsc --noEmit`); if any shape
 * drifts, tsc fails here. This is also the positive control proving tsc reads
 * the negative-test file.
 */

import { EXCHANGE_CONTRACTS_VERSION } from '../src/index.ts';
import type {
  ExchangeIntent,
  ExchangeIntentStatus,
  ExchangeMatch,
  ExchangePage,
  ExchangeContactCapability,
  CoarsePublicLocation,
} from '../src/index.ts';

declare const coarse: CoarsePublicLocation;

const need: ExchangeIntent = {
  kind: 'need',
  contractsVersion: EXCHANGE_CONTRACTS_VERSION,
  id: 'x1',
  owner: { kind: 'user', id: 'u1' },
  status: 'active',
  category: 'services/plumbing',
  title: 'Leaking tap',
  text: 'Kitchen tap leaks',
  tags: ['plumbing'],
  availability: { state: 'unknown' },
  approxLocation: coarse,
  radius: { km: 5, maxKm: 25 },
  visibility: 'discoverable',
  moderation: 'clear',
  version: { seq: 1, idempotencyKey: 'k1' },
  createdAtIso: '2026-08-04T00:00:00Z',
  updatedAtIso: '2026-08-04T00:00:00Z',
  expiresAtIso: null,
};
void need;

/** Exhaustive lifecycle handling — a new state added to the union forces a
 *  compile error here via the `never` guard. */
export function label(s: ExchangeIntentStatus): string {
  switch (s) {
    case 'draft': return 'Draft';
    case 'active': return 'Active';
    case 'paused': return 'Paused';
    case 'matched': return 'Matched';
    case 'fulfilled': return 'Fulfilled';
    case 'expired': return 'Expired';
    case 'withdrawn': return 'Withdrawn';
    case 'removed': return 'Removed';
    default: {
      const _exhaustive: never = s;
      return _exhaustive;
    }
  }
}

/** A match with a full, mandatory explanation and a safety-eligible gate. */
const match: ExchangeMatch = {
  contractsVersion: EXCHANGE_CONTRACTS_VERSION,
  id: 'm1', needId: 'x1', offerId: 'o1', status: 'proposed', score: 0.55, epoch: 1,
  distanceBand: 'under2km', proposedAtIso: '2026-08-04T00:00:00Z',
  explanation: {
    components: [
      { signal: 'intentFit', weight: 0.35, value: 1, weighted: 0.35 },
      { signal: 'proximity', weight: 0.25, value: 0.8, weighted: 0.2 },
    ],
    total: 0.55,
    omittedSignals: ['availability', 'trust', 'freshness'],
    safetyEligible: true,
  },
};
void match;

/** A page of matches carries no total count and an opaque cursor. */
declare const page: ExchangePage<ExchangeMatch>;
void page.cursor;
void page.state;

/** Contact starts un-granted and always requires explicit consent. */
const contact: ExchangeContactCapability = {
  canRequestContact: true,
  state: 'none',
  requiresExplicitConsent: true,
};
void contact;
