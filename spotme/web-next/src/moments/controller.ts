/**
 * Nearby Moments application layer (Phase 5D) — framework-free, behind ports
 * (M1: no timeline logic in components). PRIVACY BOUNDARY: the precise device
 * fix exists only inside `attachLocation`/`loadFeed` local scope and is
 * converted through `coarsenForPublic` (the single brand-cast site) BEFORE
 * anything outbound. A location attaches ONLY after the plain-language
 * explanation has been shown and the poster explicitly confirmed (M5), and
 * ONLY on nearby/public visibility.
 */

import { coarsenForPublic } from '../discovery/coarsen';
import type { GeolocationPort } from '../discovery/ports';
import type {
  MomentsApiPort, CameraRollPort, CameraPort, MomentFeedMode, MomentPageView, MomentVisibility,
  MomentReaction, StoryView, ComposeMomentInput, PickedMedia,
} from './ports';

export type MomentsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'feed'; mode: MomentFeedMode; page: MomentPageView }
  | { kind: 'permission-required' }
  | { kind: 'location-unavailable'; reason: string }
  | { kind: 'empty'; mode: MomentFeedMode }
  | { kind: 'unavailable' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

export interface ComposerDraft {
  kind: 'photo' | 'video' | 'text';
  text: string;
  media: PickedMedia[];
  visibility: MomentVisibility;
  /** M5: set ONLY via confirmLocationAttach after the explanation. */
  location: { lat: number; lon: number; cell?: string } | null;
  /** True while the plain-language explanation is being shown. */
  explainingLocation: boolean;
}

export class MomentsController {
  private state_: MomentsState = { kind: 'idle' };
  private listeners = new Set<() => void>();
  draft: ComposerDraft = { kind: 'text', text: '', media: [], visibility: 'friends', location: null, explainingLocation: false };
  stories: StoryView[] = [];
  actionError: string | null = null;

  constructor(private readonly deps: {
    api: MomentsApiPort;
    geo: GeolocationPort;
    cameraRoll: CameraRollPort;
    selfId: string;
    /** Camera Stage 1 C4: the CameraPort seam — OPTIONAL and defaulting to
     *  absent, so every existing composition stays gallery-only. When a
     *  future owner-authorized wiring registers the engine adapter, capture
     *  flows join the draft exactly like library picks: mediaId only —
     *  capture output has no location field (contract law), and the bytes
     *  meet the Phase 5B EXIF strip at upload like all media. */
    camera?: CameraPort;
  }) {}

  /** Live capture into the composer — honest no-op error while unwired. */
  async captureFromCamera(kind: 'photo' | 'video'): Promise<void> {
    this.actionError = null;
    const camera = this.deps.camera;
    if (!camera) {
      this.actionError = 'Camera capture is not available.';
      return this.notify();
    }
    const result = kind === 'photo' ? await camera.capturePhoto() : await camera.captureVideo();
    if (result.state !== 'captured') {
      this.actionError = 'Camera capture is not available.';
      return this.notify();
    }
    this.draft.media = [...this.draft.media, result.media];
    this.draft.kind = result.media.kind === 'video' ? 'video' : 'photo';
    this.notify();
  }

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getState = (): MomentsState => this.state_;
  private set(s: MomentsState) { this.state_ = s; for (const cb of this.listeners) cb(); }
  private notify() { for (const cb of this.listeners) cb(); }

  /* ------------------------------------------------------------- feed */

  async loadFeed(mode: MomentFeedMode, opts: { order?: 'chronological' | 'ranked'; cursor?: string | null } = {}): Promise<void> {
    this.set({ kind: 'loading' });
    let origin: ReturnType<typeof coarsenForPublic> | null = null;
    if (mode === 'nearby' || mode === 'city') {
      const loc = await this.deps.geo.getFix();
      if (loc.state === 'permission-required') return this.set({ kind: 'permission-required' });
      if (loc.state === 'unavailable') return this.set({ kind: 'location-unavailable', reason: loc.reason });
      origin = coarsenForPublic(loc.fix, this.deps.selfId); // THE BOUNDARY
    }
    try {
      const page = await this.deps.api.feed({ mode, origin, cursor: opts.cursor ?? null, order: opts.order ?? 'chronological' });
      if (page.state === 'unavailable') return this.set({ kind: 'unavailable' });
      if (page.results.length === 0) return this.set({ kind: 'empty', mode });
      this.set({ kind: 'feed', mode, page });
    } catch (e) {
      this.set(this.normalizeError(e));
    }
  }

  async loadStories(): Promise<void> {
    try { this.stories = await this.deps.api.storyRail(); this.notify(); } catch { /* rail is best-effort */ }
  }

  /* ------------------------------------------------------------- composer */

  async pickFromLibrary(): Promise<void> {
    const picked = await this.deps.cameraRoll.pick();
    if (picked) {
      this.draft.media = [...this.draft.media, picked];
      this.draft.kind = picked.kind === 'video' ? 'video' : 'photo';
      this.notify();
    }
  }

  setVisibility(v: MomentVisibility): void {
    this.draft.visibility = v;
    // M5: dropping below nearby removes any attached location.
    if (v === 'private' || v === 'friends') this.draft.location = null;
    this.notify();
  }

  /** Step 1: the poster asks to attach a location → show the explanation. */
  requestLocationAttach(): void {
    this.actionError = null;
    if (this.draft.visibility === 'private' || this.draft.visibility === 'friends') {
      this.actionError = 'Location can be attached only to Nearby or Public posts.';
      return this.notify();
    }
    this.draft.explainingLocation = true;
    this.notify();
  }

  /** Step 2: ONLY an explicit confirm (after the explanation) attaches — and
   *  what attaches is the COARSE projection, minted at the boundary. */
  async confirmLocationAttach(): Promise<void> {
    if (!this.draft.explainingLocation) {
      this.actionError = 'Location attach requires the explanation step first.';
      return this.notify();
    }
    const loc = await this.deps.geo.getFix();
    this.draft.explainingLocation = false;
    if (loc.state !== 'ok') {
      this.actionError = 'Location is unavailable right now.';
      return this.notify();
    }
    const coarse = coarsenForPublic(loc.fix, this.deps.selfId); // THE BOUNDARY
    this.draft.location = { lat: coarse.lat, lon: coarse.lon, cell: coarse.cell };
    this.notify();
  }

  cancelLocationAttach(): void {
    this.draft.explainingLocation = false;
    this.draft.location = null;
    this.notify();
  }

  async publish(): Promise<void> {
    this.actionError = null;
    const d = this.draft;
    if (d.kind === 'text' && !d.text.trim()) { this.actionError = 'Write something first.'; return this.notify(); }
    if (d.kind !== 'text' && d.media.length === 0) { this.actionError = 'Pick a photo or video first.'; return this.notify(); }
    const input: ComposeMomentInput = {
      kind: d.kind,
      ...(d.text.trim() ? { text: d.text.trim() } : {}),
      mediaIds: d.media.map((m) => m.mediaId),
      visibility: d.visibility,
      ...(d.location ? { location: d.location as ComposeMomentInput['location'] } : {}),
    };
    try {
      await this.deps.api.compose(input);
      this.draft = { kind: 'text', text: '', media: [], visibility: d.visibility, location: null, explainingLocation: false };
      this.notify();
    } catch (e) {
      this.set(this.normalizeError(e));
    }
  }

  /* ------------------------------------------------------------- social */

  async react(momentId: string, reaction: MomentReaction | null): Promise<void> {
    try {
      await this.deps.api.react(momentId, reaction);
      if (this.state_.kind === 'feed') {
        const results = this.state_.page.results.map((m) => (m.id === momentId ? { ...m, myReaction: reaction } : m));
        this.set({ ...this.state_, page: { ...this.state_.page, results } });
      }
    } catch (e) { this.actionError = this.messageOf(e); this.notify(); }
  }

  async comment(momentId: string, text: string, parentId: string | null): Promise<void> {
    try { await this.deps.api.comment(momentId, text, parentId); } catch (e) { this.actionError = this.messageOf(e); this.notify(); }
  }

  async report(targetKind: 'moment' | 'comment' | 'story', targetId: string, reason: string): Promise<void> {
    try { await this.deps.api.report({ targetKind, targetId, reason }); } catch { /* report is fire-and-forget */ }
  }

  async block(userId: string): Promise<void> {
    try {
      await this.deps.api.block(userId);
      if (this.state_.kind === 'feed') {
        const results = this.state_.page.results.filter((m) => m.author.userId !== userId);
        this.set({ ...this.state_, page: { ...this.state_.page, results } });
      }
    } catch (e) { this.actionError = this.messageOf(e); this.notify(); }
  }

  async hide(momentId: string): Promise<void> {
    try {
      await this.deps.api.hide(momentId);
      if (this.state_.kind === 'feed') {
        const results = this.state_.page.results.filter((m) => m.id !== momentId);
        this.set({ ...this.state_, page: { ...this.state_.page, results } });
      }
    } catch { /* best-effort */ }
  }

  private normalizeError(e: unknown): MomentsState {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'TypeError' || /network|fetch/i.test(String(err?.message))) return { kind: 'offline' };
    return { kind: 'failed', message: this.messageOf(e) };
  }
  private messageOf(e: unknown): string {
    const err = e as { message?: string };
    return typeof err?.message === 'string' && err.message ? err.message : 'Something went wrong. Please try again.';
  }
}
