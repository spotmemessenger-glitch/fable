/**
 * Nearby Moments — input validation + the closed moderation machine (5C).
 *
 * `validateMomentInput` is the ONE boundary a post crosses into the system:
 * - M5: visibility must be one of the four tiers; a location may be attached
 *   ONLY to nearby/public posts, is REQUIRED to be coarse-shaped, and the
 *   stored cell is ALWAYS server-derived (a precise fix is refused loudly).
 * - A3: an age/gender field is structurally unsupported; engagement-counter
 *   fields are refused the same way.
 * - M4: the reaction registry is closed; comments carry parentId only.
 * The moderation machine (visible→reported→limited→removed) is a closed table.
 */

import {
  MomentsError, preciseLocationRefused, locationTierRefused, unsupportedField, unknownReaction, illegalTransition,
} from './moments.errors';

export type MomentVisibility = 'private' | 'friends' | 'nearby' | 'public';
export type MomentModerationState = 'visible' | 'reported' | 'limited' | 'removed';

export const MOMENT_REACTIONS = ['like', 'love', 'laugh', 'wow', 'support'] as const;
export type MomentReaction = (typeof MOMENT_REACTIONS)[number];

/** The closed audience set. Exported so the create path and the change-audience
 *  path cannot drift into accepting different values. */
export const VISIBILITIES: readonly MomentVisibility[] = ['private', 'friends', 'nearby', 'public'];
const KINDS = ['photo', 'video', 'text'] as const;
const MAX_TEXT = 4000;
const MAX_COMMENT = 1000;

/** Fields that must NEVER appear on any moments input (A3 + no counters). */
const FORBIDDEN_FIELDS = ['age', 'gender', 'sex', 'birthdate', 'viewCount', 'likeCount', 'shareCount', 'priceAmount'];

/** Allow-listed input keys — anything else is refused (unknown = hostile). */
const ALLOWED_KEYS = new Set(['kind', 'text', 'mediaIds', 'visibility', 'location', 'expectedVersion']);

const COORD_PRECISE = /-?\d{1,3}\.\d{4,}/;

export interface ValidatedMomentInput {
  authorId: string;
  kind: (typeof KINDS)[number];
  text: string | null;
  mediaIds: string[];
  visibility: MomentVisibility;
  coarseLat: number | null;
  coarseLon: number | null;
  coarseCell: string | null;
  cityCell: string | null;
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const round1 = (v: number) => Math.round(v * 10) / 10;

export function validateMomentInput(authorId: string, body: Record<string, unknown>): ValidatedMomentInput {
  for (const f of FORBIDDEN_FIELDS) if (f in body) throw unsupportedField(f);
  for (const k of Object.keys(body)) if (!ALLOWED_KEYS.has(k)) throw unsupportedField(k);

  const kind = body.kind as string;
  if (!KINDS.includes(kind as never)) throw new MomentsError('MALFORMED_MOMENT', 'kind must be photo|video|text', false, 'fix kind');
  const visibility = body.visibility as MomentVisibility;
  if (!VISIBILITIES.includes(visibility)) throw new MomentsError('MALFORMED_MOMENT', 'visibility must be private|friends|nearby|public', false, 'fix visibility');

  const text = typeof body.text === 'string' && body.text.trim() ? body.text.trim().slice(0, MAX_TEXT) : null;
  const mediaIds = Array.isArray(body.mediaIds) ? (body.mediaIds as unknown[]).filter((m): m is string => typeof m === 'string').slice(0, 10) : [];
  if (kind !== 'text' && mediaIds.length === 0) throw new MomentsError('MALFORMED_MOMENT', `${kind} moments need media`, false, 'attach media or use kind=text');
  if (kind === 'text' && !text) throw new MomentsError('MALFORMED_MOMENT', 'text moments need text', false, 'add text');

  // M5: location handling. Only nearby/public may attach; coarse shape only.
  let coarseLat: number | null = null;
  let coarseLon: number | null = null;
  let coarseCell: string | null = null;
  let cityCell: string | null = null;
  if (body.location != null) {
    if (visibility === 'private' || visibility === 'friends') throw locationTierRefused();
    const loc = body.location as Record<string, unknown>;
    // A precise GeolocationCoordinates shape (accuracy et al.) is refused.
    for (const k of ['accuracy', 'altitude', 'heading', 'speed', 'altitudeAccuracy']) {
      if (k in loc) throw preciseLocationRefused();
    }
    const lat = typeof loc.lat === 'number' ? loc.lat : NaN;
    const lon = typeof loc.lon === 'number' ? loc.lon : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      throw new MomentsError('MALFORMED_MOMENT', 'location must be {lat, lon} on the coarse grid', false, 'send the coarse contract');
    }
    // A precise-resolution value (4+ decimals) is a precise fix — refused, not rounded.
    if (COORD_PRECISE.test(String(lat)) || COORD_PRECISE.test(String(lon))) throw preciseLocationRefused();
    // A client cell is never trusted: a precise-shaped cell is refused; the
    // stored cell is ALWAYS server-derived from the coarse point.
    if (typeof loc.cell === 'string' && COORD_PRECISE.test(loc.cell)) throw preciseLocationRefused();
    coarseLat = round3(lat);
    coarseLon = round3(lon);
    coarseCell = `g${coarseLat.toFixed(3)}:${coarseLon.toFixed(3)}`;
    cityCell = `c${round1(lat).toFixed(1)}:${round1(lon).toFixed(1)}`; // ~11 km, never finer
  }

  return { authorId, kind: kind as never, text, mediaIds, visibility, coarseLat, coarseLon, coarseCell, cityCell };
}

export function assertReaction(r: string): asserts r is MomentReaction {
  if (!MOMENT_REACTIONS.includes(r as never)) throw unknownReaction(r);
}

export function validateCommentText(text: unknown): string {
  const t = typeof text === 'string' ? text.trim() : '';
  if (!t) throw new MomentsError('MALFORMED_MOMENT', 'comment text required', false, 'add text');
  return t.slice(0, MAX_COMMENT);
}

/* ---------------------------------------------- moderation machine (closed) */

export const MODERATION_TRANSITIONS: Record<MomentModerationState, readonly MomentModerationState[]> = {
  visible: ['reported', 'limited', 'removed'],
  reported: ['visible', 'limited', 'removed'],
  limited: ['visible', 'removed'],
  removed: [], // terminal
};

export function assertModerationTransition(from: MomentModerationState, to: MomentModerationState): void {
  if (!MODERATION_TRANSITIONS[from]?.includes(to)) throw illegalTransition(from, to);
}

/* -------------------------------------------------- story lifecycle (M3) */

export type MomentStoryState = 'active' | 'expired' | 'deleted' | 'archived' | 'hidden' | 'moderation-hidden';

export const STORY_TRANSITIONS: Record<MomentStoryState, readonly MomentStoryState[]> = {
  active: ['expired', 'deleted', 'archived', 'hidden', 'moderation-hidden'],
  hidden: ['active', 'deleted', 'archived'],
  archived: ['deleted'],
  'moderation-hidden': ['deleted'], // only deletion; un-hiding is a moderation decision seam
  expired: ['deleted', 'archived'],
  deleted: [], // terminal
};

export function assertStoryTransition(from: MomentStoryState, to: MomentStoryState): void {
  if (!STORY_TRANSITIONS[from]?.includes(to)) throw illegalTransition(from, to);
}

/** 24h [PROPOSED] story lifetime. */
export const STORY_TTL_MS = 24 * 60 * 60 * 1000;
