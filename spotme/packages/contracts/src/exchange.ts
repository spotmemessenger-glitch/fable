/**
 * Spot Me Exchange — intent contracts.
 *
 * Mirrors the Exchange PRD request/response shapes and database model
 * (`spotme/docs/handbook/product/exchange/08-API-CONTRACTS.md §8.3`,
 * `09-DATABASE-SCHEMA.md`). Types only. No endpoint, no persistence, no
 * behaviour — those remain Planned until the PRD is ratified.
 *
 * Privacy invariant carried by these types: no shape here exposes a precise
 * location. An item carries an already-coarsened {@link CoarseLocation}; the
 * precise fix never leaves the device (PRD §07, ADR-018).
 */

import type {
  CoarseLocation,
  LocationPrecision,
  RadiusKm,
} from './location.ts';
import type { CoarsePublicLocation, DistanceBand } from './discovery.ts';

/** An Exchange item is either a need or an offer. */
export type ItemType = 'need' | 'offer';

/** Lifecycle of an Exchange item (schema `ItemStatus`). */
export type ItemStatus =
  | 'draft'
  | 'active'
  | 'matched'
  | 'engaged'
  | 'paused'
  | 'resolved'
  | 'expired'
  | 'closed'
  | 'removed';

/** Budget is banded, never an exact amount (schema `BudgetBand`). */
export type BudgetBand = 'low' | 'medium' | 'high';

/** Lifecycle of a proposed match (schema `MatchStatus`). */
export type MatchStatus =
  | 'proposed'
  | 'viewed'
  | 'accepted'
  | 'declined'
  | 'dismissed'
  | 'superseded'
  | 'expired';

/** An ISO-8601 window. Either bound may be absent. */
export interface Timeframe {
  readonly from?: string;
  readonly to?: string;
}

/**
 * `POST /v1/exchange/items` input (PRD §8.3). `approxLocation` is ALREADY
 * coarsened on-device; there is no precise-coordinate field by construction.
 */
export interface ExchangeItemInput {
  readonly type: ItemType;
  readonly category: string;
  readonly title?: string;
  readonly text: string;
  readonly tags?: readonly string[];
  readonly budgetBand?: BudgetBand;
  readonly timeframe?: Timeframe;
  readonly radiusKm: RadiusKm;
  readonly locationPrecision: LocationPrecision;
  readonly approxLocation: CoarseLocation;
  readonly expiresInHours?: number;
}

/**
 * A structured intent — the normalized output of an IntentPort `parse(text)`
 * (PRD §8.5). Provider-neutral; no provider field rides along.
 */
export interface StructuredIntent {
  readonly type: ItemType;
  readonly category: string;
  readonly keywords: readonly string[];
  readonly timeframe?: Timeframe;
  readonly budgetBand?: BudgetBand;
  /** Confidence in [0, 1] the baseline/provider assigns to this parse. */
  readonly confidence: number;
}

/** The public projection of an item: never another user's identity or precise fix. */
export interface ExchangeItemPublic {
  readonly id: string;
  readonly type: ItemType;
  readonly status: ItemStatus;
  readonly category: string;
  readonly title?: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly budgetBand?: BudgetBand;
  readonly timeframe?: Timeframe;
  readonly location: {
    readonly precision: LocationPrecision;
    readonly approx: CoarseLocation;
  };
  readonly createdAt: string;
  readonly expiresAt?: string;
}

/** A match with its explainable rationale (PRD §04). */
export interface Match {
  readonly id: string;
  readonly needId: string;
  readonly offerId: string;
  readonly status: MatchStatus;
  readonly score: number;
  readonly rankReason: Readonly<Record<string, number>>;
  readonly epoch: number;
  readonly createdAt: string;
}

/** The state envelope every Exchange search returns (PRD §8.3). */
export type SearchState = 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';

/** `POST /v1/exchange/search` input (PRD §8.3). Origin is a coarse point. */
export interface ExchangeSearchInput {
  readonly text: string;
  readonly type: ItemType;
  readonly origin: CoarseLocation;
  readonly filters?: Readonly<Record<string, string | number | boolean>>;
  readonly cursor?: string | null;
}

