/**
 * Prisma/PostGIS implementation of the Moments repository (Phase 5C).
 *
 * EVERY read-path exclusion lives IN SQL: private posts, blocked authors (both
 * directions), removed/limited content, and soft-deleted rows are never
 * fetched. Feeds are keyset-paginated (createdAt DESC, id DESC — never
 * OFFSET); the nearby feed bounds by ST_DWithin over the coarse point; the
 * city feed matches the server-derived city cell; the friends feed joins the
 * explicit-follow graph. The viewer origin is used transiently in the query
 * and never written anywhere.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type {
  MomentRepositoryPort, MomentRow, MomentStoryRow, MomentCommentRow, FeedQuery,
} from './moments.ports';
import type { ValidatedMomentInput, MomentVisibility, MomentModerationState, MomentReaction, MomentStoryState } from './moments.policy';
import { STORY_TTL_MS, assertStoryTransition } from './moments.policy';
import type { MomentDecodedCursor } from './moments.cursor';

const MOMENT_SELECT = `"id","authorId","kind","text","mediaIds","visibility","coarseLat","coarseLon","coarseCell","cityCell","moderationState","versionSeq","createdAt"`;

const round1 = (v: number) => Math.round(v * 10) / 10;

@Injectable()
export class PrismaMomentsRepository implements MomentRepositoryPort {
  constructor(private readonly prisma: PrismaService) {}

  async createMoment(input: ValidatedMomentInput): Promise<MomentRow> {
    const row = await this.prisma.moment.create({
      data: {
        authorId: input.authorId, kind: input.kind, text: input.text, mediaIds: input.mediaIds,
        visibility: input.visibility, coarseLat: input.coarseLat, coarseLon: input.coarseLon,
        coarseCell: input.coarseCell, cityCell: input.cityCell,
      },
    });
    if (input.coarseLat != null && input.coarseLon != null) {
      await this.prisma.$executeRaw`UPDATE "Moment" SET "geog" = ST_SetSRID(ST_MakePoint(${input.coarseLon}, ${input.coarseLat}), 4326)::geography WHERE "id" = ${row.id}`;
    }
    return this.toRow(row as never);
  }

  async findById(id: string): Promise<MomentRow | null> {
    const row = await this.prisma.moment.findFirst({ where: { id, deletedAt: null } });
    return row ? this.toRow(row as never) : null;
  }

  async deleteOwn(authorId: string, id: string, expectedVersion: number): Promise<boolean> {
    const res = await this.prisma.moment.updateMany({
      where: { id, authorId, versionSeq: expectedVersion, deletedAt: null },
      data: { deletedAt: new Date(), versionSeq: { increment: 1 } },
    });
    return res.count > 0;
  }

  /** The three feeds. Exclusions ALL in SQL (M5 + block + moderation). */
  async feed(q: FeedQuery): Promise<MomentRow[]> {
    const keyset = q.cursor
      ? Prisma.sql`AND ("createdAt" < ${new Date(q.cursor.t)} OR ("createdAt" = ${new Date(q.cursor.t)} AND "id" < ${q.cursor.i}))`
      : Prisma.empty;
    // Two-way block: content from anyone the viewer blocked, or who blocked the viewer, never surfaces.
    const notBlocked = Prisma.sql`AND NOT EXISTS (
      SELECT 1 FROM "MomentBlock" b
      WHERE (b."blockerId" = ${q.viewerId} AND b."blockedId" = m."authorId")
         OR (b."blockerId" = m."authorId" AND b."blockedId" = ${q.viewerId})
    )`;
    const notSelfExcluded = Prisma.sql`AND m."deletedAt" IS NULL`;

    let tierAndScope: Prisma.Sql;
    if (q.mode === 'nearby') {
      if (!q.origin) return [];
      const radiusM = Math.min(100, Math.max(1, q.radiusKm)) * 1000;
      tierAndScope = Prisma.sql`
        AND m."visibility" IN ('nearby', 'public')
        AND m."moderationState" IN ('visible', 'reported')
        AND m."geog" IS NOT NULL
        AND ST_DWithin(m."geog", ST_SetSRID(ST_MakePoint(${q.origin.lon}, ${q.origin.lat}), 4326)::geography, ${radiusM})`;
    } else if (q.mode === 'city') {
      if (!q.origin) return [];
      const cityCell = `c${round1(q.origin.lat).toFixed(1)}:${round1(q.origin.lon).toFixed(1)}`;
      tierAndScope = Prisma.sql`
        AND m."visibility" = 'public'
        AND m."moderationState" IN ('visible', 'reported')
        AND m."cityCell" = ${cityCell}`;
    } else {
      // friends: posts by people the viewer explicitly follows; limited stays
      // visible here ([PROPOSED]: 'limited' = reach-limited, not friend-hidden).
      tierAndScope = Prisma.sql`
        AND m."visibility" IN ('friends', 'nearby', 'public')
        AND m."moderationState" IN ('visible', 'reported', 'limited')
        AND EXISTS (SELECT 1 FROM "MomentFollow" f WHERE f."followerId" = ${q.viewerId} AND f."targetId" = m."authorId")`;
    }

    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT ${Prisma.raw(MOMENT_SELECT)}
      FROM "Moment" m
      WHERE m."visibility" <> 'private'
        ${tierAndScope} ${notBlocked} ${notSelfExcluded} ${keyset}
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT ${q.limit}
    `);
    return rows.map((r) => this.toRow(r as never));
  }

  async findOwn(authorId: string, limit: number, cursor: MomentDecodedCursor | null): Promise<MomentRow[]> {
    const rows = await this.prisma.moment.findMany({
      where: {
        authorId, deletedAt: null,
        ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.t) } }, { createdAt: new Date(cursor.t), id: { lt: cursor.i } }] } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((r) => this.toRow(r as never));
  }

  async addComment(row: Omit<MomentCommentRow, 'createdAtUTC' | 'moderationState'>): Promise<MomentCommentRow> {
    const c = await this.prisma.momentComment.create({
      data: { id: row.id, momentId: row.momentId, parentId: row.parentId, authorId: row.authorId, text: row.text },
    });
    return { id: c.id, momentId: c.momentId, parentId: c.parentId, authorId: c.authorId, text: c.text, moderationState: c.moderationState as MomentModerationState, createdAtUTC: c.createdAt.getTime() };
  }

  async comments(momentId: string, viewerId: string, limit: number): Promise<MomentCommentRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT c."id", c."momentId", c."parentId", c."authorId", c."text", c."moderationState", c."createdAt"
      FROM "MomentComment" c
      WHERE c."momentId" = ${momentId}
        AND c."moderationState" IN ('visible', 'reported')
        AND NOT EXISTS (
          SELECT 1 FROM "MomentBlock" b
          WHERE (b."blockerId" = ${viewerId} AND b."blockedId" = c."authorId")
             OR (b."blockerId" = c."authorId" AND b."blockedId" = ${viewerId}))
      ORDER BY c."createdAt" ASC
      LIMIT ${limit}
    `);
    return rows.map((c) => ({
      id: String(c.id), momentId: String(c.momentId), parentId: (c.parentId as string) ?? null,
      authorId: String(c.authorId), text: String(c.text),
      moderationState: c.moderationState as MomentModerationState,
      createdAtUTC: (c.createdAt as Date).getTime(),
    }));
  }

  async setReaction(momentId: string, userId: string, reaction: MomentReaction): Promise<void> {
    await this.prisma.momentReactionRow.upsert({
      where: { momentId_userId: { momentId, userId } },
      create: { momentId, userId, reaction },
      update: { reaction },
    });
  }
  async clearReaction(momentId: string, userId: string): Promise<void> {
    await this.prisma.momentReactionRow.deleteMany({ where: { momentId, userId } });
  }
  async myReaction(momentId: string, userId: string): Promise<MomentReaction | null> {
    const r = await this.prisma.momentReactionRow.findUnique({ where: { momentId_userId: { momentId, userId } } });
    return (r?.reaction as MomentReaction) ?? null;
  }

  async follow(followerId: string, targetId: string): Promise<void> {
    await this.prisma.momentFollow.upsert({
      where: { followerId_targetId: { followerId, targetId } },
      create: { followerId, targetId }, update: {},
    });
  }
  async unfollow(followerId: string, targetId: string): Promise<void> {
    await this.prisma.momentFollow.deleteMany({ where: { followerId, targetId } });
  }
  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.momentBlock.upsert({
      where: { blockerId_blockedId: { blockerId, blockedId } },
      create: { blockerId, blockedId }, update: {},
    });
  }

  async createStory(authorId: string, mediaId: string, visibility: Exclude<MomentVisibility, 'private'>, now: number): Promise<MomentStoryRow> {
    const s = await this.prisma.momentStory.create({
      data: { authorId, mediaId, visibility, expiresAt: new Date(now + STORY_TTL_MS) },
    });
    return this.toStoryRow(s as never);
  }

  /** Active, unexpired stories from followed authors + self; blocked excluded. */
  async storyRail(viewerId: string, now: number, limit: number): Promise<MomentStoryRow[]> {
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT s."id", s."authorId", s."mediaId", s."visibility", s."state", s."versionSeq", s."createdAt", s."expiresAt"
      FROM "MomentStory" s
      WHERE s."state" = 'active'
        AND s."expiresAt" > ${new Date(now)}
        AND (s."authorId" = ${viewerId}
             OR EXISTS (SELECT 1 FROM "MomentFollow" f WHERE f."followerId" = ${viewerId} AND f."targetId" = s."authorId"))
        AND NOT EXISTS (
          SELECT 1 FROM "MomentBlock" b
          WHERE (b."blockerId" = ${viewerId} AND b."blockedId" = s."authorId")
             OR (b."blockerId" = s."authorId" AND b."blockedId" = ${viewerId}))
      ORDER BY s."createdAt" DESC, s."id" DESC
      LIMIT ${limit}
    `);
    return rows.map((r) => this.toStoryRow(r as never));
  }

  async transitionStory(authorId: string | null, id: string, to: MomentStoryState, expectedVersion: number | null): Promise<MomentStoryRow | null> {
    const current = await this.prisma.momentStory.findUnique({ where: { id } });
    if (!current) return null;
    if (authorId && current.authorId !== authorId) return null; // uniform not-found upstream
    assertStoryTransition(current.state as MomentStoryState, to);
    const res = await this.prisma.momentStory.updateMany({
      where: { id, ...(expectedVersion != null ? { versionSeq: expectedVersion } : {}) },
      data: { state: to, versionSeq: { increment: 1 } },
    });
    if (res.count === 0) return null;
    const row = await this.prisma.momentStory.findUnique({ where: { id } });
    return row ? this.toStoryRow(row as never) : null;
  }

  async expireStories(sweepBeforeUTC: number): Promise<number> {
    const res = await this.prisma.momentStory.updateMany({
      where: { state: 'active', expiresAt: { lte: new Date(sweepBeforeUTC) } },
      data: { state: 'expired', versionSeq: { increment: 1 } },
    });
    return res.count;
  }

  async setModerationState(targetKind: 'moment' | 'comment', targetId: string, to: MomentModerationState): Promise<boolean> {
    if (targetKind === 'moment') {
      const res = await this.prisma.moment.updateMany({ where: { id: targetId }, data: { moderationState: to } });
      return res.count > 0;
    }
    const res = await this.prisma.momentComment.updateMany({ where: { id: targetId }, data: { moderationState: to } });
    return res.count > 0;
  }

  async createReport(reporterId: string, targetKind: string, targetId: string, reason: string, note: string | null): Promise<{ id: string }> {
    const r = await this.prisma.momentReport.create({ data: { reporterId, targetKind, targetId, reason, note } });
    return { id: r.id };
  }

  async appendModerationEvent(targetKind: string, targetId: string, fromState: string, toState: string, reason: string | null, byKind: string): Promise<void> {
    await this.prisma.momentModerationEvent.create({ data: { targetKind, targetId, fromState, toState, reason, byKind } });
  }

  private toRow(r: { id: string; authorId: string; kind: string; text: string | null; mediaIds: string[]; visibility: string; coarseLat: number | null; coarseLon: number | null; coarseCell: string | null; cityCell: string | null; moderationState: string; versionSeq: number; createdAt: Date }): MomentRow {
    return {
      id: r.id, authorId: r.authorId, kind: r.kind, text: r.text, mediaIds: r.mediaIds ?? [],
      visibility: r.visibility as MomentVisibility,
      coarseLat: r.coarseLat == null ? null : Number(r.coarseLat),
      coarseLon: r.coarseLon == null ? null : Number(r.coarseLon),
      coarseCell: r.coarseCell, cityCell: r.cityCell,
      moderationState: r.moderationState as MomentModerationState,
      versionSeq: Number(r.versionSeq), createdAtUTC: r.createdAt.getTime(),
    };
  }

  private toStoryRow(s: { id: string; authorId: string; mediaId: string; visibility: string; state: string; versionSeq: number; createdAt: Date; expiresAt: Date }): MomentStoryRow {
    return {
      id: s.id, authorId: s.authorId, mediaId: s.mediaId,
      visibility: s.visibility as Exclude<MomentVisibility, 'private'>,
      state: s.state as MomentStoryState, versionSeq: Number(s.versionSeq),
      createdAtUTC: s.createdAt.getTime(), expiresAtUTC: s.expiresAt.getTime(),
    };
  }
}
