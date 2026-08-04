/**
 * AI Interactive Map server types (Platform Phase 6B) — the server mirror of
 * the `@spotme/contracts` Assistant v1 set, plus the RUNTIME closed registries
 * the types-only contracts package cannot carry. DARK: this module is not
 * imported by AppModule. Deterministic-only: no AI SDK, model, endpoint, or
 * env var exists anywhere in this subtree (X10).
 */

export const ASSISTANT_CONTRACTS_VERSION = 1 as const;

export type NonEmptyArray<T> = readonly [T, ...T[]];

/* ---------------- Evidence (X2) ---------------- */

/** CLOSED license classes — 'scraped'/'unknown' are NOT members; the boundary
 *  THROWS on any non-member (X2, DPAS 05 §5.8, D11a FIXED). */
export type EvidenceLicenseClass =
  | 'first-party'
  | 'authorized-provider'
  | 'licensed-provider'
  | 'owner-supplied'
  | 'consented-community'
  | 'fixture';

export const EVIDENCE_LICENSE_CLASSES: readonly EvidenceLicenseClass[] = [
  'first-party', 'authorized-provider', 'licensed-provider',
  'owner-supplied', 'consented-community', 'fixture',
];

export type FreshnessState = 'current' | 'stale' | 'superseded' | 'unknown';

export type EvidenceCategory =
  | 'place-name'
  | 'place-hours'
  | 'place-review'
  | 'person-presence'
  | 'event-schedule'
  | 'exchange-listing'
  | 'username'
  | 'route-leg'
  | 'road-condition';

export const EVIDENCE_CATEGORIES: readonly EvidenceCategory[] = [
  'place-name', 'place-hours', 'place-review', 'person-presence',
  'event-schedule', 'exchange-listing', 'username', 'route-leg', 'road-condition',
];

/** Claim categories asserting CURRENT state — stale/superseded/unknown
 *  evidence can never support these (X4). */
export const CURRENT_STATE_CATEGORIES: ReadonlySet<EvidenceCategory> = new Set([
  'place-hours', 'event-schedule', 'route-leg', 'road-condition', 'person-presence',
]);

export type EvidencePermittedUse = 'display-with-attribution' | 'aggregate-only' | 'internal-eval';

export const EVIDENCE_PERMITTED_USES: readonly EvidencePermittedUse[] = [
  'display-with-attribution', 'aggregate-only', 'internal-eval',
];

export type EvidenceSourceType =
  | 'domain-projection' | 'provider-feed' | 'owner-content' | 'community-consented' | 'fixture';

export const EVIDENCE_SOURCE_TYPES: readonly EvidenceSourceType[] = [
  'domain-projection', 'provider-feed', 'owner-content', 'community-consented', 'fixture',
];

export interface EvidenceRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceType: EvidenceSourceType;
  readonly licenseClass: EvidenceLicenseClass;
  readonly category: EvidenceCategory;
  readonly retrievedAtUTC: number;
  readonly sourceUpdatedAtUTC: number | null;
  readonly freshness: FreshnessState;
  readonly contentRef: string;
  readonly integrityDigest: string;
  readonly attributionLabel: string;
  readonly permittedUse: EvidencePermittedUse;
}

/* ---------------- Claims (X1, X5) ---------------- */

export type ClaimEvidenceStatus = 'supported' | 'mixed';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface ClaimConfidence {
  readonly level: ConfidenceLevel;
  readonly basis: {
    readonly sourceDiversity: number;
    readonly freshness: FreshnessState;
    readonly density: number;
  };
}

export interface CitedClaim {
  readonly id: string;
  readonly text: string;
  readonly category: EvidenceCategory;
  readonly citationIds: NonEmptyArray<string>;
  readonly confidence: ClaimConfidence;
  readonly evidenceStatus: ClaimEvidenceStatus;
}

export interface CitedSummary {
  readonly claims: NonEmptyArray<CitedClaim>;
  readonly sources: NonEmptyArray<EvidenceRecord>;
}

/* ---------------- Domains & darkness (X8) ---------------- */

export type AssistantDomain = 'people' | 'places' | 'events' | 'exchange' | 'username';

export const ASSISTANT_DOMAINS: readonly AssistantDomain[] = [
  'people', 'places', 'events', 'exchange', 'username',
];

export type DomainAvailability = 'implemented-dark' | 'activated' | 'unavailable' | 'unsupported';

export type DomainDarknessRegistry = Readonly<Record<AssistantDomain, DomainAvailability>>;

/* ---------------- Query & answer ---------------- */

export type SensitiveQueryCategory = 'health' | 'crisis' | 'legal' | 'financial' | 'none';

export const SENSITIVE_QUERY_CATEGORIES: readonly SensitiveQueryCategory[] = [
  'health', 'crisis', 'legal', 'financial', 'none',
];

export type AssistantAnswer =
  | { readonly kind: 'results'; readonly domain: AssistantDomain; readonly summary: CitedSummary }
  | { readonly kind: 'insufficient-evidence'; readonly domain: AssistantDomain; readonly reason: 'no-evidence' | 'all-evidence-stale' | 'conflicting-evidence-only' }
  | { readonly kind: 'domain-not-active'; readonly domain: AssistantDomain }
  | { readonly kind: 'unavailable'; readonly reason: 'provider-unconfigured' | 'error' };

/* ---------------- Review facets (X5) ---------------- */

export type ReviewFacetState = 'supported' | 'mixed' | 'insufficient-evidence' | 'not-applicable';

export interface ReviewFacet {
  readonly field: string;
  readonly state: ReviewFacetState;
  readonly claims: readonly CitedClaim[];
}

export interface ReviewIntelligence {
  readonly subjectRef: string;
  readonly facets: NonEmptyArray<ReviewFacet>;
  readonly sources: NonEmptyArray<EvidenceRecord>;
}

/* ---------------- Route advice (X6) ---------------- */

/** Server-side coarse origin — the already-coarsened public projection
 *  (device-local coarsening boundary, Phase 2E discipline). Never a fix. */
export interface CoarseOriginInput {
  readonly lat: number;
  readonly lon: number;
}

export type RouteOrigin =
  | { readonly kind: 'coarse'; readonly origin: CoarseOriginInput }
  | { readonly kind: 'place-ref'; readonly placeRefId: string };

export interface RouteLeg {
  readonly mode: 'walk' | 'drive' | 'transit';
  readonly providerDistanceM: number | null;
  readonly providerDurationS: number | null;
  readonly attribution: string;
  readonly citationId: string;
}

export interface StraightLineEstimate {
  readonly label: 'straight-line estimate';
  readonly distanceM: number;
}

export type RouteAdvice =
  | { readonly kind: 'provider-route'; readonly origin: RouteOrigin; readonly legs: NonEmptyArray<RouteLeg>; readonly sources: NonEmptyArray<EvidenceRecord> }
  | { readonly kind: 'straight-line'; readonly origin: RouteOrigin; readonly estimate: StraightLineEstimate }
  | { readonly kind: 'unavailable'; readonly reason: 'provider-unconfigured' | 'error' };
