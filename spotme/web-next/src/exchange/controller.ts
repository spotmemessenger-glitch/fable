/**
 * Exchange application layer (Phase 3D) — a framework-free state machine behind
 * ports. Components render its state and call its methods; NOTHING here touches
 * the network, geolocation, storage, or a socket directly — only injected ports.
 *
 * PRIVACY BOUNDARY: the precise device fix exists only inside `compose`'s local
 * scope; it is converted through `coarsenForPublic` (the discovery boundary —
 * the single brand-cast site in the client) BEFORE anything outbound. The
 * mutation tests prove raw coordinates never appear in request bodies, logs,
 * cache, or serialized state. Contact is CONSENT-GATED: chat is only ever
 * reachable after an explicit accept — the controller never auto-opens one.
 */

import { coarsenForPublic } from '../discovery/coarsen';
import type { ClockPort, GeolocationPort } from '../discovery/ports';
import type {
  ComposeIntentInput,
  ExchangeApiPort,
  ExchangeIntentView,
  ExchangeMatchView,
  ExchangePage,
} from './ports';

export type ExchangeState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'permission-required' }
  | { kind: 'location-unavailable'; reason: string }
  | { kind: 'composing' }
  | { kind: 'submitting' }
  | { kind: 'published'; intent: ExchangeIntentView }
  | { kind: 'browsing'; page: ExchangePage<ExchangeIntentView> }
  | { kind: 'matches'; intentId: string; page: ExchangePage<ExchangeMatchView> }
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

export interface ExchangeControllerDeps {
  api: ExchangeApiPort;
  geo: GeolocationPort;
  clock: ClockPort;
  selfId: string;
}

export class ExchangeController {
  private state_: ExchangeState = { kind: 'idle' };
  private listeners = new Set<() => void>();
  /** Draft form fields — mutable UI state, mirrored to subscribers via bump. */
  draft: Partial<ComposeIntentInput> = { kind: 'need', visibility: 'discoverable', radiusKm: 5, availability: { state: 'unknown' } };
  actionError: string | null = null;

  constructor(private readonly deps: ExchangeControllerDeps) {}

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getState = (): ExchangeState => this.state_;
  private set(s: ExchangeState) { this.state_ = s; for (const cb of this.listeners) cb(); }
  private notify() { for (const cb of this.listeners) cb(); }

  /** Publish the current draft. Precise fix → coarse contract before outbound. */
  async publish(): Promise<void> {
    this.actionError = null;
    const d = this.draft;
    if (!d.kind || !d.category || !d.title || !d.text) {
      this.actionError = 'Please fill in kind, category, title and description.';
      return this.notify();
    }
    this.set({ kind: 'locating' });
    const loc = await this.deps.geo.getFix();
    if (loc.state === 'permission-required') return this.set({ kind: 'permission-required' });
    if (loc.state === 'unavailable') return this.set({ kind: 'location-unavailable', reason: loc.reason });

    // THE BOUNDARY: precise fix → coarse contract, before anything outbound.
    const coarse = coarsenForPublic(loc.fix, this.deps.selfId);
    const input: ComposeIntentInput = {
      kind: d.kind, category: d.category, title: d.title, text: d.text,
      tags: d.tags ?? [], budgetBand: d.budgetBand, informationalPrice: d.informationalPrice,
      availability: d.availability ?? { state: 'unknown' },
      origin: { lat: coarse.lat, lon: coarse.lon, cell: coarse.cell },
      radiusKm: d.radiusKm ?? 5, visibility: d.visibility ?? 'discoverable',
      idempotencyKey: `${this.deps.selfId}:${this.deps.clock.now()}`,
    };
    this.set({ kind: 'submitting' });
    try {
      const intent = await this.deps.api.compose(input);
      this.set({ kind: 'published', intent });
    } catch (e) {
      this.set(this.normalizeError(e));
    }
  }

  async browse(opts: { kind?: 'need' | 'offer' | 'service'; category?: string } = {}): Promise<void> {
    try {
      const page = await this.deps.api.browse({ ...opts, cursor: null });
      if (page.state === 'unavailable') return this.set({ kind: 'unavailable' });
      if (page.results.length === 0) return this.set({ kind: 'empty' });
      this.set({ kind: 'browsing', page });
    } catch (e) { this.set(this.normalizeError(e)); }
  }

  async openMatches(intentId: string): Promise<void> {
    try {
      const page = await this.deps.api.matchesFor(intentId);
      this.set({ kind: 'matches', intentId, page });
    } catch (e) { this.set(this.normalizeError(e)); }
  }

  /** Lifecycle actions (optimistic-concurrency version threaded from the view). */
  async transition(id: string, version: number, to: 'active' | 'paused' | 'withdrawn' | 'fulfilled'): Promise<void> {
    this.actionError = null;
    try {
      const intent = await this.deps.api.transition(id, version, to);
      this.set({ kind: 'published', intent });
    } catch (e) {
      this.actionError = this.messageOf(e);
      this.notify();
    }
  }

  /** CONSENT GATE: request contact on a match. Chat becomes available ONLY when
   *  the counterpart accepts — this method never opens a chat itself. */
  async requestContact(matchId: string): Promise<ExchangeMatchView | null> {
    this.actionError = null;
    try {
      const m = await this.deps.api.requestContact(matchId);
      if (this.state_.kind === 'matches') {
        const results = this.state_.page.results.map((r) => (r.id === matchId ? m : r));
        this.set({ kind: 'matches', intentId: this.state_.intentId, page: { ...this.state_.page, results } });
      }
      return m;
    } catch (e) {
      this.actionError = this.messageOf(e);
      this.notify();
      return null;
    }
  }

  async report(id: string, reason: string) { try { await this.deps.api.report(id, reason); } catch { /* dark: best-effort */ } }
  async block(ownerRef: string) { try { await this.deps.api.block(ownerRef); } catch { /* dark */ } }

  private normalizeError(e: unknown): ExchangeState {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'TypeError' || /network|fetch/i.test(String(err?.message))) return { kind: 'offline' };
    return { kind: 'failed', message: this.messageOf(e) };
  }
  private messageOf(e: unknown): string {
    const err = e as { message?: string };
    return typeof err?.message === 'string' && err.message ? err.message : 'Something went wrong. Please try again.';
  }
}
