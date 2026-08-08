/**
 * Exchange server types (Platform Phase 3B) — the server mirror of the
 * `@spotme/contracts` Exchange v1 set. DARK: this module is not imported by
 * AppModule. Locations are coarse-only; no precise coordinate exists here.
 */

export const EXCHANGE_CONTRACTS_VERSION = 1 as const;

export type ExchangeIntentKind = 'need' | 'offer' | 'service';

export type ExchangeIntentStatus =
  | 'draft' | 'active' | 'paused' | 'matched' | 'fulfilled' | 'expired' | 'withdrawn' | 'removed';

export type ExchangeVisibility = 'hidden' | 'discoverable';
export type ExchangeModerationState = 'clear' | 'pending-review' | 'restricted' | 'removed';
export type ExchangeBudgetBand = 'low' | 'medium' | 'high';

/** Validated create/update input, already coarsened + bounded by the policy. */
export interface ValidatedExchangeIntentInput {
  ownerId: string;
  ownerKind: 'user' | 'business';
  kind: ExchangeIntentKind;
  category: string;
  title: string;
  text: string;
  tags: string[];
  budgetBand?: ExchangeBudgetBand;
  informationalPrice?: string;
  availabilityState: 'window' | 'recurring' | 'unknown';
  availabilityFrom?: Date;
  availabilityTo?: Date;
  availabilitySchedule?: string;
  coarseLat: number;
  coarseLon: number;
  coarseCell: string;
  radiusKm: number;
  maxRadiusKm: number;
  visibility: ExchangeVisibility;
  idempotencyKey: string;
  expiresAt: Date | null;
}

/** A row as the repository returns it (internal). */
export interface ExchangeIntentRow {
  id: string;
  ownerId: string;
  ownerKind: string;
  kind: string;
  status: string;
  category: string;
  title: string;
  text: string;
  tags: string[];
  budgetBand: string | null;
  informationalPrice: string | null;
  availabilityState: string;
  availabilityFrom: Date | null;
  availabilityTo: Date | null;
  availabilitySchedule: string | null;
  coarseLat: number;
  coarseLon: number;
  coarseCell: string;
  radiusKm: number;
  maxRadiusKm: number;
  visibility: string;
  moderationState: string;
  versionSeq: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
  /** SERVER-SIDE ONLY: raw distance in metres, present only on rows from a
   *  geo-filtered browse. Banded by the service; NEVER projected publicly. */
  distanceM?: number;
}

/** Public projection — no owner id beyond a reference, no precise fields. */
export interface ExchangeIntentPublic {
  contractsVersion: typeof EXCHANGE_CONTRACTS_VERSION;
  id: string;
  owner: { kind: 'user' | 'business'; id: string };
  kind: ExchangeIntentKind;
  status: ExchangeIntentStatus;
  category: string;
  title: string;
  text: string;
  tags: string[];
  budgetBand?: ExchangeBudgetBand;
  informationalPrice?: { label: string; disclaimer: 'informational-only-no-payment' };
  availability:
    | { state: 'window'; fromIso: string; toIso: string }
    | { state: 'recurring'; scheduleLabel: string }
    | { state: 'unknown' };
  approxLocation: { lat: number; lon: number; cell: string };
  radius: { km: number; maxKm: number };
  visibility: ExchangeVisibility;
  moderation: ExchangeModerationState;
  version: { seq: number };
  createdAtIso: string;
  updatedAtIso: string;
  expiresAtIso: string | null;
  /** Distance BAND to the viewer — present only on geo-scoped browse results.
   *  A band, never metres (the same registry exchange.matching.ts uses). */
  distanceBand?: 'under500m' | 'under1km' | 'under2km' | 'under5km' | 'over5km';
}

/** Keyset cursor internals (opaque + signed on the wire). */
export interface ExchangeDecodedCursor {
  /** Last row's createdAt epoch ms (recency keyset). */
  t: number;
  /** Last row's id — deterministic tie-breaker. */
  i: string;
  /** Page depth reached — enumeration bound. */
  depth: number;
}
