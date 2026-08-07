/**
 * Deterministic fixture Moments API + camera-roll (Phase 5D) — the only
 * adapters this phase. No network. Records everything that "left" through the
 * port for the privacy mutation battery.
 */

import type {
  MomentsApiPort, CameraRollPort, MomentPageView, MomentView, StoryView,
  ComposeMomentInput, MomentReaction, PickedMedia, MomentFeedMode,
} from './ports';
import type { CoarsePublicLocation } from '@spotme/contracts';

export class FixtureMomentsApi implements MomentsApiPort {
  readonly outbound: string[] = [];
  offline = false;
  unavailable = false;

  private record(op: string, payload: unknown) {
    this.outbound.push(JSON.stringify({ op, payload }));
    if (this.offline) throw new TypeError('network request failed');
  }

  async feed(input: { mode: MomentFeedMode; origin: CoarsePublicLocation | null; cursor?: string | null; order?: 'chronological' | 'ranked' }): Promise<MomentPageView> {
    this.record('feed', input);
    if (this.unavailable) return { results: [], cursor: null, state: 'unavailable' };
    return { results: [this.moment('fx-m1'), this.moment('fx-m2', { text: 'Check https://evil.example/claim-prize now!!', kind: 'text', media: [] })], cursor: null, state: 'ok' };
  }

  async compose(input: ComposeMomentInput): Promise<MomentView> {
    this.record('compose', input);
    return this.moment('fx-new', { text: input.text ?? null, kind: input.kind });
  }

  async react(momentId: string, reaction: MomentReaction | null): Promise<void> { this.record('react', { momentId, reaction }); }
  async comment(momentId: string, text: string, parentId: string | null): Promise<{ id: string }> {
    this.record('comment', { momentId, text, parentId });
    return { id: 'fx-c1' };
  }
  async comments(momentId: string) {
    this.record('comments', { momentId });
    return [
      { id: 'fx-c1', parentId: null, author: { userId: 'u2', displayName: 'Ravi' }, text: 'Nice!' },
      { id: 'fx-c2', parentId: 'fx-c1', author: { userId: 'u3', displayName: 'Meera' }, text: 'Agreed' },
    ];
  }
  async report(input: { targetKind: string; targetId: string; reason: string }): Promise<void> { this.record('report', input); }
  async block(userId: string): Promise<void> { this.record('block', { userId }); }
  async hide(momentId: string): Promise<void> { this.record('hide', { momentId }); }
  async storyRail(): Promise<StoryView[]> {
    this.record('storyRail', {});
    return [{ id: 'fx-s1', author: { userId: 'u2', displayName: 'Ravi' }, thumbnailUrl: 'fixture://thumb/s1', expiresAtUTC: 1_900_000_000_000 }];
  }

  private moment(id: string, over: Partial<MomentView> = {}): MomentView {
    return {
      id, author: { userId: 'u2', displayName: 'Ravi', distanceBand: 'under1km' }, kind: 'photo',
      text: 'Sunset from the rooftop', media: [{ mediaId: 'fx-a1', kind: 'image', alt: 'Rooftop sunset photo', thumbnailUrl: 'fixture://thumb/a1' }],
      visibility: 'nearby', coarseCellLabel: 'g12.972:77.595', createdAtUTC: 1_899_990_000_000,
      myReaction: null, ranking: null, ...over,
    };
  }
}

export class FixtureCameraRoll implements CameraRollPort {
  async pick(): Promise<PickedMedia | null> {
    return { mediaId: 'fx-picked-1', kind: 'image', name: 'IMG_0001.jpg' };
  }
}
