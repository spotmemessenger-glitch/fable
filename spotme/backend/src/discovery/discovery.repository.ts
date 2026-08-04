/**
 * Discovery repository PORTS (checkpoint 2). The Prisma/PostGIS implementation
 * arrives with the data model (checkpoints 3+5); the service depends only on
 * these interfaces, so provider-specific logic can never leak upward.
 *
 * Contract obligations the IMPLEMENTATION must honor (enforced by the C5
 * integration tests, restated here because the interface is the contract):
 *  - exclude expired presence rows (T-HOME / C-EXPIRE);
 *  - exclude the querying principal (self);
 *  - exclude blocks in BOTH directions (T-STALK / C-BLOCK);
 *  - obey the visibility preference (P3);
 *  - bounded radius, deterministic keyset pagination, no unbounded scans;
 *  - return coarse data only — the candidate row's distance is server-internal
 *    and never serialized (C-BAND).
 */

import { DecodedCursor, PersonCandidateRow } from './discovery.types';

export interface NearbyPeopleQuery {
  principalId: string;
  originLat: number;
  originLon: number;
  radiusKm: number;
  /** Fetch limit AFTER exclusions; implementations must not over-fetch unboundedly. */
  limit: number;
  cursor: DecodedCursor | null;
  now: Date;
}

export interface DiscoveryPeopleRepository {
  /** Nearest-first candidates obeying every exclusion above, keyset-paged. */
  findNearbyPeople(q: NearbyPeopleQuery): Promise<PersonCandidateRow[]>;
}

export interface VisibilityUpsert {
  enabled: boolean;
  coarseLat: number;
  coarseLon: number;
  coarseCell: string;
  expiresAt: Date;
}

export interface DiscoveryVisibilityRepository {
  /** Principal-keyed upsert of my visibility (writes are never body-keyed). */
  setVisibility(principalId: string, v: VisibilityUpsert): Promise<{ visibilityVersion: number }>;
  /** My own current preference (never another user's — anti-oracle). */
  getVisibility(principalId: string): Promise<{ enabled: boolean; expiresAt: Date | null; visibilityVersion: number } | null>;
}

/** DI tokens — interfaces erase at runtime. */
export const DISCOVERY_PEOPLE_REPOSITORY = Symbol('DISCOVERY_PEOPLE_REPOSITORY');
export const DISCOVERY_VISIBILITY_REPOSITORY = Symbol('DISCOVERY_VISIBILITY_REPOSITORY');
