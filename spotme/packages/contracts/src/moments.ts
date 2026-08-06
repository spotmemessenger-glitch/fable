/**
 * Nearby Moments — shared contracts (Platform Phase 5, group 5A, DARK).
 *
 * Framework-neutral, types-only. The single wire/domain contract for every
 * Moments surface (backend, web-next). Encodes the mission's rules at the TYPE
 * level wherever a type can carry one:
 *
 *  - VISIBILITY (M5): four poster-controlled tiers. `nearby`/`public` attach a
 *    COARSE CELL only; `private` is structurally excluded from every feed,
 *    index, and projection shape ({@link FeedVisibility} omits it — a private
 *    post in a feed item is a compile error).
 *  - RANKING (M2): the closed {@link MomentRankingSignal} registry names ONLY
 *    recency / relationship / proximity / explicitFollows / explicitInterests /
 *    freshness. Outrage, watch-time, engagement-probability, addiction/session
 *    optimization, popularity amplification, and sponsored are NOT members —
 *    unrepresentable here, and the 5C engine additionally throws.
 *    Chronological-first stays the default ({@link MomentFeedOrder}).
 *  - STORIES (M3): the six-state lifecycle is a closed contract property.
 *  - COMMENTS (M4): parent-REFERENCED (`parentId`), never nested storage.
 *  - REACTIONS (M4): a closed five-member registry; unknown rejected.
 *  - TRUST/METRICS: NO view/like/share counts exist on any public shape — a
 *    count field is a compile error (see moments-negative.test.ts).
 *  - A3: no age/gender field anywhere. Anti-enumeration: opaque cursor, no
 *    totals. Location: only the branded {@link CoarsePublicLocation}/cell.
 */

import type { CoarsePublicLocation, DistanceBand } from './discovery.ts';

/** Contracts version — bump on any breaking change to the moments shapes. */
export const MOMENTS_CONTRACTS_VERSION = 1 as const;
export type MomentsContractsVersion = typeof MOMENTS_CONTRACTS_VERSION;

/* ------------------------------------------------------------------ *
 * Visibility (M5) — four tiers; private excluded from feed types
 * ------------------------------------------------------------------ */

/** The four poster-controlled visibility tiers. Per-post. */
export type MomentVisibility = 'private' | 'friends' | 'nearby' | 'public';

/**
 * The visibility a FEED/INDEX item may carry — `private` is structurally
 * absent, so a private post cannot be expressed in any feed, index, or
 * projection shape (M5).
 */
export type FeedVisibility = Exclude<MomentVisibility, 'private'>;

/* ------------------------------------------------------------------ *
 * Moments
 * ------------------------------------------------------------------ */

export type MomentKind = 'photo' | 'video' | 'text';

/** Reference to an author — canonical identity lives elsewhere (A9). */
export interface MomentAuthorRef {
  readonly userId: string;
  readonly displayName: string;
  /** Banded distance to the viewer when person-attached; never metres. */
  readonly distanceBand?: DistanceBand;
}

/** A processed media reference — storage keys only, never raw bytes/EXIF. */
export interface MomentMediaRef {
  readonly mediaId: string;
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  /** Content hash (dedup); opaque. */
  readonly contentHash: string;
  readonly thumbnailId?: string;
  readonly width?: number;
  readonly height?: number;
  readonly durationMs?: number;
}

export type MomentModerationState = 'visible' | 'reported' | 'limited' | 'removed';

/** Closed moderation reason codes. */
export type MomentModerationReason =
  | 'spam' | 'harassment' | 'doxxing' | 'image-abuse' | 'child-safety'
  | 'revenge-content' | 'fake-business' | 'malware-link' | 'other-report';

/**
 * The public moment — the ONLY post shape a surface renders. Location, when the
 * poster attached one (nearby/public tiers only), is the branded coarse cell.
 * There is deliberately NO view count, like count, share count, or any
 * engagement metric on this shape.
 */
export interface MomentPublic {
  readonly id: string;
  readonly author: MomentAuthorRef;
  readonly kind: MomentKind;
  readonly text: string | null;
  readonly media: readonly MomentMediaRef[];
  readonly visibility: FeedVisibility;
  /** Poster-opted coarse attach (nearby/public only); absent = no location. */
  readonly coarseLocation?: CoarsePublicLocation;
  readonly createdAtUTC: number;
  readonly moderationState: MomentModerationState;
  /** Version for optimistic concurrency on owner mutations. */
  readonly version: { readonly seq: number };
}

