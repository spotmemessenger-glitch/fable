/**
 * AI Interactive Map — assistant contracts (Platform Phase 6, group 6A, DARK).
 *
 * The fifth and final Discovery layer, under the X1–X12 corrections. The core
 * design move: THERE IS NO PROSE ANSWER PATH. An assistant answer is a
 * discriminated union whose only content-bearing variant carries a
 * {@link CitedSummary} — typed claims, each with a NON-EMPTY citation list into
 * the same envelope's evidence. Fabrication is unrepresentable: a claim without
 * citations, an unknown license class, a generated star rating, or a precise
 * coordinate on evidence is a compile error here and a runtime throw in 6B.
 *
 * Deterministic-only this phase (owner-retained: LLM provider choice). No AI
 * SDK, model, or endpoint exists anywhere in this tree.
 */

import type { CoarsePublicLocation } from './discovery.ts';

export const ASSISTANT_CONTRACTS_VERSION = 1 as const;
export type AssistantContractsVersion = typeof ASSISTANT_CONTRACTS_VERSION;

/** A non-empty readonly array — the citation fail-closed primitive (X1). */
export type NonEmptyArray<T> = readonly [T, ...T[]];

/* ------------------------------------------------------------------ *
 * Evidence (X2)
 * ------------------------------------------------------------------ */

declare const EvidenceRecordIdBrand: unique symbol;
/** Immutable evidence id — minted at ingestion, never relabeled (X3). */
export type EvidenceRecordId = string & { readonly [EvidenceRecordIdBrand]: true };

/**
 * CLOSED license classes (X2). 'scraped'/'unknown' are NOT members — the 6B
 * boundary additionally THROWS on any non-member (DPAS 05 §5.8, D11a FIXED).
 */
export type EvidenceLicenseClass =
  | 'first-party'
  | 'authorized-provider'
  | 'licensed-provider'
  | 'owner-supplied'
  | 'consented-community'
  | 'fixture';

/** Freshness (X4). */
export type FreshnessState = 'current' | 'stale' | 'superseded' | 'unknown';

/**
 * Evidence categories — citations must MATCH claim category (X3): a
 * `place-name` record cannot support an hours or ETA claim. Closed.
 */
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

/** Claim categories whose text asserts CURRENT state — stale/unknown evidence
 *  can never support these (X4). */
export type CurrentStateCategory = Extract<
  EvidenceCategory,
  'place-hours' | 'event-schedule' | 'route-leg' | 'road-condition' | 'person-presence'
>;

/** Permitted-use scope carried on every record (X2). Closed. */
export type EvidencePermittedUse = 'display-with-attribution' | 'aggregate-only' | 'internal-eval';

/**
 * The evidence record (X2). Deliberately ABSENT: raw provider payloads,
 * credentials, precise coordinates, HTML, executable content, provider
 * prompts/instructions — those fields do not exist on this shape, and the 6B
 * boundary refuses inputs carrying them.
 */
export interface EvidenceRecord {
  readonly id: EvidenceRecordId;
  readonly sourceId: string;
  readonly sourceType: 'domain-projection' | 'provider-feed' | 'owner-content' | 'community-consented' | 'fixture';
  readonly licenseClass: EvidenceLicenseClass;
  readonly category: EvidenceCategory;
  readonly retrievedAtUTC: number;
  readonly sourceUpdatedAtUTC: number | null;
  readonly freshness: FreshnessState;
  /** Opaque reference to sanitized content — never raw payload/HTML. */
  readonly contentRef: string;
  /** Integrity digest of the sanitized content (sha256, hex). */
  readonly integrityDigest: string;
  /** Attribution label shown in the UI — from the record, never prose (X3). */
  readonly attributionLabel: string;
  readonly permittedUse: EvidencePermittedUse;
}

/* ------------------------------------------------------------------ *
 * Claims & summaries (X1)
 * ------------------------------------------------------------------ */

export type ClaimEvidenceStatus = 'supported' | 'mixed';
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Confidence basis (X5): diversity + freshness + density — never raw count. */
export interface ClaimConfidence {
  readonly level: ConfidenceLevel;
  readonly basis: {
    readonly sourceDiversity: number;
    readonly freshness: FreshnessState;
    readonly density: number;
  };
}

/** A typed claim (X1). `citationIds` is NON-EMPTY by type — an uncited claim
 *  cannot be constructed. */
export interface CitedClaim {
  readonly id: string;
  readonly text: string;
  readonly category: EvidenceCategory;
  readonly citationIds: NonEmptyArray<EvidenceRecordId>;
  readonly confidence: ClaimConfidence;
  readonly evidenceStatus: ClaimEvidenceStatus;
}

