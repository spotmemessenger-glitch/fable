/**
 * Nearby Moments — sanitized search projection + provider-neutral port (5C).
 *
 * The index holds ONLY: id, kind, text projection, city cell, created instant.
 * NEVER coordinates (even coarse), NEVER a private OR friends post — the
 * projection accepts PUBLIC posts only (M5: private never enters any index;
 * friends-tier in a shared index would leak to non-friends, so it is excluded
 * too, documented as stricter-than-minimum). Building a projection from a
 * private post THROWS — the 5E fence re-proves it.
 */

import type { MomentRow } from './moments.ports';

export interface MomentSearchDoc {
  id: string;
  kind: string;
  normalizedText: string;
  /** City-level cell ONLY (~11 km) — never the coarse cell, never a point. */
  cityCell: string | null;
  createdAtUTC: number;
}

const COORDINATE_SHAPE_G = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/g;

export function stripCoordinateTokens(s: string): string {
  return (s || '').replace(COORDINATE_SHAPE_G, ' ').replace(/\s+/g, ' ').trim();
}

export class PrivateInProjectionError extends Error {
  constructor(id: string) {
    super(`moment ${id} is not public — private/friends posts never enter any index (M5)`);
    this.name = 'PrivateInProjectionError';
  }
}

/** Build the sanitized doc. PUBLIC posts only; anything else THROWS. */
export function toMomentSearchProjection(row: MomentRow): MomentSearchDoc {
  if (row.visibility !== 'public') throw new PrivateInProjectionError(row.id);
  return {
    id: row.id,
    kind: row.kind,
    normalizedText: stripCoordinateTokens((row.text ?? '').normalize('NFKC').toLowerCase()),
    cityCell: row.cityCell,
    createdAtUTC: row.createdAtUTC,
  };
}

export type MomentSearchResult =
  | { state: 'ok'; hits: { id: string }[] }
  | { state: 'no-results' }
  | { state: 'provider-unavailable'; reason: 'unconfigured' | 'error' };

export interface MomentSearchPort {
  readonly name: string;
  search(query: string, opts?: { limit?: number }): Promise<MomentSearchResult>;
  index(doc: MomentSearchDoc): Promise<{ ok: boolean }>;
}

export const MOMENT_SEARCH_PORT = Symbol('MOMENT_SEARCH_PORT');

/** Default adapter: UNCONFIGURED — typed unavailability, no network, dark. */
export class UnconfiguredMomentSearchAdapter implements MomentSearchPort {
  readonly name = 'unconfigured';
  async search(): Promise<MomentSearchResult> {
    return { state: 'provider-unavailable', reason: 'unconfigured' };
  }
  async index(): Promise<{ ok: boolean }> {
    return { ok: false };
  }
}