/** `POST /v1/exchange/search` result envelope. */
export interface ExchangeSearchResult {
  readonly state: SearchState;
  readonly results: readonly ExchangeItemPublic[];
  readonly radiusKm: RadiusKm;
  readonly cursor?: string | null;
}

/* ==========================================================================
 * PLATFORM PHASE 3 — versioned Exchange contracts (DARK)
 *
 * The authoritative, framework-neutral contract set for the SpotMe Exchange
 * dark foundation. Built ON the Phase 2 chain: locations are the BRANDED
 * `CoarsePublicLocation` from the discovery contracts, so a raw {lat,lon} is
 * unassignable by type (privacy by construction, not by convention). The
 * pre-Phase-3 beachhead types above remain for the inert web-next screen.
 *
 * Derived from the Exchange PRD (handbook/product/exchange, pending A5). Every
 * [PROPOSED]/pending-A5 numeric default stays a documented config seam — none
 * is hardcoded here, and nothing converts open product policy into an approved
 * decision. No payment/escrow/checkout contract exists. No age/gender/
 * sensitive-trait field exists in any shape (A3). Contact follows explicit
 * acceptance — no shape opens a chat implicitly.
 * ========================================================================== */

export const EXCHANGE_CONTRACTS_VERSION = 1 as const;
export type ExchangeContractsVersion = typeof EXCHANGE_CONTRACTS_VERSION;

/** Canonical identity stays authoritative (user/business services). A REFERENCE
 *  only — Exchange owns no identity uniqueness/ownership/lifecycle. */
export interface ExchangeOwnerRef {
  readonly kind: 'user' | 'business';
  readonly id: string;
}

export type ExchangeIntentKind = 'need' | 'offer' | 'service';

/** The eight canonical lifecycle states (mission). */
export type ExchangeIntentStatus =
  | 'draft' | 'active' | 'paused' | 'matched' | 'fulfilled' | 'expired' | 'withdrawn' | 'removed';

export type ExchangeVisibility = 'hidden' | 'discoverable';

/** Explicit unknown semantics — absence of evidence is 'unknown', never a
 *  fabricated availability. */
export type ExchangeAvailability =
  | { readonly state: 'window'; readonly fromIso: string; readonly toIso: string }
  | { readonly state: 'recurring'; readonly scheduleLabel: string }
  | { readonly state: 'unknown' };

/** Radius policy — expansion is DISCLOSED (mirrors Discovery). Numeric defaults
 *  are [PROPOSED] config, not constants. */
export interface ExchangeRadiusPolicy {
  readonly km: number;
  readonly maxKm: number;
  readonly expanded?: true;
}

/** Display-only price label; structurally NOT a payment object. */
export interface ExchangeInformationalPrice {
  readonly label: string;
  readonly disclaimer: 'informational-only-no-payment';
}

/** Optimistic concurrency + idempotent mutations. */
export interface ExchangeVersion {
  readonly seq: number;
  readonly idempotencyKey: string;
}

export type ExchangeModerationState = 'clear' | 'pending-review' | 'restricted' | 'removed';

export interface ExchangeIntentBase {
  readonly contractsVersion: ExchangeContractsVersion;
  readonly id: string;
  readonly owner: ExchangeOwnerRef;
  readonly status: ExchangeIntentStatus;
  readonly category: string;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
  readonly budgetBand?: BudgetBand;
  readonly informationalPrice?: ExchangeInformationalPrice;
  readonly availability: ExchangeAvailability;
  /** Approximate ONLY — branded; coarsened on-device before it can exist here. */
  readonly approxLocation: CoarsePublicLocation;
  readonly radius: ExchangeRadiusPolicy;
  readonly visibility: ExchangeVisibility;
  readonly moderation: ExchangeModerationState;
  readonly version: ExchangeVersion;
  readonly createdAtIso: string;
  readonly updatedAtIso: string;
  readonly expiresAtIso: string | null;
}

export interface ExchangeNeed extends ExchangeIntentBase { readonly kind: 'need'; }
export interface ExchangeOffer extends ExchangeIntentBase { readonly kind: 'offer'; }
export interface ExchangeService extends ExchangeIntentBase { readonly kind: 'service'; }
export type ExchangeIntent = ExchangeNeed | ExchangeOffer | ExchangeService;

