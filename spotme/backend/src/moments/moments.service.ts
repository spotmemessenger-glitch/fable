/**
 * Nearby Moments — orchestration service (Phase 5C). DARK: reachable only from
 * MomentsModule, which AppModule does not import. NO timeline logic in the
 * controller (M1) — it all lives here, behind the ports.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  MOMENT_REPOSITORY_PORT, MomentRepositoryPort, MomentRow, FeedQuery, MomentFeedMode,
  MOMENT_REALTIME_PORT, MomentRealtimePort, DisabledMomentRealtime,
} from './moments.ports';
import {
  validateMomentInput, validateCommentText, assertReaction, assertModerationTransition,
  MomentModerationState, MomentReaction, MomentVisibility,
} from './moments.policy';
import { chronological, rankMoments, RankableMoment, MomentRankingBreakdown } from './moments.ranking';
import { encodeCursor, decodeCursor, MomentDecodedCursor } from './moments.cursor';
import { notFound, versionConflict, MomentsError } from './moments.errors';
import { MomentMediaService } from '../moment-media/media.service';
import { FixtureMomentWorkers, ModerationJob, StoryExpiryJob } from '../moment-media/media.queues';

const PAGE_LIMIT = 25;
const DEFAULT_RADIUS_KM = 10;

export interface FeedPage {
  results: Array<{ moment: MomentRow; ranking: MomentRankingBreakdown | null; myReaction: MomentReaction | null }>;
  cursor: string | null;
  state: 'ok' | 'empty';
}

@Injectable()
export class MomentsService {
  /** Sanitized {moderation}/{story-expiry} job contracts (fixture recording). */
  readonly workers = new FixtureMomentWorkers();

  constructor(
    @Inject(MOMENT_REPOSITORY_PORT) private readonly repo: MomentRepositoryPort,
    @Optional() private readonly media: MomentMediaService | null,
    @Optional() @Inject(MOMENT_REALTIME_PORT) private readonly realtime: MomentRealtimePort = new DisabledMomentRealtime(),
  ) {}

  /* ------------------------------------------------------------ lifecycle */

  async createMoment(authorId: string, body: Record<string, unknown>): Promise<MomentRow> {
    const input = validateMomentInput(authorId, body);
    const row = await this.repo.createMoment(input);
    if (this.media) for (const id of input.mediaIds) await this.media.addReference(id);
    return row;
  }

  async deleteMoment(authorId: string, id: string, expectedVersion: number): Promise<void> {
    const row = await this.repo.findById(id);
    if (!row || row.authorId !== authorId) throw notFound(); // uniform
    const ok = await this.repo.deleteOwn(authorId, id, expectedVersion);
    if (!ok) throw versionConflict();
    if (this.media) for (const m of row.mediaIds) await this.media.releaseReference(m);
  }

  async getOwn(authorId: string, id: string): Promise<MomentRow> {
    const row = await this.repo.findById(id);
    if (!row || row.authorId !== authorId) throw notFound(); // uniform
    return row;
  }

  /* ------------------------------------------------------------ feeds (M2) */

  async feed(
    viewerId: string,
    mode: MomentFeedMode,
    opts: { origin?: { lat: number; lon: number } | null; radiusKm?: number; cursor?: string | null; order?: 'chronological' | 'ranked'; now?: number } = {},
  ): Promise<FeedPage> {
    const order = opts.order ?? 'chronological'; // M2: chronological-first default
    const cursor: MomentDecodedCursor | null = opts.cursor ? decodeCursor(opts.cursor) : null;
    const now = opts.now ?? Date.now();
    const q: FeedQuery = {
      viewerId, mode, origin: opts.origin ?? null,
      radiusKm: opts.radiusKm ?? DEFAULT_RADIUS_KM, limit: PAGE_LIMIT, cursor, now,
    };
    const rows = await this.repo.feed(q);

    let ordered: MomentRow[];
    let rankings: Map<string, MomentRankingBreakdown> | null = null;
    if (order === 'ranked') {
      const rankable = rows.map((r) => this.toRankable(r, viewerId, now));
      const ranked = rankMoments(rankable);
      rankings = new Map(ranked.map((x) => [x.moment.id, x.ranking]));
      const byId = new Map(rows.map((r) => [r.id, r]));
      ordered = ranked.map((x) => byId.get(x.moment.id)!).filter(Boolean);
    } else {
      const byId = new Map(rows.map((r) => [r.id, r]));
      ordered = chronological(rows.map((r) => this.toRankable(r, viewerId, now))).map((x) => byId.get(x.id)!);
    }

    const results = [] as FeedPage['results'];
    for (const m of ordered) {
      results.push({ moment: m, ranking: rankings?.get(m.id) ?? null, myReaction: await this.repo.myReaction(m.id, viewerId) });
    }
    let next: string | null = null;
    if (rows.length === PAGE_LIMIT) {
      // Keyset anchor stays CHRONOLOGICAL regardless of display order.
      const last = rows[rows.length - 1];
      next = encodeCursor({ t: last.createdAtUTC, i: last.id, depth: (cursor?.depth ?? 0) + 1 });
    }
    return { results, cursor: next, state: results.length === 0 ? 'empty' : 'ok' };
  }

  /** Deterministic evidence from the row + the viewer's EXPLICIT graph (M7). */
  private toRankable(r: MomentRow, _viewerId: string, now: number): RankableMoment & { createdAtUTC: number } {
    const ageMs = Math.max(0, now - r.createdAtUTC);
    const dayFrac = Math.max(0, 1 - ageMs / 86_400_000);
    return {
      id: r.id,
      createdAtUTC: r.createdAtUTC,
      evidence: {
        recency: dayFrac,
        freshness: ageMs < 3_600_000 ? 1 : dayFrac, // <1h = maximally fresh
        // relationship/proximity/explicitFollows/explicitInterests are supplied
        // by the repo-joined graph at activation; absent here ⇒ OMITTED, never
        // invented (the breakdown discloses them).
      },
    };
  }

  /* ------------------------------------------------------------ comments (M4) */

  async addComment(authorId: string, momentId: string, text: unknown, parentId: string | null): Promise<{ id: string }> {
    const t = validateCommentText(text);
    const moment = await this.repo.findById(momentId);
    if (!moment) throw notFound();
    if (parentId) {
      const siblings = await this.repo.comments(momentId, authorId, 500);
      if (!siblings.some((c) => c.id === parentId)) {
        throw new MomentsError('MALFORMED_MOMENT', 'parentId must reference a comment on the same moment (flat storage, M4)', false, 'reference an existing comment');
      }
    }
    const id = `mc-${randomUUID()}`;
    await this.repo.addComment({ id, momentId, parentId, authorId, text: t });
    // Sanitized notification: ids only, never content.
    await this.realtime.publish({ kind: 'comment', targetUserId: moment.authorId, refId: momentId, actorId: authorId });
    return { id };
  }

  async comments(viewerId: string, momentId: string) {
    return this.repo.comments(momentId, viewerId, 200);
  }

  /* ------------------------------------------------------------ reactions (M4) */

  async react(userId: string, momentId: string, reaction: string): Promise<void> {
    assertReaction(reaction);
    const moment = await this.repo.findById(momentId);
    if (!moment) throw notFound();
    await this.repo.setReaction(momentId, userId, reaction);
    await this.realtime.publish({ kind: 'reaction', targetUserId: moment.authorId, refId: momentId, actorId: userId });
  }

  async unreact(userId: string, momentId: string): Promise<void> {
    await this.repo.clearReaction(momentId, userId);
  }

  /* ------------------------------------------------------------ graph */

  async follow(followerId: string, targetId: string): Promise<void> {
    await this.repo.follow(followerId, targetId);
    await this.realtime.publish({ kind: 'follow', targetUserId: targetId, refId: followerId, actorId: followerId });
  }
  async unfollow(followerId: string, targetId: string): Promise<void> {
    await this.repo.unfollow(followerId, targetId);
  }
  async block(blockerId: string, blockedId: string): Promise<void> {
    await this.repo.block(blockerId, blockedId);
  }

  /* ------------------------------------------------------------ stories (M3) */

  async createStory(authorId: string, mediaId: string, visibility: Exclude<MomentVisibility, 'private'>, now = Date.now()) {
    const story = await this.repo.createStory(authorId, mediaId, visibility, now);
    if (this.media) {
      await this.media.addReference(mediaId);
      await this.media.stampStoryRetention(mediaId, story.expiresAtUTC);
    }
    return story;
  }

  async storyRail(viewerId: string, now = Date.now()) {
    return this.repo.storyRail(viewerId, now, 100);
  }

  async transitionStory(authorId: string, id: string, to: 'deleted' | 'archived' | 'hidden' | 'active', expectedVersion: number) {
    const row = await this.repo.transitionStory(authorId, id, to, expectedVersion);
    if (!row) throw notFound(); // uniform: absent, foreign, or stale all read the same
    return row;
  }

  /** The {story-expiry} job body — recorded via the fixture worker contract. */
  async runStoryExpirySweep(now = Date.now()): Promise<number> {
    const job: StoryExpiryJob = { name: 'story-expiry', sweepBeforeUTC: now };
    await this.workers.process(job);
    return this.repo.expireStories(now);
  }

  /* ------------------------------------------------------------ moderation */

  async report(reporterId: string, input: { targetKind: 'moment' | 'comment' | 'story'; targetId: string; reason: string; note?: string }): Promise<{ reportId: string }> {
    const { id } = await this.repo.createReport(reporterId, input.targetKind, input.targetId, input.reason, input.note ?? null);
    // Child-safety follows the MANDATORY priority lane (M6).
    const job: ModerationJob = {
      name: 'moderation', reportId: id, reason: input.reason,
      priority: input.reason === 'child-safety' ? 'child-safety' : 'standard',
    };
    await this.workers.process(job);
    // A first report moves visible → reported (closed table; audit appended).
    if (input.targetKind !== 'story') {
      const target = input.targetKind === 'moment' ? await this.repo.findById(input.targetId) : null;
      const from: MomentModerationState = target?.moderationState ?? 'visible';
      if (from === 'visible') {
        assertModerationTransition('visible', 'reported');
        await this.repo.setModerationState(input.targetKind, input.targetId, 'reported');
        await this.repo.appendModerationEvent(input.targetKind, input.targetId, 'visible', 'reported', input.reason, 'reporter');
      }
    }
    return { reportId: id };
  }

  /** Moderation decision (machinery only — thresholds/staffing owner-retained). */
  async moderate(targetKind: 'moment' | 'comment', targetId: string, from: MomentModerationState, to: MomentModerationState, reason: string | null): Promise<void> {
    assertModerationTransition(from, to);
    const ok = await this.repo.setModerationState(targetKind, targetId, to);
    if (!ok) throw notFound();
    await this.repo.appendModerationEvent(targetKind, targetId, from, to, reason, 'moderation');
  }
}
