/**
 * Live Nearby Events application layer (Phase 4C) — a framework-free state
 * machine behind ports. Components render its state and call its methods;
 * NOTHING here touches the network, geolocation, or storage directly.
 *
 * PRIVACY BOUNDARY: the precise device fix exists only inside `browse`'s local
 * scope; it is converted through `coarsenForPublic` (the discovery boundary —
 * the single brand-cast site in the client) BEFORE anything outbound. The
 * mutation tests prove raw coordinates never appear in request bodies, logs,
 * cache, or serialized state.
 */

import { coarsenForPublic } from '../discovery/coarsen';
import type { GeolocationPort } from '../discovery/ports';
import type { EventsApiPort, EventPage, EventView } from './ports';

export type EventsState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'permission-required' }
  | { kind: 'location-unavailable'; reason: string }
  | { kind: 'browsing'; page: EventPage }
  | { kind: 'detail'; event: EventView }
  | { kind: 'empty' }
  | { kind: 'unavailable' }
  | { kind: 'offline' }
  | { kind: 'failed'; message: string };

export interface EventsControllerDeps {
  api: EventsApiPort;
  geo: GeolocationPort;
  selfId: string;
}

export class EventsController {
  private state_: EventsState = { kind: 'idle' };
  private listeners = new Set<() => void>();
  category: string | undefined = undefined;
  actionError: string | null = null;

  constructor(private readonly deps: EventsControllerDeps) {}

  subscribe = (cb: () => void) => { this.listeners.add(cb); return () => this.listeners.delete(cb); };
  getState = (): EventsState => this.state_;
  private set(s: EventsState) { this.state_ = s; for (const cb of this.listeners) cb(); }
  private notify() { for (const cb of this.listeners) cb(); }

  /** Browse nearby events. Precise fix → coarse contract before outbound. */
  async browse(opts: { category?: string; cursor?: string | null } = {}): Promise<void> {
    this.actionError = null;
    this.set({ kind: 'locating' });
    const loc = await this.deps.geo.getFix();
    if (loc.state === 'permission-required') return this.set({ kind: 'permission-required' });
    if (loc.state === 'unavailable') return this.set({ kind: 'location-unavailable', reason: loc.reason });

    // THE BOUNDARY: precise fix → coarse contract, before anything outbound.
    const origin = coarsenForPublic(loc.fix, this.deps.selfId);
    try {
      const page = await this.deps.api.browseNearby({ origin, category: opts.category ?? this.category, cursor: opts.cursor ?? null });
      if (page.state === 'unavailable') return this.set({ kind: 'unavailable' });
      if (page.results.length === 0) return this.set({ kind: 'empty' });
      this.set({ kind: 'browsing', page });
    } catch (e) {
      this.set(this.normalizeError(e));
    }
  }

  async openDetail(id: string): Promise<void> {
    this.actionError = null;
    try {
      const event = await this.deps.api.getById(id);
      if (!event) return this.set({ kind: 'failed', message: 'That event is no longer available.' });
      this.set({ kind: 'detail', event });
    } catch (e) { this.set(this.normalizeError(e)); }
  }

  /** Save/unsave an event. Best-effort; reflects into the current list/detail. */
  async toggleSave(id: string): Promise<void> {
    this.actionError = null;
    const target = this.findEvent(id);
    const nextSaved = !(target?.saved ?? false);
    try {
      if (nextSaved) await this.deps.api.save(id); else await this.deps.api.unsave(id);
      this.applySaved(id, nextSaved);
    } catch (e) {
      this.actionError = this.messageOf(e);
      this.notify();
    }
  }

  private findEvent(id: string): EventView | undefined {
    if (this.state_.kind === 'browsing') return this.state_.page.results.find((e) => e.id === id);
    if (this.state_.kind === 'detail' && this.state_.event.id === id) return this.state_.event;
    return undefined;
  }
  private applySaved(id: string, saved: boolean) {
    if (this.state_.kind === 'browsing') {
      const results = this.state_.page.results.map((e) => (e.id === id ? { ...e, saved } : e));
      this.set({ kind: 'browsing', page: { ...this.state_.page, results } });
    } else if (this.state_.kind === 'detail' && this.state_.event.id === id) {
      this.set({ kind: 'detail', event: { ...this.state_.event, saved } });
    }
  }

  private normalizeError(e: unknown): EventsState {
    const err = e as { name?: string; message?: string };
    if (err?.name === 'TypeError' || /network|fetch/i.test(String(err?.message))) return { kind: 'offline' };
    return { kind: 'failed', message: this.messageOf(e) };
  }
  private messageOf(e: unknown): string {
    const err = e as { message?: string };
    return typeof err?.message === 'string' && err.message ? err.message : 'Something went wrong. Please try again.';
  }
}