export interface ExchangeLifecycleEvent {
  readonly intentId: string;
  readonly from: ExchangeIntentStatus;
  readonly to: ExchangeIntentStatus;
  readonly atIso: string;
  readonly by: ExchangeOwnerRef | { readonly kind: 'moderation' } | { readonly kind: 'system-expiry' };
  /** Closed reason codes — free text never enters the audit stream. */
  readonly reasonCode?: 'owner-action' | 'ttl' | 'moderation-removed' | 'fulfilled-confirmed' | 'superseded';
}

export type ExchangeMatchStatus =
  | 'proposed' | 'viewed' | 'accepted' | 'declined' | 'dismissed' | 'superseded' | 'expired';

/** Closed signal registry (mirrors the Discovery ranking discipline). Weights
 *  are runtime config with [PROPOSED] defaults (PRD §4.4); the SHAPE — weighted
 *  sum + full breakdown + safety hard gate — is contract. */
export type ExchangeMatchSignal = 'intentFit' | 'proximity' | 'availability' | 'trust' | 'freshness';

export interface ExchangeMatchExplanation {
  readonly components: readonly {
    readonly signal: ExchangeMatchSignal;
    readonly weight: number;
    readonly value: number;   // [0,1]; unknown evidence contributes 0
    readonly weighted: number;
  }[];
  readonly total: number;     // equals the sum of weighted (tested)
  readonly omittedSignals: readonly ExchangeMatchSignal[];
  /** An ineligible match is UNREPRESENTABLE — the literal true makes the safety
   *  gate a type property, not a runtime hope. */
  readonly safetyEligible: true;
}

export interface ExchangeMatch {
  readonly contractsVersion: ExchangeContractsVersion;
  readonly id: string;
  readonly needId: string;
  readonly offerId: string;
  readonly status: ExchangeMatchStatus;
  readonly score: number;
  readonly explanation: ExchangeMatchExplanation;
  readonly epoch: number;     // supersede guard
  /** Distance is a BAND — never metres between two parties. */
  readonly distanceBand: DistanceBand;
  readonly proposedAtIso: string;
}

/** Derived, non-sensitive, first-party only. */
export interface ExchangeReputationSummary {
  readonly subject: ExchangeOwnerRef;
  readonly completedCount: number;
  readonly verified: boolean;
  readonly score01: number;   // [0,1] derived; never purchasable
}

export interface ExchangeBusinessPublic {
  readonly businessId: string;
  readonly displayName: string;
  readonly verified: boolean;
  readonly categoryLabels: readonly string[];
  readonly attribution: string;
  readonly approxLocation: CoarsePublicLocation | null;
}

export interface ExchangeSearchQuery {
  readonly contractsVersion: ExchangeContractsVersion;
  readonly text?: string;
  readonly kind?: ExchangeIntentKind;
  readonly origin: CoarsePublicLocation;
  readonly radius: ExchangeRadiusPolicy;
  /** Allowed filters ONLY: category / availability / distance band. */
  readonly filters?: {
    readonly category?: string;
    readonly distanceBand?: DistanceBand;
    readonly availableNow?: boolean;
  };
  readonly cursor: ExchangeCursor | null;
}

declare const ExchangeCursorBrand: unique symbol;
/** Opaque keyset cursor — undecodable and unforgeable by type. */
export type ExchangeCursor = string & { readonly [ExchangeCursorBrand]: true };

/** NO total count anywhere enumeration risk exists. */
export interface ExchangePage<T> {
  readonly contractsVersion: ExchangeContractsVersion;
  readonly results: readonly T[];
  readonly cursor: ExchangeCursor | null;
  readonly state: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';
}

/** Consent-gated communication: chat capability exists ONLY after explicit
 *  acceptance; nothing here opens a conversation implicitly. */
export interface ExchangeContactCapability {
  readonly canRequestContact: boolean;
  readonly state: 'none' | 'requested' | 'accepted' | 'declined';
  readonly requiresExplicitConsent: true;
}
