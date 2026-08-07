/**
 * The HTTP boundary for Moments: error mapping + response serialization.
 *
 * WHY THIS FILE EXISTS. The dark phase returned raw service rows and threw
 * bare `MomentsError`s. The moment a real client hit it, two things broke:
 * every refusal surfaced as HTTP 500 (a version conflict is not a server
 * fault — it is a 409 the client must handle), and the row shape leaked
 * internal names (`versionSeq`, `mediaIds: string[]`, `authorId` with no
 * display name) that no client could render. Both are fixed HERE, at the
 * seam, so the service stays pure and the controller stays thin.
 */

import { ArgumentsHost, Catch, ExceptionFilter, HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MomentsError, MomentsErrorCode } from './moments.errors';
import type { MomentRow, MomentCommentRow, MomentStoryRow } from './moments.ports';

/** Typed refusal → HTTP status. Everything else is a real 500. */
const STATUS: Record<MomentsErrorCode, number> = {
  MALFORMED_MOMENT: HttpStatus.BAD_REQUEST,
  PRECISE_LOCATION_REFUSED: HttpStatus.BAD_REQUEST,
  LOCATION_TIER_REFUSED: HttpStatus.BAD_REQUEST,
  UNSUPPORTED_FIELD: HttpStatus.BAD_REQUEST,
  UNKNOWN_REACTION: HttpStatus.BAD_REQUEST,
  INVALID_CURSOR: HttpStatus.BAD_REQUEST,
  CURSOR_TOO_DEEP: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  VERSION_CONFLICT: HttpStatus.CONFLICT,
  ILLEGAL_TRANSITION: HttpStatus.CONFLICT,
};

interface HttpRes {
  status(code: number): { json(body: unknown): void };
}

@Catch(MomentsError)
export class MomentsExceptionFilter implements ExceptionFilter {
  catch(err: MomentsError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<HttpRes>();
    // NOTE: NOT_FOUND stays uniform (a foreign id and a missing id are one
    // status and one body) — the enumeration-resistance property the errors
    // file documents survives the mapping.
    res.status(STATUS[err.code] ?? HttpStatus.INTERNAL_SERVER_ERROR).json(err.toWire());
  }
}

/* --------------------------------------------------------- serialization */

export interface MomentMediaView {
  mediaId: string;
  kind: 'image' | 'video';
  posterUrl: string | null;
}
export interface MomentAuthorView {
  userId: string;
  displayName: string;
  /* THE HANDLE, CARRIED SEPARATELY FROM THE DISPLAY NAME.
   *
   * `displayName` is the profile name and falls back to `@username` only when
   * that name is unset, so a client wanting to show the handle could not
   * recover it — it had `userId` (an internal cuid, never for display) and a
   * string that might or might not be a handle. Stories name people by handle,
   * which is what this field is for. Null for an account with no claimed
   * username; the client falls back to the display name. */
  username: string | null;
}
export interface MomentView {
  id: string;
  author: MomentAuthorView;
  kind: string;
  text: string | null;
  media: MomentMediaView[];
  visibility: string;
  coarseCell: string | null;
  createdAtUTC: number;
  version: number;
  myReaction: string | null;
  ranking: unknown;
  mine: boolean;
}

@Injectable()
export class MomentSerializer {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Turn service rows into the client contract, batching the two lookups the
   * raw row is missing: the author's DISPLAY NAME (rows carry only authorId)
   * and each asset's KIND (rows carry only mediaId strings, and a client must
   * know image-vs-video to render). One query each, never N+1.
   */
  async feed(
    viewerId: string,
    rows: Array<{ moment: MomentRow; ranking: unknown; myReaction: string | null }>,
  ): Promise<MomentView[]> {
    const authorIds = [...new Set(rows.map((r) => r.moment.authorId))];
    const mediaIds = [...new Set(rows.flatMap((r) => r.moment.mediaIds))];
    const [authors, assets] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, username: true } }),
      this.prisma.momentMediaAsset.findMany({ where: { id: { in: mediaIds } }, select: { id: true, kind: true } }),
    ]);
    const nameOf = new Map(authors.map((a) => [a.id, a.name || (a.username ? `@${a.username}` : 'Someone')]));
    const handleOf = new Map(authors.map((a) => [a.id, a.username ?? null]));
    const kindOf = new Map(assets.map((a) => [a.id, a.kind === 'video' ? 'video' : 'image'] as const));
    return rows.map((r) => this.one(viewerId, r.moment, r.myReaction, r.ranking, nameOf, handleOf, kindOf));
  }

  /** One row (used by create, which has no batch to amortise). */
  async single(viewerId: string, moment: MomentRow, myReaction: string | null = null): Promise<MomentView> {
    const [author, assets] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: moment.authorId }, select: { name: true, username: true } }),
      this.prisma.momentMediaAsset.findMany({ where: { id: { in: moment.mediaIds } }, select: { id: true, kind: true } }),
    ]);
    const nameOf = new Map([[moment.authorId, author?.name || (author?.username ? `@${author.username}` : 'Someone')]]);
    const handleOf = new Map([[moment.authorId, author?.username ?? null]]);
    const kindOf = new Map(assets.map((a) => [a.id, a.kind === 'video' ? 'video' : 'image'] as const));
    return this.one(viewerId, moment, myReaction, null, nameOf, handleOf, kindOf);
  }

  private one(
    viewerId: string,
    m: MomentRow,
    myReaction: string | null,
    ranking: unknown,
    nameOf: Map<string, string>,
    handleOf: Map<string, string | null>,
    kindOf: Map<string, 'image' | 'video'>,
  ): MomentView {
    return {
      id: m.id,
      author: {
        userId: m.authorId,
        displayName: nameOf.get(m.authorId) ?? 'Someone',
        username: handleOf.get(m.authorId) ?? null,
      },
      kind: m.kind,
      text: m.text,
      media: m.mediaIds.map((mediaId) => ({ mediaId, kind: kindOf.get(mediaId) ?? 'image', posterUrl: null })),
      visibility: m.visibility,
      coarseCell: m.coarseCell,
      createdAtUTC: m.createdAtUTC,
      version: m.versionSeq,
      myReaction,
      ranking,
      mine: m.authorId === viewerId,
    };
  }

  /** Comments: a bare row array becomes a stable `{results}` envelope. */
  comments(rows: MomentCommentRow[], names: Map<string, string>) {
    return {
      results: rows.map((c) => ({
        id: c.id,
        author: { userId: c.authorId, displayName: names.get(c.authorId) ?? 'Someone' },
        text: c.text,
        parentId: c.parentId,
        createdAtUTC: c.createdAtUTC,
      })),
    };
  }

  async commentNames(rows: MomentCommentRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.map((c) => c.authorId))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, username: true } });
    return new Map(users.map((u) => [u.id, u.name || (u.username ? `@${u.username}` : 'Someone')]));
  }

  /** Stories rail: bare array → `{results}`, each with an author display name. */
  async rail(rows: MomentStoryRow[]) {
    const ids = [...new Set(rows.map((s) => s.authorId))];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, username: true } });
    const nameOf = new Map(users.map((u) => [u.id, u.name || (u.username ? `@${u.username}` : 'Someone')]));
    const handleOf = new Map(users.map((u) => [u.id, u.username ?? null]));
    return {
      results: rows.map((s) => ({
        id: s.id,
        author: {
          userId: s.authorId,
          displayName: nameOf.get(s.authorId) ?? 'Someone',
          username: handleOf.get(s.authorId) ?? null,
        },
        mediaId: s.mediaId,
        expiresAtUTC: s.expiresAtUTC,
      })),
    };
  }
}
