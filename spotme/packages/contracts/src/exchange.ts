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
