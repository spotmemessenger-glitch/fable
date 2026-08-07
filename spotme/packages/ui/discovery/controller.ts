/**
 * Discovery application layer (checkpoint 11) — a framework-free state machine
 * behind ports. React components render its state and call its methods; no
 * component ever fetches, and NOTHING in this file touches the network,
 * geolocation, storage, or a socket directly — only the injected ports do.
 *
 * PRIVACY BOUNDARY: the precise device fix exists only inside `runSearch`'s
 * local scope (device-local memory); it is converted through
 * `coarsenForPublic` BEFORE anything outbound. The mutation tests prove raw
 * coordinates never appear in request bodies, URLs, logs, cache contents,
 * realtime events, or error objects.
 */

import type {
  CoarsePublicLocation,
  DiscoveryError,
  DiscoveryFilters,
  DiscoveryQuery,
  DiscoveryResult,
  DiscoveryResultPage,
  DiscoveryState,
} from '@spotme/contracts';
import type { ClockPort, DiscoveryApiPort, GeolocationPort, RealtimePort } from './ports';
import { coarsenForPublic } from './coarsen';

/** Injected cache — NO localStorage/sessionStorage in this layer (fence). */
export interface CachePort {
  get(key: string): DiscoveryResultPage | null;
  set(key: string, page: DiscoveryResultPage): void;
}

export class MemoryCache implements CachePort {
  private m = new Map<string, DiscoveryResultPage>();
  get(k: string) {
    return this.m.get(k) ?? null;
  }
  set(k: string, v: DiscoveryResultPage) {
    this.m.set(k, v);
  }
  /** Test hook: full contents for privacy scanning. */
  dump(): unknown {
    return [...this.m.entries()];
  }
}

export interface ControllerDeps {
  api: DiscoveryApiPort;
  geo: GeolocationPort;
  realtime: RealtimePort;
  clock: ClockPort;
  cache: CachePort;
  selfId: string;
  /** Radius policy: start small, expand once on empty — always disclosed. */
  radiusKm?: number;
  maxRadiusKm?: number;
}

export type Mode = 'map' | 'list' | 'split';

export class DiscoveryController {
  private state_: DiscoveryState = { kind: 'idle' };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private abort: AbortController | null = null;
  private hidden = new Set<string>();

  searchText = '';
  mode: Mode = 'split';
  filters: DiscoveryFilters = {};
  selectedId: string | null = null;
  visibilityEnabled = false;

  constructor(private readonly deps: ControllerDeps) {
    deps.realtime.onInvalidated(() => {
      // Server-side invalidation (blocks changed, deletion): drop stale UI state.
      if (this.state_.kind === 'ready') this.search();
    });
  }

  /* ------------------------------------------------------------ store API */
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getState = (): DiscoveryState => this.state_;

  private set(state: DiscoveryState): void {
    this.state_ = state;
    for (const cb of this.listeners) cb();
  }

  /* ------------------------------------------------------------ selection */
  select(id: string): void {
    this.selectedId = id;
    for (const cb of this.listeners) cb();
  }

  hide(id: string): void {
    this.hidden.add(id);
    // Apply to the visible page whether we are online (ready) or serving the
    // offline cache — hiding must take effect in both (F7-12).
    if (this.state_.kind === 'ready') {
      this.set({ kind: 'ready', page: this.stripHidden(this.state_.page) });
    } else if (this.state_.kind === 'offline' && this.state_.cached) {
      this.set({ kind: 'offline', cached: this.stripHidden(this.state_.cached) });
    }
  }

  private stripHidden(page: DiscoveryResultPage): DiscoveryResultPage {
    const results = page.results.filter((r) => !this.hidden.has(idOfResult(r)));
    return { ...page, results };
  }

  /* -------------------------------------------------------------- search */
  async search(): Promise<void> {
    const myEpoch = ++this.epoch;
    this.abort?.abort();
    const ctrl = new AbortController();
    this.abort = ctrl;

    this.set({ kind: 'locating' });
    const loc = await this.deps.geo.getFix();
    if (myEpoch !== this.epoch) return; // superseded while locating
    if (loc.state === 'permission-required') return this.set({ kind: 'permission-required' });
    if (loc.state === 'unavailable') return this.set({ kind: 'location-unavailable', reason: loc.reason });

    // THE BOUNDARY: precise fix → coarse contract, before anything outbound.
    const origin = coarsenForPublic(loc.fix, this.deps.selfId);

    const radius = this.deps.radiusKm ?? 2;
    await this.runQuery(myEpoch, ctrl, origin, radius, false);
  }

