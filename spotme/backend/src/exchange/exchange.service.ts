/**
 * Exchange service — the lifecycle engine (Phase 3B). Composition + rules only:
 * validate → repository → ownership/concurrency/transition checks → project to
 * the privacy-safe public shape → standard envelope. No SQL, no HTTP, no
 * matching (that is Phase 3C).
 *
 * Every mutation is OWNER-KEYED off the JWT principal (a non-owner gets a
 * uniform NOT_FOUND, never a distinct FORBIDDEN that would leak existence),
 * OPTIMISTICALLY CONCURRENT (a stale version conflicts), and IDEMPOTENT
 * (a repeated create key returns the same row). Status changes go through the
 * closed transition table and append a sanitized lifecycle event.
 */

import { Inject, Injectable } from '@nestjs/common';
import { ExchangeError } from './exchange.errors';
import { EXCHANGE_INTENT_REPOSITORY, ExchangeIntentRepository, NearbyIntentsQuery } from './exchange.repository';
import {
  EXCHANGE_CONTRACTS_VERSION,
  assertTransition,
  decodeCursor,
  encodeCursor,
  validateIntentInput,
  EXCHANGE_POLICY_DEFAULTS,
} from './exchange.policy';
import { ExchangeIntentPublic, ExchangeIntentRow, ExchangeIntentStatus } from './exchange.types';
import { bandFromMeters } from './exchange.matching';

interface Page {
  contractsVersion: typeof EXCHANGE_CONTRACTS_VERSION;
  results: ExchangeIntentPublic[];
  cursor: string | null;
  state: 'ok' | 'empty';
  /** Browse only: 'nearby' when a geo filter applied, 'everywhere' when the
   *  viewer sent no usable location — the client's honesty label. */
  scope?: 'nearby' | 'everywhere';
}

@Injectable()
export class ExchangeService {
  constructor(@Inject(EXCHANGE_INTENT_REPOSITORY) private readonly repo: ExchangeIntentRepository) {}

  /** Create a draft (idempotent per owner+key). */
  async createDraft(principalId: string, body: unknown, now = new Date()) {
    const input = validateIntentInput(principalId, body, now);
    const { row, idempotentReplay } = await this.repo.createDraft(input);
    return { ...this.project(row), idempotentReplay };
  }

  /** Owner edit of draft fields (optimistic concurrency). */
  async updateDraft(principalId: string, id: string, expectedVersion: number, body: unknown, now = new Date()) {
    const existing = await this.ownedOrNotFound(principalId, id);
    if (existing.status !== 'draft') {
      throw new ExchangeError('ILLEGAL_TRANSITION', 'only a draft may be edited; activate/pause/withdraw for a live intent', false, 'edit while in draft');
    }
    const input = validateIntentInput(principalId, body, now);
    const updated = await this.repo.updateFields(id, expectedVersion, input);
    if (!updated) throw this.versionConflict();
    return this.project(updated);
  }

  /** Status transitions — each validates ownership + version + legality. */
  activate(p: string, id: string, v: number) { return this.move(p, id, v, 'active'); }
  pause(p: string, id: string, v: number) { return this.move(p, id, v, 'paused'); }
  resume(p: string, id: string, v: number) { return this.move(p, id, v, 'active'); }
  withdraw(p: string, id: string, v: number) { return this.move(p, id, v, 'withdrawn'); }
  markFulfilled(p: string, id: string, v: number) { return this.move(p, id, v, 'fulfilled', 'fulfilled-confirmed'); }

  private async move(principalId: string, id: string, expectedVersion: number, to: ExchangeIntentStatus, reasonCode: string | null = 'owner-action') {
    const existing = await this.ownedOrNotFound(principalId, id);
    assertTransition(existing.status as ExchangeIntentStatus, to);
    const updated = await this.repo.transition(id, expectedVersion, to, 'owner', reasonCode);
    if (!updated) throw this.versionConflict();
    return this.project(updated);
  }

  async getOwn(principalId: string, id: string) {
    return this.project(await this.ownedOrNotFound(principalId, id));
  }

  async listOwn(principalId: string, rawCursor: string | null): Promise<Page> {
    const cursor = rawCursor ? decodeCursor(rawCursor) : null;
    this.assertDepth(cursor?.depth ?? 0);
    const rows = await this.repo.findOwn(principalId, EXCHANGE_POLICY_DEFAULTS.defaultPageSize + 1, cursor);
    return this.page(rows, cursor?.depth ?? 0);
  }

