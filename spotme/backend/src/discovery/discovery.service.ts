/**
 * Discovery service — composition only (checkpoint 2).
 *
 * Validates → queries repository ports → applies safety ordering → projects to
 * privacy-safe public shapes → returns the standard envelope. No provider
 * logic (that lives behind ports), no HTTP concerns (controller), no SQL
 * (repository). Business rules enforced here are exactly the ones the threat
 * model assigns to this layer: banded distance, no total counts, uniform
 * absence, bounded pages, freshness on every page.
 */

import { Inject, Injectable } from '@nestjs/common';
import { DiscoveryError } from './discovery.errors';
import {
  DISCOVERY_PEOPLE_REPOSITORY,
  DiscoveryPeopleRepository,
  DISCOVERY_VISIBILITY_REPOSITORY,
  DiscoveryVisibilityRepository,
  VisibilityUpsert,
} from './discovery.repository';
import { bandForDistanceM, explainPerson, orderPeople } from './discovery.ranking';
import { encodeCursor, validateDiscoveryQuery, DISCOVERY_POLICY_DEFAULTS } from './discovery.policy';
import {
  DISCOVERY_CONTRACTS_VERSION,
  DiscoveryResult,
  DiscoveryResultPage,
  NearbyPersonPublic,
  PersonCandidateRow,
} from './discovery.types';

@Injectable()
export class DiscoveryService {
  constructor(
    @Inject(DISCOVERY_PEOPLE_REPOSITORY) private readonly people: DiscoveryPeopleRepository,
    @Inject(DISCOVERY_VISIBILITY_REPOSITORY) private readonly visibility: DiscoveryVisibilityRepository,
  ) {}

  /** People discovery: validate → repo → order → project → envelope. */
  async queryPeople(principalId: string, body: unknown, now = new Date()): Promise<DiscoveryResultPage> {
    const q = validateDiscoveryQuery(principalId, body);
    if (q.scope !== 'people' && q.scope !== 'mixed') {
      throw new DiscoveryError('SCOPE_UNAVAILABLE', `scope '${q.scope}' is not served by the people engine`, false,
        'use scope people/mixed here; places and usernames route to their own engines');
    }

    const rows = await this.people.findNearbyPeople({
      principalId,
      originLat: q.origin.lat,
      originLon: q.origin.lon,
      radiusKm: q.radiusKm,
      limit: q.pageSize + 1, // +1 to learn whether a next page exists
      cursor: q.cursor,
      now,
    });

    const ordered = orderPeople(dedupeByUser(rows), now);
    const pageRows = ordered.slice(0, q.pageSize);
    const hasMore = ordered.length > q.pageSize;
    const last = pageRows[pageRows.length - 1];

    const results: DiscoveryResult[] = pageRows.map((row) => ({
      type: 'person',
      person: this.project(row, now),
      ranking: explainPerson(row, now),
    }));

    return {
      contractsVersion: DISCOVERY_CONTRACTS_VERSION,
      results,
      radius: { km: q.radiusKm },
      cursor: hasMore && last ? encodeCursor({ d: last.coarseDistanceM, u: last.userId }) : null,
      freshness: { observedAt: now.toISOString() },
    };
  }

  /** Principal-keyed visibility write (P3); body user-ids are ignored. */
  setVisibility(principalId: string, v: VisibilityUpsert) {
    return this.visibility.setVisibility(principalId, v);
  }

  getVisibility(principalId: string) {
    return this.visibility.getVisibility(principalId);
  }

  /** Project a candidate to the PUBLIC shape — bands only, coarse only. */
  private project(row: PersonCandidateRow, now: Date): NearbyPersonPublic {
    return {
      userId: row.userId,
      ...(row.handle ? { handle: row.handle } : {}),
      displayName: row.displayName,
      ...(row.avatarRef ? { avatarRef: row.avatarRef } : {}),
      distanceBand: bandForDistanceM(row.coarseDistanceM),
      approxLocation: { lat: row.coarseLat, lon: row.coarseLon, cell: row.coarseCell },
      freshness: {
        observedAt: row.observedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        ...(row.expiresAt.getTime() - now.getTime() < 0 ? { stale: true } : {}),
      },
      // D9 (dark): the accept-gated capability; graph integration is a later
      // checkpoint — 'none' is the honest current state, never a fabrication.
      friendRequest: { canSendRequest: true, state: 'none' },
      safety: { canBlock: true, canReport: true, canHide: true },
    };
  }
}

function dedupeByUser(rows: PersonCandidateRow[]): PersonCandidateRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.userId) ? false : (seen.add(r.userId), true)));
}

export { DISCOVERY_POLICY_DEFAULTS };
