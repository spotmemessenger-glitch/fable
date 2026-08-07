/**
 * Nearby Moments — orchestration service (Phase 5C). DARK: reachable only from
 * MomentsModule, which AppModule does not import. NO timeline logic in the
 * controller (M1) — it all lives here, behind the ports.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModerationSink } from '../moment-media/moderation.sink';
import { randomUUID } from 'node:crypto';
import {
  MOMENT_REPOSITORY_PORT, MomentRepositoryPort, MomentRow, FeedQuery, MomentFeedMode,
  MOMENT_REALTIME_PORT, MomentRealtimePort, DisabledMomentRealtime,
} from './moments.ports';
import {
  validateMomentInput, validateCommentText, assertReaction, assertModerationTransition,
  MomentModerationState, MomentReaction, MomentVisibility, VISIBILITIES,
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
    /* EXPLICIT TOKENS on both optionals: a union type (`X | null`) emits
     * `Object` as its design:type, so without @Inject the DI token is
     * unresolvable and @Optional silently hands this service null — media
     * refCounts never move and reports never reach the sink, with no error
     * anywhere. The gate-runtime spec now asserts both wires hot. */
    @Optional() @Inject(MomentMediaService) private readonly media: MomentMediaService | null,
    @Optional() @Inject(MOMENT_REALTIME_PORT) private readonly realtime: MomentRealtimePort = new DisabledMomentRealtime(),
    /* D7: where a report actually GOES. Optional so the service still
     * constructs in unit tests that do not build the media module. */
    @Optional() @Inject(ModerationSink) private readonly moderationSink: ModerationSink | null = null,
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

  /**
   * Change an existing post's audience.
   *
   * Uniform notFound for "does not exist" and "not yours" — the same posture as
   * deleteMoment, so this cannot be used to discover whether an id is real.
   */
  async setVisibility(authorId: string, id: string, visibility: MomentVisibility, expectedVersion: number): Promise<MomentRow> {
    if (!VISIBILITIES.includes(visibility)) {
      throw new MomentsError('MALFORMED_MOMENT', 'visibility must be private|friends|nearby|public', false, 'fix visibility');
    }
    const row = await this.repo.findById(id);
    if (!row || row.authorId !== authorId) throw notFound();
    const ok = await this.repo.setVisibility(authorId, id, visibility, expectedVersion);
    if (!ok) throw versionConflict();
    const after = await this.repo.findById(id);
    if (!after) throw notFound();
    return after;
  }

  /**
   * One moment, by id, for a viewer who arrived on a SHARE LINK rather than
   * through a feed. The whole point of a shared `#/posts?m=<id>` is that it
   * works for someone whose nearby feed does not contain that post, so this
   * cannot be served by filtering a feed page client-side.
   *
   * The tier check is `findViewable`, the same SQL gate the comment and
   * reaction paths already trust: private ⇒ author only, friends ⇒ author or
   * follower, nearby/public ⇒ any non-blocked viewer, and blocked (either
   * direction) or removed content returns null. A link therefore grants no
   * access the feed would not have granted — it only saves the scrolling.
   * Absent and forbidden are the SAME 404, so a link cannot be used to probe
   * whether a given moment id exists.
   */
  async getViewable(viewerId: string, id: string): Promise<{ moment: MomentRow; myReaction: MomentReaction | null }> {
    const moment = await this.repo.findViewable(viewerId, id);
    if (!moment) throw notFound(); // uniform: unknown and forbidden are one answer
    return { moment, myReaction: await this.repo.myReaction(id, viewerId) };
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
    // Review PRIVATE-INTERACT: direct-by-id interaction runs the FULL tier +
    // block gate; an unviewable moment reads as uniform NOT_FOUND.
    const moment = await this.repo.findViewable(authorId, momentId);
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
    const moment = await this.repo.findViewable(viewerId, momentId); // PRIVATE-INTERACT gate
    if (!moment) throw notFound();
    return this.repo.comments(momentId, viewerId, 200);
  }

  /* ------------------------------------------------------------ reactions (M4) */

  async react(userId: string, momentId: string, reaction: string): Promise<void> {
    assertReaction(reaction);
    const moment = await this.repo.findViewable(userId, momentId); // PRIVATE-INTERACT gate
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
    await this.workers.process(job);   // contract record (fences read this)
    /* AND THE PART THAT WAS MISSING (D7). The fixture worker above records the
     * job shape and nothing more; until this line a report reached no durable
     * delivery marker and raised no alert, which is why the report button was
     * telling people something would happen when nothing would. Never allowed
     * to fail the caller's request: the report ROW is already written, and a
     * sink outage must not turn a successful report into an error. */
    if (this.moderationSink) {
      await this.moderationSink
        .accept({ reportId: id, targetKind: input.targetKind, targetId: input.targetId, reason: input.reason })
        .catch(() => undefined);
    }
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
