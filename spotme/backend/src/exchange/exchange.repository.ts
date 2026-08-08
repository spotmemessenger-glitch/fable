/**
 * Exchange repository ports (Phase 3B). The service composes these; the Prisma
 * implementations live in exchange.prisma.repository.ts. Keeping the port here
 * lets the lifecycle engine be unit-tested with in-memory fakes.
 */

import { ExchangeIntentRow, ValidatedExchangeIntentInput, ExchangeDecodedCursor } from './exchange.types';

export interface CreateIntentResult {
  row: ExchangeIntentRow;
  /** True when an existing row was returned for a repeated idempotency key. */
  idempotentReplay: boolean;
}

export interface NearbyIntentsQuery {
  principalId: string;
  kind?: 'need' | 'offer' | 'service';
  category?: string;
  /** Viewer's COARSE point (already 3-decimal grid) + radius. Absent ⇒ browse
   *  is unfiltered ("showing everywhere") — location is never a requirement. */
  origin?: { lat: number; lon: number };
  radiusKm?: number;
  limit: number;
  cursor: ExchangeDecodedCursor | null;
  now: Date;
}

export interface ExchangeIntentRepository {
  /** Idempotent create: a repeated (ownerId, idempotencyKey) returns the row. */
  createDraft(input: ValidatedExchangeIntentInput): Promise<CreateIntentResult>;
  findById(id: string): Promise<ExchangeIntentRow | null>;
  /** Optimistic-concurrency update of mutable fields; bumps versionSeq. Returns
   *  null if expectedVersion no longer matches (someone else moved it). */
  updateFields(id: string, expectedVersion: number, patch: Partial<ValidatedExchangeIntentInput>): Promise<ExchangeIntentRow | null>;
  /** Optimistic status transition + append a lifecycle event atomically. */
  transition(
    id: string,
    expectedVersion: number,
    to: string,
    by: 'owner' | 'moderation' | 'system-expiry',
    reasonCode: string | null,
  ): Promise<ExchangeIntentRow | null>;
  /** Discoverable, unexpired, non-removed intents near the principal, keyset-paged. */
  findDiscoverable(q: NearbyIntentsQuery): Promise<ExchangeIntentRow[]>;
  /** My own intents (any status), keyset-paged by recency. */
  findOwn(ownerId: string, limit: number, cursor: ExchangeDecodedCursor | null): Promise<ExchangeIntentRow[]>;
}

export const EXCHANGE_INTENT_REPOSITORY = Symbol('EXCHANGE_INTENT_REPOSITORY');
