/**
 * Assistant application layer (Phase 6D) — framework-free, behind ports.
 *
 * PRIVACY BOUNDARY (X9 + the standing coarsening bar): the precise device fix
 * exists only inside `coarseOrigin()` local scope and is converted through
 * `coarsenForPublic` (the single brand-cast site) BEFORE anything outbound.
 * The query text lives in exactly one field here, goes ONLY to the API port's
 * query payload, and is never logged, cached, or attached to an error — the
 * mutation battery drives this with markers and scans every surface.
 */

import { coarsenForPublic } from '../discovery/coarsen';
import type { GeolocationPort } from '../discovery/ports';
import type { CoarsePublicLocation, ReviewIntelligence, RouteAdvice } from '@spotme/contracts';
import type { AssistantApiPort, AssistantResponseView, VoiceInputPort } from './ports';

export type AssistantUiState =
  | { kind: 'idle' }
  | { kind: 'asking' }
  | { kind: 'answered'; response: AssistantResponseView }
  | { kind: 'failed'; message: string };

export class AssistantController {
  private state_: AssistantUiState = { kind: 'idle' };
  private listeners = new Set<() => void>();

  queryText = '';
  review: ReviewIntelligence | null = null;
  route: RouteAdvice | null = null;

  constructor(private readonly deps: {
    api: AssistantApiPort;
    geo: GeolocationPort;
    voice: VoiceInputPort;
    selfId: string;
  }) {}

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getState = (): AssistantUiState => this.state_;
  private set(s: AssistantUiState) { this.state_ = s; for (const cb of this.listeners) cb(); }
  private notify() { for (const cb of this.listeners) cb(); }

  get voiceState(): VoiceInputPort { return this.deps.voice; }

  /** The single origin path — precise fix in local scope only. */
  private async coarseOrigin(): Promise<CoarsePublicLocation | null> {
    const loc = await this.deps.geo.getFix();
    if (loc.state !== 'ok') return null;
    return coarsenForPublic(loc.fix, this.deps.selfId); // THE BOUNDARY
  }

  async ask(): Promise<void> {
    const text = this.queryText.trim();
    if (!text) return;
    this.set({ kind: 'asking' });
    this.review = null;
    this.route = null;
    try {
      const origin = await this.coarseOrigin();
      const response = await this.deps.api.query({ text, origin });
      this.set({ kind: 'answered', response });
    } catch {
      // No error detail is surfaced — a raw message could echo the query.
      this.set({ kind: 'failed', message: 'The assistant could not answer. Try again.' });
    }
  }

  async loadReview(subjectRef: string): Promise<void> {
    try { this.review = await this.deps.api.reviewIntelligence(subjectRef); } catch { this.review = null; }
    this.notify();
  }

  async loadRoute(destinationRef: string): Promise<void> {
    try {
      const origin = await this.coarseOrigin();
      this.route = await this.deps.api.routeAdvice(destinationRef, origin);
    } catch {
      this.route = { kind: 'unavailable', reason: 'error' };
    }
    this.notify();
  }

  clear(): void {
    this.queryText = '';
    this.review = null;
    this.route = null;
    this.set({ kind: 'idle' });
  }
}
