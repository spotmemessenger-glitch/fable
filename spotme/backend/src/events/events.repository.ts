/**
 * Live Nearby Events — repository port (Phase 4B). The service depends on this
 * interface; the Prisma/PostGIS implementation binds it inside the dark module.
 */

import type { EventRow, NormalizedEvent, StatedEvent } from './events.types';
import type { EventDecodedCursor } from './events.cursor';
import type { EventDedupDecision } from './events.dedup';

export const EVENTS_REPOSITORY = Symbol('EVENTS_REPOSITORY');

/** A nearby browse query — origin is device-local and used only to bound the
 *  radius / compute a band; it is NEVER stored on a row. */
export interface NearbyEventsQuery {
  origin: { lat: number; lon: number };
  radiusKm: number;
  category?: string;
  now: number;
  limit: number;
  cursor: EventDecodedCursor | null;
}

/** The result of an upsert sweep: how many rows were written + dedup decisions. */
export interface UpsertResult {
  written: number;
  decisions: EventDedupDecision[];
}

export interface EventsRepository {
  /** Idempotently upsert a normalized+deduped batch, persist projections and
   *  dedup decisions, and set retention expiry. Returns counts + decisions. */
  upsertBatch(canonical: StatedEvent[], decisions: EventDedupDecision[], now: number): Promise<UpsertResult>;
  /** Nearby, live, canonical events in keyset order with a coarse distance band. */
  findNearby(q: NearbyEventsQuery): Promise<EventRow[]>;
  /** A single event by id (null if absent/expired). */
  findById(id: string): Promise<EventRow | null>;
  /** Sweep rows whose retention window has passed. Returns rows removed. */
  sweepExpired(now: number): Promise<number>;
  /** Read-through for a normalized event by id (internal). */
  getNormalized(id: string): Promise<NormalizedEvent | null>;
}
