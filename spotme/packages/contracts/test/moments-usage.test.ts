/**
 * COMPILE-TIME POSITIVE CONTROL for the Phase 5 Nearby Moments contracts.
 * If these break, the contracts became unusable, not just stricter.
 */

import { MOMENTS_CONTRACTS_VERSION, MOMENT_REACTIONS } from '../src/index.ts';
import type {
  CoarsePublicLocation, MomentPublic, MomentAuthorRef, MomentMediaRef,
  StoryPublic, MomentCommentPublic, MomentReaction, MomentFeedMode,
  MomentFeedOrder, RankedMomentPublic, MomentRankingBreakdown, MomentPage,
  MomentSafetyCapabilities, MomentReportInput, StoryState, MomentVisibility,
} from '../src/index.ts';

export const version: 1 = MOMENTS_CONTRACTS_VERSION;
export const registryClosed: readonly MomentReaction[] = MOMENT_REACTIONS;

const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;
const author: MomentAuthorRef = { userId: 'u1', displayName: 'Asha', distanceBand: 'under1km' };
const media: MomentMediaRef = { mediaId: 'm1', kind: 'image', mimeType: 'image/jpeg', contentHash: 'sha256:x', thumbnailId: 't1', width: 1080, height: 1350 };

/* All four visibility tiers are expressible on the OWNER-side type... */
export const tiers: MomentVisibility[] = ['private', 'friends', 'nearby', 'public'];

/* ...while a public moment carries only a feed tier, optionally with a coarse attach. */
export const post: MomentPublic = {
  id: 'p1', author, kind: 'photo', text: 'Sunset from the rooftop', media: [media],
  visibility: 'nearby', coarseLocation: coarse, createdAtUTC: 1,
  moderationState: 'visible', version: { seq: 1 },
};
/* A friends-tier post simply omits the coarse attach (optional-by-omission). */
export const noLocation: MomentPublic = {
  id: 'p2', author, kind: 'text', text: 'No location on this one', media: [],
  visibility: 'friends', createdAtUTC: 1, moderationState: 'visible', version: { seq: 1 },
};

/* Stories: only active is public; the six-state lifecycle narrows exhaustively. */
export const story: StoryPublic = { id: 's1', author, media, state: 'active', visibility: 'friends', createdAtUTC: 1, expiresAtUTC: 86_400_001 };
export function storyLabel(s: StoryState): string {
  switch (s) {
    case 'active': return 'Active';
    case 'expired': return 'Expired';
    case 'deleted': return 'Deleted';
    case 'archived': return 'Archived';
    case 'hidden': return 'Hidden';
    case 'moderation-hidden': return 'Hidden by moderation';
    default: { const never: never = s; return never; }
  }
}

/* Comments: flat with parentId; a reply references its parent. */
export const top: MomentCommentPublic = { id: 'c1', momentId: 'p1', parentId: null, author, text: 'Nice!', createdAtUTC: 2, moderationState: 'visible' };
export const reply: MomentCommentPublic = { ...top, id: 'c2', parentId: 'c1', text: 'Agreed' };

/* Ranked feed item: breakdown total equals the weighted sum; chronological default. */
export const order: MomentFeedOrder = 'chronological';
export const modes: MomentFeedMode[] = ['nearby', 'friends', 'city'];
const breakdown: MomentRankingBreakdown = {
  components: [
    { signal: 'recency', weight: 0.4, value: 1, weighted: 0.4 },
    { signal: 'proximity', weight: 0.3, value: 0.5, weighted: 0.15 },
  ],
  omittedSignals: ['relationship', 'explicitFollows', 'explicitInterests', 'freshness'],
  total: 0.55,
};
export const ranked: RankedMomentPublic = { ...post, ranking: breakdown };
export const totalOk: boolean = ranked.ranking.total === ranked.ranking.components.reduce((s, c) => s + c.weighted, 0);

/* Pages carry no totals; safety affordances always include report. */
export const page: MomentPage<RankedMomentPublic> = { results: [ranked], cursor: null, state: 'ok' };
export const hasNoTotal: boolean = !('total' in page) && !('count' in page);
export const safety: MomentSafetyCapabilities = { canReport: true, canBlock: true, canHide: true };

/* Child-safety report follows the mandatory path (a closed reason). */
export const csReport: MomentReportInput = { targetKind: 'moment', targetId: 'p1', reason: 'child-safety' };
