/**
 * Smart Nearby Discovery Map — shared contracts (Platform Phase 2, checkpoint 1).
 *
 * Framework-neutral, types-only. These are the single wire/domain contracts for
 * every Discovery surface across backend, web-next, and the future React Native
 * client (P10). They encode the mission's product principles at the TYPE level
 * wherever a type can carry a rule:
 *
 *  - P2 (privacy by architecture): there is NO precise-coordinate type in any
 *    outbound/public contract. The only location shape that may leave a device
 *    is the BRANDED {@link CoarsePublicLocation}; a raw `{lat, lon}` literal is
 *    a compile error when assigned to it (see `test/discovery-negative.test.ts`).
 *  - P4 (honest results): every optional signal documents that ABSENT MEANS
 *    UNKNOWN — an adapter that cannot know a value must leave it undefined,
 *    never invent it. `exactOptionalPropertyTypes` is on: `undefined` may not
 *    be assigned explicitly where the property is optional-by-omission.
 *  - P5 (explainable ranking): {@link RankingBreakdown} is REQUIRED on every
 *    ranked result — there is no un-explained score shape to reach for.
 *  - P7 (consent gates communication): {@link FriendRequestCapability} is the
 *    ONLY communication affordance a person result carries (D9 — dark build);
 *    no chat handle, room id, or address appears in any public projection.
 *  - A3: {@link DiscoveryFilters} is distance band + category + open-now ONLY.
 *    No age or gender field exists anywhere in these contracts.
 *  - People never carry exact distance — {@link DistanceBand} only (threat
 *    model control T-EXACT-DIST). Places may carry a numeric distance because
 *    it is computed device-locally from the device's own fix (never asserted
 *    by the server).
 */

/** Contracts version — bump on any breaking change to the discovery shapes. */
export const DISCOVERY_CONTRACTS_VERSION = 1 as const;
export type DiscoveryContractsVersion = typeof DISCOVERY_CONTRACTS_VERSION;

/* ------------------------------------------------------------------ *
 * Location — the privacy boundary, expressed as a type
 * ------------------------------------------------------------------ */

declare const CoarsePublicLocationBrand: unique symbol;

/**
 * The ONLY location shape permitted in outbound/public discovery payloads.
 *
 * Produced exclusively by the device-local coarsening boundary (the live
 * `coarse()` of ADR-024 today; the ADR-018 cell/window model when PR #60
 * lands) and branded so a raw `{lat, lon}` — a precise fix — CANNOT be
 * assigned to it without passing that boundary. The brand is type-level only;
 * on the wire this is `{ lat, lon, cell? }`.
 */
export interface CoarsePublicLocation {
  readonly lat: number;
  readonly lon: number;
  /** Optional coarse-cell identifier (ADR-018); opaque to clients. */
  readonly cell?: string;
  readonly [CoarsePublicLocationBrand]: true;
}

/**
 * Distance to a PERSON is always a band, never a number (anti-triangulation:
 * exact person distance across repeated queries reconstructs position).
 */
export type DistanceBand = 'under500m' | 'under1km' | 'under2km' | 'under5km' | 'over5km';

/** Bounded query radius. Values above the ceiling are rejected server-side. */
export interface DiscoveryRadius {
  readonly km: number;
  /** True when the server widened the radius to find results — always disclosed. */
  readonly expanded?: boolean;
}

/* ------------------------------------------------------------------ *
 * Query
 * ------------------------------------------------------------------ */

/** What the user is looking for — the routed interpretation of their input. */
export type DiscoveryIntent =
  | { readonly kind: 'people' }
  | { readonly kind: 'username'; readonly handle: string }
  | { readonly kind: 'place'; readonly text: string }
  | { readonly kind: 'category'; readonly category: string; readonly openNow?: boolean }
  | { readonly kind: 'unavailable-domain'; readonly domain: 'exchange' | 'events' | 'moments' | 'assistant' };

/** Which result families a query wants. */
export type DiscoveryScope = 'people' | 'places' | 'usernames' | 'mixed';

/**
 * Filters — EXACTLY these three (mission amendment A3). There is deliberately
 * no age or gender filter and none may be added in this phase; D6/D7 are
 * owner-retained decisions.
 */
export interface DiscoveryFilters {
  readonly distanceBand?: DistanceBand;
  readonly category?: string;
  readonly openNow?: boolean;
}

/** Opaque, deterministic pagination cursor. Never parsed by clients. */
declare const SearchCursorBrand: unique symbol;
export type SearchCursor = string & { readonly [SearchCursorBrand]: true };

/** A discovery request as it crosses the client→server boundary. */
export interface DiscoveryQuery {
  readonly contractsVersion: DiscoveryContractsVersion;
  readonly intent: DiscoveryIntent;
  readonly scope: DiscoveryScope;
  /** Coarse origin ONLY — the branded type makes a precise fix unassignable. */
  readonly origin: CoarsePublicLocation;
  readonly radius: DiscoveryRadius;
  readonly filters?: DiscoveryFilters;
  readonly cursor?: SearchCursor | null;
}

/* ------------------------------------------------------------------ *
 * Freshness
 * ------------------------------------------------------------------ */

/** How fresh a datum is. ABSENT FIELDS MEAN UNKNOWN — never invented (P4). */
export interface FreshnessMetadata {
  /** ISO-8601 instant the underlying observation was made. */
  readonly observedAt?: string;
  /** ISO-8601 instant after which the datum must be treated as stale. */
  readonly expiresAt?: string;
  /** True when the server already considers this stale but still useful. */
  readonly stale?: boolean;
}

/* ------------------------------------------------------------------ *
 * Ranking — explainable or nothing (P5)
 * ------------------------------------------------------------------ */

