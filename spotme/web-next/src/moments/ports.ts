/**
 * Nearby Moments client ports (Phase 5D). Fixture/disabled adapters only. The
 * precise device fix exists only behind GeolocationPort; the controller
 * converts it to the branded coarse contract before ANY outbound call.
 *
 * CameraPort (M1) is an INTERFACE ONLY: it names the seam a future
 * owner-authorized wiring PR would implement against the frozen camera engine.
 * NOTHING here imports from any camera branch; there is no flag and no
 * activation path — the composer uses the camera-roll FIXTURE this phase.
 */

import type { CoarsePublicLocation } from '@spotme/contracts';
import type { DeviceFix, GeolocationPort } from '../discovery/ports';

export type { DeviceFix, GeolocationPort };

export type MomentVisibility = 'private' | 'friends' | 'nearby' | 'public';
export type MomentFeedMode = 'nearby' | 'friends' | 'city';
export type MomentReaction = 'like' | 'love' | 'laugh' | 'wow' | 'support';
export const MOMENT_REACTIONS: readonly MomentReaction[] = ['like', 'love', 'laugh', 'wow', 'support'];

export interface MomentAuthorView { userId: string; displayName: string; distanceBand?: string }
export interface MomentMediaView { mediaId: string; kind: 'image' | 'video'; alt: string; thumbnailUrl: string }

export interface MomentView {
  id: string;
  author: MomentAuthorView;
  kind: 'photo' | 'video' | 'text';
  text: string | null;
  media: MomentMediaView[];
  visibility: Exclude<MomentVisibility, 'private'>;
  /** Coarse cell label only, when the poster attached one. */
  coarseCellLabel: string | null;
  createdAtUTC: number;
  myReaction: MomentReaction | null;
  /** Ranked mode only; null in the chronological default. */
  ranking: { components: { signal: string; weight: number; value: number; weighted: number }[]; omittedSignals: string[]; total: number } | null;
}

export interface StoryView {
  id: string;
  author: MomentAuthorView;
  thumbnailUrl: string;
  expiresAtUTC: number;
}

export interface MomentPageView {
  results: MomentView[];
  cursor: string | null;
  state: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';
}

export interface ComposeMomentInput {
  kind: 'photo' | 'video' | 'text';
  text?: string;
  mediaIds: string[];
  visibility: MomentVisibility;
  /** Already-coarse, poster-confirmed attach (nearby/public only). */
  location?: CoarsePublicLocation;
}

export interface MomentsApiPort {
  feed(input: { mode: MomentFeedMode; origin: CoarsePublicLocation | null; cursor?: string | null; order?: 'chronological' | 'ranked' }): Promise<MomentPageView>;
  compose(input: ComposeMomentInput): Promise<MomentView>;
  react(momentId: string, reaction: MomentReaction | null): Promise<void>;
  comment(momentId: string, text: string, parentId: string | null): Promise<{ id: string }>;
  comments(momentId: string): Promise<{ id: string; parentId: string | null; author: MomentAuthorView; text: string }[]>;
  report(input: { targetKind: 'moment' | 'comment' | 'story'; targetId: string; reason: string }): Promise<void>;
  block(userId: string): Promise<void>;
  hide(momentId: string): Promise<void>;
  storyRail(): Promise<StoryView[]>;
}

/* --------------------------------------------------------- camera-roll port */

/** A picked media item from the device library (FIXTURE this phase). */
export interface PickedMedia { mediaId: string; kind: 'image' | 'video'; name: string }

export interface CameraRollPort {
  pick(): Promise<PickedMedia | null>;
}

/* ------------------------------------------------------- CameraPort (M1) */

/**
 * The live-capture seam — INTERFACE ONLY. A future owner-authorized change may
 * implement it against the frozen camera engine (#56 stack); this phase ships
 * NO implementation, NO import from any camera branch, NO flag. The composer
 * offers library picking (CameraRollPort fixture) only.
 */
export interface CameraPort {
  capturePhoto(): Promise<{ state: 'captured'; media: PickedMedia } | { state: 'unavailable'; reason: string }>;
  captureVideo(): Promise<{ state: 'captured'; media: PickedMedia } | { state: 'unavailable'; reason: string }>;
}