/** The only content-bearing answer body (X1): claims + their sources, both
 *  non-empty, citations resolving WITHIN this envelope only (X3). */
export interface CitedSummary {
  readonly claims: NonEmptyArray<CitedClaim>;
  readonly sources: NonEmptyArray<EvidenceRecord>;
}

/* ------------------------------------------------------------------ *
 * Domains & darkness (X8)
 * ------------------------------------------------------------------ */

export type AssistantDomain = 'people' | 'places' | 'events' | 'exchange' | 'username';

export type DomainAvailability = 'implemented-dark' | 'activated' | 'unavailable' | 'unsupported';

export type DomainDarknessRegistry = Readonly<Record<AssistantDomain, DomainAvailability>>;

/* ------------------------------------------------------------------ *
 * Query & answer
 * ------------------------------------------------------------------ */

/** Reference to the merged Phase 1E VoicePort seam — a NAME, not an engine. */
export interface VoiceSeamRef {
  readonly seam: 'ai-gateway-voice-port';
  readonly state: 'disabled';
}

/**
 * An assistant query. Text only this phase (voice is the disabled seam).
 * The optional origin is the BRANDED coarse projection — never a device fix.
 * Query text is never persisted, logged, or hashed (X9).
 */
export interface AssistantQuery {
  readonly text: string;
  readonly origin?: CoarsePublicLocation;
  readonly voice?: VoiceSeamRef;
}

/** Closed sensitive-query categories (X9) — a CATEGORY is stored, never text. */
export type SensitiveQueryCategory = 'health' | 'crisis' | 'legal' | 'financial' | 'none';

/**
 * The answer — a DISCRIMINATED UNION with no prose variant (X1). Insufficient
 * evidence IS an answer kind; dark domains answer `domain-not-active` (X8).
 */
export type AssistantAnswer =
  | { readonly kind: 'results'; readonly domain: AssistantDomain; readonly summary: CitedSummary }
  | { readonly kind: 'insufficient-evidence'; readonly domain: AssistantDomain; readonly reason: 'no-evidence' | 'all-evidence-stale' | 'conflicting-evidence-only' }
  | { readonly kind: 'domain-not-active'; readonly domain: AssistantDomain }
  | { readonly kind: 'unavailable'; readonly reason: 'provider-unconfigured' | 'error' };

/* ------------------------------------------------------------------ *
 * Review facets (X5)
 * ------------------------------------------------------------------ */

export type ReviewFacetState = 'supported' | 'mixed' | 'insufficient-evidence' | 'not-applicable';

/**
 * A per-field review facet (X5). When `state` is 'mixed' the conflicting
 * claims BOTH remain visible. There is deliberately NO rating field of any
 * kind on this shape or its parent.
 */
export interface ReviewFacet {
  readonly field: string;
  readonly state: ReviewFacetState;
  /** Present (non-empty) iff state is supported|mixed; each claim is cited. */
  readonly claims: readonly CitedClaim[];
}

export interface ReviewIntelligence {
  readonly subjectRef: string;
  readonly facets: NonEmptyArray<ReviewFacet>;
  readonly sources: NonEmptyArray<EvidenceRecord>;
}

/* ------------------------------------------------------------------ *
 * Route advice (X6)
 * ------------------------------------------------------------------ */

/** A route origin: the branded coarse projection OR a user-chosen licensed
 *  place reference. A precise device origin is unrepresentable. */
export type RouteOrigin =
  | { readonly kind: 'coarse'; readonly origin: CoarsePublicLocation }
  | { readonly kind: 'place-ref'; readonly placeRefId: string };

/** A provider-supplied route leg — passed through ATTRIBUTED; nothing the
 *  provider didn't supply is computed (X6). */
export interface RouteLeg {
  readonly mode: 'walk' | 'drive' | 'transit';
  readonly providerDistanceM: number | null;
  readonly providerDurationS: number | null;
  readonly attribution: string;
  readonly citationId: EvidenceRecordId;
}

/** The straight-line fallback — ALWAYS labeled; never a route distance/ETA. */
export interface StraightLineEstimate {
  readonly label: 'straight-line estimate';
  readonly distanceM: number;
}

export type RouteAdvice =
  | { readonly kind: 'provider-route'; readonly origin: RouteOrigin; readonly legs: NonEmptyArray<RouteLeg>; readonly sources: NonEmptyArray<EvidenceRecord> }
  | { readonly kind: 'straight-line'; readonly origin: RouteOrigin; readonly estimate: StraightLineEstimate }
  | { readonly kind: 'unavailable'; readonly reason: 'provider-unconfigured' | 'error' };