/** One scored signal inside a ranking explanation. */
export interface RankingComponent {
  /** Registered signal name, e.g. 'proximity', 'freshness', 'textMatch'. */
  readonly signal: string;
  /** Configured weight (documented default; config value, never hardcoded). */
  readonly weight: number;
  /** Normalized signal value in [0,1] as evidenced — never invented. */
  readonly value: number;
  /** weight × value, the contribution to the total. */
  readonly weighted: number;
  /** Human-auditable reason ("within 500 m band", "exact handle match"). */
  readonly reason: string;
}

/** The machine-readable explanation REQUIRED on every ranked result. */
export interface RankingBreakdown {
  readonly total: number;
  readonly components: readonly RankingComponent[];
  /** Signals that existed but were omitted (no evidence / not authorized). */
  readonly omittedSignals: readonly string[];
  /** Ranker's confidence in [0,1] given the available evidence. */
  readonly confidence: number;
  /** Which engine produced this ('deterministic-baseline' this phase). */
  readonly source: string;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

/** Where a result came from — attributed on every result (P4/P9). */
export type ResultSource =
  | { readonly kind: 'spotme-people' }
  | { readonly kind: 'spotme-usernames' }
  | { readonly kind: 'search-index'; readonly engine: 'typesense' }
  | { readonly kind: 'place-provider'; readonly provider: string; readonly attribution: string };

/** D9 (dark build): the ONLY communication affordance on a person result. */
export interface FriendRequestCapability {
  readonly canSendRequest: boolean;
  readonly state: 'none' | 'pending-sent' | 'pending-received' | 'accepted';
  /** Chat opens ONLY when state === 'accepted' (P7). Never a room id here. */
}

/** Safety affordances present on every person result. */
export interface BlockReportCapability {
  readonly canBlock: boolean;
  readonly canReport: boolean;
  readonly canHide: boolean;
}

/**
 * A nearby person, as the PUBLIC may see them. Only approved public fields;
 * no precise location, no exact distance, no contact handle, no sensitive
 * attribute (P6). Presence carries the coarse public location ONLY when the
 * person's visibility preference allows it.
 */
export interface NearbyPersonPublic {
  readonly userId: string;
  /** D10: opt-in public handle; absent when the user has none. */
  readonly handle?: string;
  readonly displayName: string;
  readonly avatarRef?: string;
  readonly distanceBand: DistanceBand;
  readonly approxLocation?: CoarsePublicLocation;
  readonly freshness: FreshnessMetadata;
  readonly friendRequest: FriendRequestCapability;
  readonly safety: BlockReportCapability;
}

/** A nearby place from an authorized provider adapter. Unknown stays unknown. */
export interface NearbyPlacePublic {
  readonly placeId: string;
  readonly name: string;
  readonly category?: string;
  readonly approxLocation: CoarsePublicLocation;
  /** Metres, computed DEVICE-LOCALLY from the device's own fix — never asserted
   *  by the server; absent when the device has no fix. */
  readonly deviceDistanceM?: number;
  /** Open-now ONLY when the source supports it; absent = unknown (P4). */
  readonly openNow?: boolean;
  readonly source: ResultSource;
  readonly freshness: FreshnessMetadata;
}

/** Discriminated union of everything a discovery page can contain. */
export type DiscoveryResult =
  | { readonly type: 'person'; readonly person: NearbyPersonPublic; readonly ranking: RankingBreakdown }
  | { readonly type: 'place'; readonly place: NearbyPlacePublic; readonly ranking: RankingBreakdown }
  | { readonly type: 'username'; readonly person: NearbyPersonPublic; readonly exactMatch: boolean; readonly ranking: RankingBreakdown };

/** One page of results — the standard envelope (DPAS §10.2), cursor-paged. */
export interface DiscoveryResultPage {
  readonly contractsVersion: DiscoveryContractsVersion;
  readonly results: readonly DiscoveryResult[];
  readonly radius: DiscoveryRadius;
  readonly cursor: SearchCursor | null;
  /** NO total-result count — deliberately absent (anti-enumeration control). */
  readonly freshness: FreshnessMetadata;
}

/* ------------------------------------------------------------------ *
 * UI / flow states — discriminated, exhaustive (mission UX §11)
 * ------------------------------------------------------------------ */

export type DiscoveryState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'locating' }
  | { readonly kind: 'permission-required' }
  | { readonly kind: 'location-unavailable'; readonly reason: string }
  | { readonly kind: 'searching'; readonly query: DiscoveryQuery }
  | { readonly kind: 'partial'; readonly page: DiscoveryResultPage; readonly pendingSources: readonly string[] }
  | { readonly kind: 'ready'; readonly page: DiscoveryResultPage }
  | { readonly kind: 'empty'; readonly radius: DiscoveryRadius; readonly suggestion?: string }
  | { readonly kind: 'provider-unavailable'; readonly providers: readonly string[]; readonly page?: DiscoveryResultPage }
  | { readonly kind: 'offline'; readonly cached?: DiscoveryResultPage }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'failed'; readonly error: DiscoveryError };

/** Normalized error — what happened and what the user can do next (UX §12). */
export interface DiscoveryError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly nextStep: string;
}

/* ------------------------------------------------------------------ *
 * Visibility (P3)
 * ------------------------------------------------------------------ */

/** The user's own discovery-visibility preference — opt-in, reversible. */
export interface VisibilityPreference {
  readonly enabled: boolean;
  /** ISO-8601: visibility auto-expires; renewing is an explicit user act. */
  readonly expiresAt?: string;
  /** Monotonic version so realtime consumers can drop stale updates. */
  readonly visibilityVersion: number;
  readonly updatedAt: string;
}