  private buildQuery(origin: CoarsePublicLocation, radiusKm: number, expanded: boolean): DiscoveryQuery {
    return {
      contractsVersion: 1,
      intent: { kind: 'people' },
      scope: 'mixed',
      origin,
      radius: { km: radiusKm, ...(expanded ? { expanded: true } : {}) },
      ...(Object.keys(this.filters).length ? { filters: this.filters } : {}),
      cursor: null,
    };
  }

  private async runQuery(
    myEpoch: number,
    ctrl: AbortController,
    origin: CoarsePublicLocation,
    radiusKm: number,
    expanded: boolean,
  ): Promise<void> {
    const query = this.buildQuery(origin, radiusKm, expanded);
    this.set({ kind: 'searching', query });
    try {
      const page = await this.deps.api.query(query, ctrl.signal);
      if (myEpoch !== this.epoch) {
        // Stale response: DROP SILENTLY. Setting any state here (even
        // 'superseded') would let an old search overwrite a newer one — the
        // newer epoch owns the state machine now.
        return;
      }
      const fresh = this.dropExpired(this.stripHidden(page));
      if (fresh.results.length === 0) {
        const max = this.deps.maxRadiusKm ?? 10;
        if (!expanded && radiusKm < max) {
          // Adaptive radius: ONE disclosed expansion, never silent.
          await this.runQuery(myEpoch, ctrl, origin, Math.min(radiusKm * 3, max), true);
          return;
        }
        this.set({ kind: 'empty', radius: { km: radiusKm, ...(expanded ? { expanded: true } : {}) }, suggestion: 'Try a different search or check back later.' });
        return;
      }
      this.deps.cache.set('last-page', fresh);
      this.set({ kind: 'ready', page: fresh });
    } catch (e) {
      if (myEpoch !== this.epoch) return; // aborted by a newer search
      this.set(this.normalizeError(e));
    }
  }

  /** Freshness: results past their expiry never render. */
  private dropExpired(page: DiscoveryResultPage): DiscoveryResultPage {
    const now = this.deps.clock.now();
    const results = page.results.filter((r) => {
      const f = r.type === 'place' ? r.place.freshness : r.person.freshness;
      return !f.expiresAt || Date.parse(f.expiresAt) > now;
    });
    return { ...page, results };
  }

  /** Error normalization: typed wire errors pass through; everything else
   *  becomes a normalized failure; network-shaped errors become offline. */
  private normalizeError(e: unknown): DiscoveryState {
    const err = e as { code?: string; message?: string; retryable?: boolean; nextStep?: string; name?: string };
    if (err?.name === 'TypeError' || /network|fetch/i.test(String(err?.message))) {
      // Re-filter the cached page for freshness AND hidden results before
      // re-serving it — a cached row that expired or was hidden since caching
      // must not reappear just because we went offline (F3/F7-12).
      const raw = this.deps.cache.get('last-page');
      const cached = raw ? this.dropExpired(this.stripHidden(raw)) : null;
      return { kind: 'offline', ...(cached ? { cached } : {}) };
    }
    const wire: DiscoveryError =
      typeof err?.code === 'string' && typeof err?.nextStep === 'string'
        ? { code: err.code, message: err.message ?? 'Request refused.', retryable: err.retryable === true, nextStep: err.nextStep }
        : { code: 'UNEXPECTED', message: 'Something went wrong while searching.', retryable: true, nextStep: 'Retry; if it persists, try again later.' };
    return { kind: 'failed', error: wire };
  }

  /* ----------------------------------------------------------- visibility */
  /** Visibility failure is surfaced HERE and NEVER overwrites the search state
   *  machine (F7-4): the two are independent writers, so a rejected visibility
   *  write leaves search results intact and reports via `visibilityError`. */
  visibilityError: string | null = null;

  async setVisibility(next: boolean): Promise<void> {
    this.visibilityError = null;
    try {
      let origin: CoarsePublicLocation | null = null;
      if (next) {
        const loc = await this.deps.geo.getFix();
        if (loc.state !== 'ok') {
          // A geo failure while enabling is a visibility problem, not a search
          // one — report it without touching the search state.
          this.visibilityError =
            loc.state === 'permission-required'
              ? 'Location permission is required to appear on the map.'
              : `Location unavailable${'reason' in loc && loc.reason ? `: ${loc.reason}` : ''}.`;
          for (const cb of this.listeners) cb();
          return;
        }
        origin = coarsenForPublic(loc.fix, this.deps.selfId);
      }
      const pref = await this.deps.api.setVisibility({ enabled: next, origin, expiresInMinutes: 30 });
      this.visibilityEnabled = pref.enabled;
    } catch {
      // Never leaves the toggle in a lying state: report and keep the old value.
      this.visibilityError = 'Could not update your visibility. Please try again.';
    }
    for (const cb of this.listeners) cb();
  }
}

export function idOfResult(r: DiscoveryResult): string {
  return r.type === 'place' ? r.place.placeId : r.person.userId;
}
