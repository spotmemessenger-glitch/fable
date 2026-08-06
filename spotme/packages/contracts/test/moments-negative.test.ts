/**
 * COMPILE-TIME NEGATIVE TESTS for the Phase 5 Nearby Moments contracts.
 *
 * Each `@ts-expect-error` asserts the marked assignment DOES NOT compile. If a
 * refactor makes a raw coordinate, an age/gender field, a forbidden ranking
 * signal, a view/like count on a public shape, an unknown reaction, or a
 * PRIVATE post in a feed item assignable, the expected error vanishes and
 * `tsc` fails with "unused @ts-expect-error" — the fence trips.
 */

import type {
  CoarsePublicLocation,
  MomentPublic,
  MomentRankingSignal,
  MomentReaction,
  MomentCursor,
  StoryPublic,
  MomentCommentPublic,
  MomentAuthorRef,
  MomentMediaRef,
} from '../src/index.ts';

const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;
const rawFix = { lat: 12.9716, lon: 77.5946 };
const author: MomentAuthorRef = { userId: 'u1', displayName: 'A' };
const media: MomentMediaRef = { mediaId: 'm1', kind: 'image', mimeType: 'image/jpeg', contentHash: 'h' };

/* A raw {lat,lon} is NOT assignable where the branded coarse type is required. */
export const okMoment: MomentPublic = {
  id: 'p1', author, kind: 'photo', text: null, media: [media],
  visibility: 'nearby', coarseLocation: coarse, createdAtUTC: 1,
  moderationState: 'visible', version: { seq: 1 },
};
export const badVenue: MomentPublic = {
  id: 'p1', author, kind: 'photo', text: null, media: [media],
  visibility: 'nearby',
  // @ts-expect-error a raw device fix cannot be a moment location (privacy brand)
  coarseLocation: rawFix,
  createdAtUTC: 1, moderationState: 'visible', version: { seq: 1 },
};

/* M5: a PRIVATE post is unrepresentable in any feed/public shape. */
export const badPrivate: MomentPublic = {
  id: 'p1', author, kind: 'text', text: 'x', media: [],
  // @ts-expect-error private never enters a feed/index/projection shape (M5)
  visibility: 'private',
  createdAtUTC: 1, moderationState: 'visible', version: { seq: 1 },
};

/* NO view/like/engagement count exists on any public shape. */
export function assertNoCounts(m: MomentPublic): void {
  // @ts-expect-error there is no view count on a public moment
  void m.viewCount;
  // @ts-expect-error there is no like count on a public moment
  void m.likeCount;
}

/* M2: forbidden ranking signals are unrepresentable. */
// @ts-expect-error watchTime is not a registered moments ranking signal (M2)
export const sigBad1: MomentRankingSignal = 'watchTime';
// @ts-expect-error engagement is not a registered moments ranking signal (M2)
export const sigBad2: MomentRankingSignal = 'engagement';
// @ts-expect-error sponsored is not a registered moments ranking signal (M2)
export const sigBad3: MomentRankingSignal = 'sponsored';
// @ts-expect-error popularityAmplification is not a registered signal (M2)
export const sigBad4: MomentRankingSignal = 'popularityAmplification';

/* M4: the reaction registry is closed. */
// @ts-expect-error 'angry' is not a registered reaction (closed registry, M4)
export const reactBad: MomentReaction = 'angry';

/* A3: no age/gender field on the author reference. */
export const authorBad: MomentAuthorRef = {
  userId: 'u1', displayName: 'A',
  // @ts-expect-error age is not part of any moments shape (A3)
  age: 30,
};

/* An opaque cursor cannot be built from a plain string (anti-enumeration). */
// @ts-expect-error MomentCursor is branded — a plain string is not assignable
export const curBad: MomentCursor = 'page-2';

/* M3: only ACTIVE stories are public; other states are unrepresentable. */
export const storyBad: StoryPublic = {
  id: 's1', author, media,
  // @ts-expect-error only an active story may appear as StoryPublic (M3)
  state: 'expired',
  visibility: 'friends', createdAtUTC: 1, expiresAtUTC: 2,
};

/* M4: comments are parent-referenced, never nested — no children field. */
export function assertFlatComments(c: MomentCommentPublic): void {
  // @ts-expect-error comments carry parentId only; nested children never exist (M4)
  void c.children;
}
