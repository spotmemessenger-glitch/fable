/**
 * Nearby Moments — backend ports (Phase 5C, M1). NO timeline logic lives in a
 * controller: the controller speaks to MomentFeedPort/MomentRepositoryPort/
 * MomentRankingPort/MomentModerationPort only; realtime is an interface + a
 * DISABLED adapter (no Centrifugo wiring — ADR-026 alignment).
 */

import type { ValidatedMomentInput, MomentVisibility, MomentModerationState, MomentReaction, MomentStoryState } from './moments.policy';
import type { MomentDecodedCursor } from './moments.cursor';
import type { MomentRankingBreakdown, RankableMoment } from './moments.ranking';

export interface MomentRow {
  id: string;
  authorId: string;
  kind: string;
  text: string | null;
  mediaIds: string[];
  visibility: MomentVisibility;
  coarseLat: number | null;
  coarseLon: number | null;
  coarseCell: string | null;
  cityCell: string | null;
  moderationState: MomentModerationState;
  versionSeq: number;
  createdAtUTC: number;
}

export interface MomentStoryRow {
  id: string;
  authorId: string;
  mediaId: string;
  visibility: Exclude<MomentVisibility, 'private'>;
  state: MomentStoryState;
  versionSeq: number;
  createdAtUTC: number;
  expiresAtUTC: number;
}

export interface MomentCommentRow {
  id: string;
  momentId: string;
  parentId: string | null;
  authorId: string;
  text: string;
  moderationState: MomentModerationState;
  createdAtUTC: number;
}

/* `global` reaches every 'public' post regardless of where it was made — the
 * only mode with no geographic predicate at all.
 *
 * It exists because `public` had no surface: `city` filters on cityCell (~11 km),
 * which is a city, not the world, so a post marked public appeared in `nearby`
 * within radius and nowhere else. The audience and the reach did not match, and
 * the option was removed from the composer for exactly that reason. This is what
 * makes putting it back honest. */
export type MomentFeedMode = 'nearby' | 'friends' | 'city' | 'global';

export interface FeedQuery {
  viewerId: string;
  mode: MomentFeedMode;
  /** Device-local, already-coarse origin — used transiently for the spatial
   *  bound / city-cell derivation; NEVER stored on a row. */
  origin: { lat: number; lon: number } | null;
  radiusKm: number;
  limit: number;
  cursor: MomentDecodedCursor | null;
  now: number;
}

export const MOMENT_REPOSITORY_PORT = Symbol('MOMENT_REPOSITORY_PORT');
export interface MomentRepositoryPort {
  createMoment(input: ValidatedMomentInput): Promise<MomentRow>;
  findById(id: string): Promise<MomentRow | null>;
  /** Tier-aware direct-by-id access (review PRIVATE-INTERACT): returns the row
   *  ONLY if the viewer may see it — private: author only; friends: author or
   *  follower; nearby/public: any non-blocked viewer. Blocked (both
   *  directions) and removed content returns null. ALL in SQL. */
  findViewable(viewerId: string, id: string): Promise<MomentRow | null>;
  deleteOwn(authorId: string, id: string, expectedVersion: number): Promise<boolean>;
  /** Change an existing post's audience. Author-scoped, version-checked, and it
   *  CLEARS the coarse location when the new tier may not carry one. */
  setVisibility(authorId: string, id: string, visibility: MomentVisibility, expectedVersion: number): Promise<boolean>;
  /** Every exclusion IN SQL: private, blocked (both directions), removed,
   *  deleted, tier-inapplicable rows are never fetched. */
  feed(q: FeedQuery): Promise<MomentRow[]>;
  findOwn(authorId: string, limit: number, cursor: MomentDecodedCursor | null): Promise<MomentRow[]>;
  addComment(row: Omit<MomentCommentRow, 'createdAtUTC' | 'moderationState'>): Promise<MomentCommentRow>;
  comments(momentId: string, viewerId: string, limit: number): Promise<MomentCommentRow[]>;
  setReaction(momentId: string, userId: string, reaction: MomentReaction): Promise<void>;
  clearReaction(momentId: string, userId: string): Promise<void>;
  myReaction(momentId: string, userId: string): Promise<MomentReaction | null>;
  follow(followerId: string, targetId: string): Promise<void>;
  unfollow(followerId: string, targetId: string): Promise<void>;
  block(blockerId: string, blockedId: string): Promise<void>;
  createStory(authorId: string, mediaId: string, visibility: Exclude<MomentVisibility, 'private'>, now: number): Promise<MomentStoryRow | null>;
  storyRail(viewerId: string, now: number, limit: number): Promise<MomentStoryRow[]>;
  transitionStory(authorId: string | null, id: string, to: MomentStoryState, expectedVersion: number | null): Promise<MomentStoryRow | null>;
  /** The {story-expiry} sweep body: active + past-expiry → expired. */
  expireStories(sweepBeforeUTC: number): Promise<number>;
  setModerationState(targetKind: 'moment' | 'comment', targetId: string, to: MomentModerationState): Promise<boolean>;
  createReport(reporterId: string, targetKind: string, targetId: string, reason: string, note: string | null): Promise<{ id: string }>;
  appendModerationEvent(targetKind: string, targetId: string, fromState: string, toState: string, reason: string | null, byKind: string): Promise<void>;
}

export const MOMENT_FEED_PORT = Symbol('MOMENT_FEED_PORT');
export interface MomentFeedPort {
  fetch(q: FeedQuery, order: 'chronological' | 'ranked'): Promise<{ rows: MomentRow[]; rankings: Map<string, MomentRankingBreakdown> | null }>;
}

export const MOMENT_RANKING_PORT = Symbol('MOMENT_RANKING_PORT');
export interface MomentRankingPort {
  rank<T extends RankableMoment>(rows: T[]): { moment: T; ranking: MomentRankingBreakdown }[];
}

export const MOMENT_MODERATION_PORT = Symbol('MOMENT_MODERATION_PORT');
export interface MomentModerationPort {
  report(reporterId: string, input: { targetKind: 'moment' | 'comment' | 'story'; targetId: string; reason: string; note?: string }): Promise<{ reportId: string; priority: 'child-safety' | 'standard' }>;
  transition(targetKind: 'moment' | 'comment', targetId: string, to: MomentModerationState, reason: string | null, byKind: 'reporter' | 'moderation' | 'system'): Promise<void>;
}

/* ------------------------------------------------------------ realtime (M1) */

/** Sanitized realtime notification — ids + closed kinds ONLY, never content. */
export interface MomentRealtimeNotification {
  kind: 'comment' | 'reaction' | 'follow' | 'story';
  targetUserId: string;
  refId: string;
  actorId: string;
}

export const MOMENT_REALTIME_PORT = Symbol('MOMENT_REALTIME_PORT');
export interface MomentRealtimePort {
  readonly name: string;
  publish(n: MomentRealtimeNotification): Promise<{ delivered: boolean }>;
}

/** The ONLY adapter this phase: disabled, no transport, no Centrifugo wiring. */
export class DisabledMomentRealtime implements MomentRealtimePort {
  readonly name = 'disabled';
  async publish(_n: MomentRealtimeNotification): Promise<{ delivered: boolean }> {
    return { delivered: false };
  }
}