  async browse(
    principalId: string,
    opts: { kind?: 'need' | 'offer' | 'service'; category?: string; cursor?: string | null; lat?: number; lon?: number; radiusKm?: number },
    now = new Date(),
  ): Promise<Page> {
    const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
    this.assertDepth(cursor?.depth ?? 0);
    /* GEO SCOPE IS OPTIONAL AND FAIL-OPEN. A missing/denied/garbled location
     * NEVER breaks browse — it degrades to the unfiltered global list, which
     * the response labels via `scope` so the client can say "showing
     * everywhere" instead of implying nearby. The viewer point is re-quantized
     * to the same 3-decimal grid the policy applies to stored intents — no
     * finer input is honoured even if sent. */
    const grid = 10 ** EXCHANGE_POLICY_DEFAULTS.coarseGridDecimals;
    const hasPoint = typeof opts.lat === 'number' && Number.isFinite(opts.lat)
      && typeof opts.lon === 'number' && Number.isFinite(opts.lon)
      && opts.lat >= -90 && opts.lat <= 90 && opts.lon >= -180 && opts.lon <= 180;
    const origin = hasPoint
      ? { lat: Math.round((opts.lat as number) * grid) / grid, lon: Math.round((opts.lon as number) * grid) / grid }
      : undefined;
    const radiusKm = origin
      ? Math.min(Math.max(Number.isFinite(opts.radiusKm as number) && (opts.radiusKm as number) > 0 ? (opts.radiusKm as number) : 5, 1), EXCHANGE_POLICY_DEFAULTS.maxRadiusKm)
      : undefined;
    const q: NearbyIntentsQuery = {
      principalId, kind: opts.kind, category: opts.category, origin, radiusKm,
      limit: EXCHANGE_POLICY_DEFAULTS.defaultPageSize + 1, cursor, now,
    };
    const rows = await this.repo.findDiscoverable(q);
    return { ...this.page(rows, cursor?.depth ?? 0), scope: origin ? 'nearby' : 'everywhere' };
  }

  /* ---- internals ---- */

  private async ownedOrNotFound(principalId: string, id: string): Promise<ExchangeIntentRow> {
    const row = await this.repo.findById(id);
    // Uniform absence: a non-owner (or missing/removed) is NOT_FOUND, never a
    // distinct FORBIDDEN that would confirm the intent exists.
    if (!row || row.ownerId !== principalId || row.status === 'removed') {
      throw new ExchangeError('NOT_FOUND', 'no such intent', false, 'check the id; it may have been withdrawn or removed');
    }
    return row;
  }

  private assertDepth(depth: number): void {
    if (depth >= EXCHANGE_POLICY_DEFAULTS.maxCursorDepth) {
      throw new ExchangeError('CURSOR_TOO_DEEP', `pagination depth ${depth} reaches the ${EXCHANGE_POLICY_DEFAULTS.maxCursorDepth}-page bound`, false, 'narrow the query rather than paging further');
    }
  }

  private page(rows: ExchangeIntentRow[], depth: number): Page {
    const size = EXCHANGE_POLICY_DEFAULTS.defaultPageSize;
    const pageRows = rows.slice(0, size);
    const hasMore = rows.length > size;
    const last = pageRows[pageRows.length - 1];
    const results = pageRows.map((r) => this.project(r));
    return {
      contractsVersion: EXCHANGE_CONTRACTS_VERSION,
      results,
      cursor: hasMore && last ? encodeCursor({ t: last.createdAt.getTime(), i: last.id, depth: depth + 1 }) : null,
      state: results.length ? 'ok' : 'empty',
    };
  }

  private versionConflict() {
    return new ExchangeError('VERSION_CONFLICT', 'the intent changed since you loaded it', true, 'refresh the intent (its current version) and retry');
  }

  /** Project to the PUBLIC shape — coarse only, no owner internals, price is a
   *  disclaimered label, availability keeps explicit unknown semantics. */
  private project(row: ExchangeIntentRow): ExchangeIntentPublic {
    const availability: ExchangeIntentPublic['availability'] =
      row.availabilityState === 'window' && row.availabilityFrom && row.availabilityTo
        ? { state: 'window', fromIso: row.availabilityFrom.toISOString(), toIso: row.availabilityTo.toISOString() }
        : row.availabilityState === 'recurring' && row.availabilitySchedule
          ? { state: 'recurring', scheduleLabel: row.availabilitySchedule }
          : { state: 'unknown' };
    return {
      contractsVersion: EXCHANGE_CONTRACTS_VERSION,
      id: row.id,
      owner: { kind: row.ownerKind === 'business' ? 'business' : 'user', id: row.ownerId },
      kind: row.kind as ExchangeIntentPublic['kind'],
      status: row.status as ExchangeIntentStatus,
      category: row.category,
      title: row.title,
      text: row.text,
      tags: row.tags,
      ...(row.budgetBand ? { budgetBand: row.budgetBand as 'low' | 'medium' | 'high' } : {}),
      ...(row.informationalPrice ? { informationalPrice: { label: row.informationalPrice, disclaimer: 'informational-only-no-payment' as const } } : {}),
      availability,
      approxLocation: { lat: row.coarseLat, lon: row.coarseLon, cell: row.coarseCell },
      radius: { km: row.radiusKm, maxKm: row.maxRadiusKm },
      visibility: row.visibility as 'hidden' | 'discoverable',
      moderation: row.moderationState as ExchangeIntentPublic['moderation'],
      version: { seq: row.versionSeq },
      createdAtIso: row.createdAt.toISOString(),
      updatedAtIso: row.updatedAt.toISOString(),
      expiresAtIso: row.expiresAt ? row.expiresAt.toISOString() : null,
      /* The raw metre figure dies HERE, inside the projection: what leaves is
       * the band from the one registry in exchange.matching.ts. */
      ...(row.distanceM != null ? { distanceBand: bandFromMeters(row.distanceM) } : {}),
    };
  }
}

export { EXCHANGE_POLICY_DEFAULTS };