/* ------------------------------------------------------------------ *
 * Stories (M3) — six-state lifecycle as contract
 * ------------------------------------------------------------------ */

/** The closed story lifecycle (M3). Expiry is 24h from publish ([PROPOSED]). */
export type StoryState =
  | 'active'            // live, within 24h
  | 'expired'           // past 24h — swept by the {story-expiry} job
  | 'deleted'           // manual delete by the owner
  | 'archived'          // owner archived (owner-visible only)
  | 'hidden'            // owner hid (owner-visible only)
  | 'moderation-hidden';// hidden by moderation

export interface StoryPublic {
  readonly id: string;
  readonly author: MomentAuthorRef;
  readonly media: MomentMediaRef;
  readonly state: Extract<StoryState, 'active'>; // only ACTIVE stories are public
  readonly visibility: FeedVisibility;
  readonly createdAtUTC: number;
  readonly expiresAtUTC: number;
}

/* ------------------------------------------------------------------ *
 * Comments (M4) — parent-referenced, flat
 * ------------------------------------------------------------------ */

/** Flat, parent-REFERENCED comment. Nesting is a render concern, never storage. */
export interface MomentCommentPublic {
  readonly id: string;
  readonly momentId: string;
  /** Parent comment id, or null for a top-level comment. NEVER nested storage. */
  readonly parentId: string | null;
  readonly author: MomentAuthorRef;
  readonly text: string;
  readonly createdAtUTC: number;
  readonly moderationState: MomentModerationState;
}

/* ------------------------------------------------------------------ *
 * Reactions (M4) — closed registry
 * ------------------------------------------------------------------ */

export const MOMENT_REACTIONS = ['like', 'love', 'laugh', 'wow', 'support'] as const;
export type MomentReaction = (typeof MOMENT_REACTIONS)[number];

/** The viewer's own reaction state; no aggregate counts on public shapes. */
export interface MomentReactionState {
  readonly myReaction: MomentReaction | null;
}

/* ------------------------------------------------------------------ *
 * Feeds (M2) — chronological-first; closed ranking registry
 * ------------------------------------------------------------------ */

export type MomentFeedMode = 'nearby' | 'friends' | 'city';

/** Chronological is the DEFAULT (M2); 'ranked' uses ONLY the closed registry. */
export type MomentFeedOrder = 'chronological' | 'ranked';

/**
 * The CLOSED ranking signal registry (M2). Forbidden signals (outrage,
 * watchTime, engagement/click probability, addictionOptimization,
 * popularityAmplification, sponsored) are not members and cannot be named.
 */
export type MomentRankingSignal =
  | 'recency'
  | 'relationship'
  | 'proximity'
  | 'explicitFollows'
  | 'explicitInterests'
  | 'freshness';

export interface MomentRankingComponent {
  readonly signal: MomentRankingSignal;
  readonly weight: number;
  readonly value: number;
  readonly weighted: number;
}

/** Required on every ranked result; unknown signals appear as omitted. */
export interface MomentRankingBreakdown {
  readonly components: readonly MomentRankingComponent[];
  readonly omittedSignals: readonly MomentRankingSignal[];
  readonly total: number;
}

export interface RankedMomentPublic extends MomentPublic {
  readonly ranking: MomentRankingBreakdown;
}

declare const MomentCursorBrand: unique symbol;
/** Opaque, signed keyset cursor (anti-enumeration); minted server-side only. */
export type MomentCursor = string & { readonly [MomentCursorBrand]: true };

/** A page of feed items. No total count is exposed (anti-enumeration). */
export interface MomentPage<T> {
  readonly results: readonly T[];
  readonly cursor: MomentCursor | null;
  readonly state: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';
}

/* ------------------------------------------------------------------ *
 * Safety capabilities & moderation
 * ------------------------------------------------------------------ */

/** Every rendered post/comment carries these affordances. */
export interface MomentSafetyCapabilities {
  readonly canReport: true;   // reporting is ALWAYS available
  readonly canBlock: boolean;
  readonly canHide: boolean;
}

/** A report submission. `child-safety` reports follow the MANDATORY path (M6). */
export interface MomentReportInput {
  readonly targetKind: 'moment' | 'comment' | 'story';
  readonly targetId: string;
  readonly reason: MomentModerationReason;
  readonly note?: string;
}

/** The closed moderation transition table is enforced in 5C; states here. */
export interface MomentModerationEventPublic {
  readonly fromState: MomentModerationState;
  readonly toState: MomentModerationState;
  readonly reason: MomentModerationReason | null;
  readonly atUTC: number;
}
