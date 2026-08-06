/**
 * Prisma/PostGIS implementation of the Exchange repository (Phase 3B).
 *
 * Idempotent create (unique ownerId+idempotencyKey), optimistic-concurrency
 * transitions (versionSeq guard) with an atomic lifecycle-event append, and
 * keyset pagination on (createdAt, id) — no OFFSET. The discoverable query keeps
 * every exclusion in SQL: hidden/removed/expired rows and rows the principal
 * owns are never fetched. The geography column is written from the coarse point.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CreateIntentResult,
  ExchangeIntentRepository,
  NearbyIntentsQuery,
} from './exchange.repository';
import { ExchangeDecodedCursor, ExchangeIntentRow, ValidatedExchangeIntentInput } from './exchange.types';

const SELECT = {
  id: true, ownerId: true, ownerKind: true, kind: true, status: true, category: true,
  title: true, text: true, tags: true, budgetBand: true, informationalPrice: true,
  availabilityState: true, availabilityFrom: true, availabilityTo: true, availabilitySchedule: true,
  coarseLat: true, coarseLon: true, coarseCell: true, radiusKm: true, maxRadiusKm: true,
  visibility: true, moderationState: true, versionSeq: true, createdAt: true, updatedAt: true, expiresAt: true,
} as const;

@Injectable()
export class PrismaExchangeIntentRepository implements ExchangeIntentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createDraft(input: ValidatedExchangeIntentInput): Promise<CreateIntentResult> {
    const find = () => this.prisma.exchangeIntent.findUnique({
      where: { ownerId_idempotencyKey: { ownerId: input.ownerId, idempotencyKey: input.idempotencyKey } },
      select: SELECT,
    });
    const existing = await find();
    if (existing) return { row: existing as ExchangeIntentRow, idempotentReplay: true };

    let created: ExchangeIntentRow;
    try {
      created = await this.insert(input);
    } catch (e) {
      // Race-safe idempotency (review IDEMPOTENCY-RACE): two concurrent requests
      // with the same key both miss the find; the unique constraint rejects the
      // loser with P2002. Catch it and return the winner's row as a replay,
      // rather than surfacing a 500.
      if ((e as { code?: string }).code === 'P2002') {
        const row = await find();
        if (row) return { row: row as ExchangeIntentRow, idempotentReplay: true };
      }
      throw e;
    }
    return { row: created, idempotentReplay: false };
  }

  private async insert(input: ValidatedExchangeIntentInput): Promise<ExchangeIntentRow> {
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.exchangeIntent.create({
        data: {
          ownerId: input.ownerId, ownerKind: input.ownerKind, kind: input.kind, status: 'draft',
          category: input.category, title: input.title, text: input.text, tags: input.tags,
          budgetBand: input.budgetBand ?? null, informationalPrice: input.informationalPrice ?? null,
          availabilityState: input.availabilityState,
          availabilityFrom: input.availabilityFrom ?? null, availabilityTo: input.availabilityTo ?? null,
          availabilitySchedule: input.availabilitySchedule ?? null,
          coarseLat: input.coarseLat, coarseLon: input.coarseLon, coarseCell: input.coarseCell,
          radiusKm: input.radiusKm, maxRadiusKm: input.maxRadiusKm,
          visibility: input.visibility, idempotencyKey: input.idempotencyKey, expiresAt: input.expiresAt,
        },
        select: SELECT,
      });
      await tx.$executeRaw`UPDATE "ExchangeIntent" SET "geog" = ST_SetSRID(ST_MakePoint(${input.coarseLon}, ${input.coarseLat}), 4326)::geography WHERE "id" = ${row.id}`;
      await tx.exchangeLifecycleEvent.create({ data: { intentId: row.id, fromStatus: 'draft', toStatus: 'draft', byKind: 'owner', reasonCode: 'owner-action' } });
      return row;
    }) as unknown as ExchangeIntentRow;
  }

  async findById(id: string): Promise<ExchangeIntentRow | null> {
    const row = await this.prisma.exchangeIntent.findUnique({ where: { id }, select: SELECT });
    return (row as ExchangeIntentRow) ?? null;
  }

  async updateFields(id: string, expectedVersion: number, patch: Partial<ValidatedExchangeIntentInput>): Promise<ExchangeIntentRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.exchangeIntent.updateMany({
        where: { id, versionSeq: expectedVersion },
        data: {
          ...(patch.category !== undefined ? { category: patch.category } : {}),
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.text !== undefined ? { text: patch.text } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          ...(patch.budgetBand !== undefined ? { budgetBand: patch.budgetBand ?? null } : {}),
          ...(patch.informationalPrice !== undefined ? { informationalPrice: patch.informationalPrice ?? null } : {}),
          ...(patch.availabilityState !== undefined ? { availabilityState: patch.availabilityState } : {}),
          ...(patch.availabilityFrom !== undefined ? { availabilityFrom: patch.availabilityFrom ?? null } : {}),
          ...(patch.availabilityTo !== undefined ? { availabilityTo: patch.availabilityTo ?? null } : {}),
          ...(patch.availabilitySchedule !== undefined ? { availabilitySchedule: patch.availabilitySchedule ?? null } : {}),
          ...(patch.coarseLat !== undefined ? { coarseLat: patch.coarseLat } : {}),
          ...(patch.coarseLon !== undefined ? { coarseLon: patch.coarseLon } : {}),
          ...(patch.coarseCell !== undefined ? { coarseCell: patch.coarseCell } : {}),
          ...(patch.radiusKm !== undefined ? { radiusKm: patch.radiusKm } : {}),
          ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
          ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
          versionSeq: { increment: 1 },
        },
      });
      if (res.count === 0) return null; // version moved — conflict
      if (patch.coarseLat !== undefined && patch.coarseLon !== undefined) {
        await tx.$executeRaw`UPDATE "ExchangeIntent" SET "geog" = ST_SetSRID(ST_MakePoint(${patch.coarseLon}, ${patch.coarseLat}), 4326)::geography WHERE "id" = ${id}`;
      }
      const row = await tx.exchangeIntent.findUnique({ where: { id }, select: SELECT });
      return (row as ExchangeIntentRow) ?? null;
    });
  }

  async transition(id: string, expectedVersion: number, to: string, by: 'owner' | 'moderation' | 'system-expiry', reasonCode: string | null): Promise<ExchangeIntentRow | null> {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.exchangeIntent.findUnique({ where: { id }, select: { status: true } });
      if (!current) return null;
      const res = await tx.exchangeIntent.updateMany({
        where: { id, versionSeq: expectedVersion },
        data: { status: to, versionSeq: { increment: 1 } },
      });
      if (res.count === 0) return null;
      await tx.exchangeLifecycleEvent.create({ data: { intentId: id, fromStatus: current.status, toStatus: to, byKind: by, reasonCode } });
      const row = await tx.exchangeIntent.findUnique({ where: { id }, select: SELECT });
      return (row as ExchangeIntentRow) ?? null;
    });
  }

  async findDiscoverable(q: NearbyIntentsQuery): Promise<ExchangeIntentRow[]> {
    // Keyset on (createdAt DESC, id DESC) — newest first, deterministic.
    const keyset = q.cursor
      ? Prisma.sql`AND ("createdAt" < ${new Date(q.cursor.t)} OR ("createdAt" = ${new Date(q.cursor.t)} AND "id" < ${q.cursor.i}))`
      : Prisma.empty;
    const kindF = q.kind ? Prisma.sql`AND "kind" = ${q.kind}` : Prisma.empty;
    const catF = q.category ? Prisma.sql`AND "category" = ${q.category}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ExchangeIntentRow[]>(Prisma.sql`
      SELECT ${Prisma.raw(Object.keys(SELECT).map((k) => `"${k}"`).join(', '))}
      FROM "ExchangeIntent"
      WHERE "visibility" = 'discoverable'
        AND "status" IN ('active', 'matched')
        AND "moderationState" = 'clear'
        AND ("expiresAt" IS NULL OR "expiresAt" > ${q.now})
        AND "ownerId" <> ${q.principalId}
        ${kindF} ${catF} ${keyset}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${q.limit}
    `);
    return rows.map(normalize);
  }

  async findOwn(ownerId: string, limit: number, cursor: ExchangeDecodedCursor | null): Promise<ExchangeIntentRow[]> {
    const rows = await this.prisma.exchangeIntent.findMany({
      where: {
        ownerId,
        status: { not: 'removed' },
        ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.t) } }, { createdAt: new Date(cursor.t), id: { lt: cursor.i } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: SELECT,
    });
    return rows as ExchangeIntentRow[];
  }
}

/** $queryRaw returns Float columns as-is but Date columns as Date; coerce the
 *  numeric coordinate columns defensively (they arrive as number already). */
function normalize(r: ExchangeIntentRow): ExchangeIntentRow {
  return {
    ...r,
    coarseLat: Number(r.coarseLat),
    coarseLon: Number(r.coarseLon),
    radiusKm: Number(r.radiusKm),
    maxRadiusKm: Number(r.maxRadiusKm),
    versionSeq: Number(r.versionSeq),
  };
}
