/**
 * Discovery — server-side types (Platform Phase 2, checkpoint 2).
 *
 * These MIRROR `@spotme/contracts/src/discovery.ts` v1 (the wire authority).
 * The backend compiles under its own CommonJS tsconfig and cannot yet import
 * the TS-source contracts package directly; until the backend adopts a
 * path-mapped contracts build, this file is the server's copy of the v1 wire
 * shapes, pinned by DISCOVERY_CONTRACTS_VERSION and revalidated in tests.
 * A drift between the two files is a contract break and fails review, not
 * runtime.
 *
 * Privacy invariants carried here (threat model ch. 14):
 *  - No precise-coordinate type exists; the only location shape is the coarse
 *    contract (T-EXACT / C-BRAND server side: `policy.ts` refuses anything
 *    shaped like a device GeolocationCoordinates object).
 *  - Person distance is a band, never a number (T-TRIANG / C-BAND).
 *  - Pages carry no total count (T-SCRAPE / C-NOCOUNT).
 */

export const DISCOVERY_CONTRACTS_VERSION = 1 as const;

export type DistanceBand = 'under500m' | 'under1km' | 'under2km' | 'under5km' | 'over5km';

/** Wire shape of the coarse public origin (brand is type-level, client-side). */
export interface CoarseOriginWire {
  lat: number;
  lon: number;
  cell?: string;
}

export type DiscoveryIntent =
  | { kind: 'people' }
  | { kind: 'username'; handle: string }
  | { kind: 'place'; text: string }
  | { kind: 'category'; category: string; openNow?: boolean }
  | { kind: 'unavailable-domain'; domain: 'exchange' | 'events' | 'moments' | 'assistant' };

export type DiscoveryScope = 'people' | 'places' | 'usernames' | 'mixed';

/** A3: exactly these three filters. A8: openNow is places-only. */
export interface DiscoveryFilters {
  distanceBand?: DistanceBand;
  category?: string;
  openNow?: boolean;
}

export interface DiscoveryQueryWire {
  contractsVersion: number;
  intent: DiscoveryIntent;
  scope: DiscoveryScope;
  origin: CoarseOriginWire;
  radius: { km: number; expanded?: boolean };
  filters?: DiscoveryFilters;
  cursor?: string | null;
}

export interface FreshnessMetadata {
  observedAt?: string;
  expiresAt?: string;
  stale?: boolean;
}

export interface RankingComponent {
  signal: string;
  weight: number;
  value: number;
  weighted: number;
  reason: string;
}

export interface RankingBreakdown {
  total: number;
  components: RankingComponent[];
  omittedSignals: string[];
  confidence: number;
  source: string;
}

export interface FriendRequestCapability {
  canSendRequest: boolean;
  state: 'none' | 'pending-sent' | 'pending-received' | 'accepted';
}

export interface BlockReportCapability {
  canBlock: boolean;
  canReport: boolean;
  canHide: boolean;
}

export interface NearbyPersonPublic {
  userId: string;
  handle?: string;
  displayName: string;
  avatarRef?: string;
  distanceBand: DistanceBand;
  approxLocation?: CoarseOriginWire;
  freshness: FreshnessMetadata;
  friendRequest: FriendRequestCapability;
  safety: BlockReportCapability;
}

export type DiscoveryResult =
  | { type: 'person'; person: NearbyPersonPublic; ranking: RankingBreakdown }
  | { type: 'username'; person: NearbyPersonPublic; exactMatch: boolean; ranking: RankingBreakdown };

export interface DiscoveryResultPage {
  contractsVersion: number;
  results: DiscoveryResult[];
  radius: { km: number; expanded?: boolean };
  cursor: string | null;
  freshness: FreshnessMetadata;
}

/* ------------------------------------------------------------------ *
 * Internal (never serialized to clients)
 * ------------------------------------------------------------------ */

/** A validated, ceiling-clamped query as the service consumes it. */
export interface ValidatedDiscoveryQuery {
  principalId: string;
  intent: DiscoveryIntent;
  scope: DiscoveryScope;
  origin: CoarseOriginWire;
  radiusKm: number;
  filters: DiscoveryFilters;
  cursor: DecodedCursor | null;
  pageSize: number;
}

/** Keyset cursor internals — OPAQUE on the wire (base64url of these fields). */
export interface DecodedCursor {
  /** Last row's server-computed distance in metres (deterministic per origin). */
  d: number;
  /** Last row's userId — the deterministic tie-breaker. */
  u: string;
}

/** A candidate person row as the repository returns it (pre-projection). */
export interface PersonCandidateRow {
  userId: string;
  displayName: string;
  handle: string | null;
  avatarRef: string | null;
  /** Server-side coarse distance in metres — used ONLY to derive the band and
   *  the keyset cursor; NEVER serialized to clients (C-BAND). */
  coarseDistanceM: number;
  coarseLat: number;
  coarseLon: number;
  coarseCell: string;
  observedAt: Date;
  expiresAt: Date;
}
