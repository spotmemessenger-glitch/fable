/**
 * Live Nearby Events — orchestration service (Phase 4B). DARK: reachable only
 * from EventsModule, which AppModule does not import.
 *
 * Ingest pipeline (ports #61 `search.js`, server-side): fetch candidates from
 * each provider → normalize (coarsen venue, mint bounded popularity, whitelist)
 * → dedup conservatively → derive state at `now` → prune expired → safety/block
 * → persist (upsert + projection + dedup decisions). With NO provider the honest
 * result is `unavailable` — never invented events.
 *
 * Browse reads the persisted, canonical, live rows in keyset order with a coarse
 * distance band. Ranking is applied by the 4C engine; 4B returns keyset order.
 */

import { Inject, Injectable } from '@nestjs/common';
import { EVENTS_REPOSITORY, EventsRepository, NearbyEventsQuery } from './events.repository';
import { EVENT_PROVIDERS, EventProvider, isValidEventProvider, assertNoSecrets } from './events.provider';
import { normalizeEvent } from './events.normalize';
import { dedupeEvents } from './events.dedup';
import { withState, pruneStaleEvents } from './events.time';
import { filterForSafety, assertNoOriginLeak, EventSafetyOptions } from './events.safety';
import { encodeCursor, decodeCursor, EventDecodedCursor } from './events.cursor';
import type { EventRow, EventSearchState, StatedEvent } from './events.types';

export interface EventsQueryInput {
  origin: { lat: number; lon: number };
  radiusKm?: number;
  category?: string;
  text?: string;
  cursor?: string | null;
}

export interface IngestSummary {
  state: EventSearchState;
  fetched: number;
  canonical: number;
  written: number;
  providerErrors: number;
}

export interface BrowsePage {
  results: EventRow[];
  cursor: string | null;
  state: EventSearchState;
}

const DEFAULT_RADIUS_KM = 10;
const MAX_RADIUS_KM = 100;
const PAGE_LIMIT = 25;

@Injectable()
export class EventsService {
  constructor(
    @Inject(EVENTS_REPOSITORY) private readonly repo: EventsRepository,
    @Inject(EVENT_PROVIDERS) private readonly providers: EventProvider[],
  ) {}

  private validProviders(): EventProvider[] {
    return (this.providers || []).filter((p) => {
      if (!isValidEventProvider(p)) return false;
      assertNoSecrets(p);
      return true;
    });
  }

  /** Fetch from providers, normalize/dedup/prune/safety, and persist. */
  async ingestNearby(input: EventsQueryInput, opts: { now: number } & EventSafetyOptions): Promise<IngestSummary> {
    const providers = this.validProviders();
    const now = opts.now;
    const radiusKm = Math.min(MAX_RADIUS_KM, Math.max(1, input.radiusKm ?? DEFAULT_RADIUS_KM));
    if (providers.length === 0) {
      return { state: 'unavailable', fetched: 0, canonical: 0, written: 0, providerErrors: 0 };
    }
    let providerErrors = 0;
    const raw: StatedEvent[] = [];
    const collected = await Promise.all(providers.map(async (p) => {
      try {
        const cands = await p.searchEvents({ text: input.text, category: input.category }, { origin: input.origin, radiusKm, now });
        return (Array.isArray(cands) ? cands : [])
          .map((c) => normalizeEvent(c, p.name, { fetchedAtUTC: now }))
          .filter((e): e is NonNullable<typeof e> => Boolean(e));
      } catch {
        providerErrors += 1;
        return [];
      }
    }));
    const normalized = collected.flat();
    const fetched = normalized.length;

    // Dedup → derive state → prune expired → safety/block.
    const { canonical, decisions } = dedupeEvents(normalized);
    const stated = canonical.map((e) => withState(e, now));
    const fresh = pruneStaleEvents(stated, now);
    const safe = filterForSafety(fresh, { isBlocked: opts.isBlocked, allowRestricted: opts.allowRestricted });

    // Privacy fence: the origin must never appear on a record before persistence.
    assertNoOriginLeak(safe as unknown as Array<Record<string, unknown>>, input.origin);

    const { written } = await this.repo.upsertBatch(safe as StatedEvent[], decisions, now);

    let state: EventSearchState = 'ok';
    if (providerErrors >= providers.length && written === 0) state = 'failed';
    else if (written === 0) state = 'empty';
    else if (providerErrors > 0) state = 'partial';
    return { state, fetched, canonical: canonical.length, written, providerErrors };
  }

  /** Browse persisted nearby events (keyset order). Ranking is applied in 4C. */
  async browse(input: EventsQueryInput, now: number): Promise<BrowsePage> {
    const radiusKm = Math.min(MAX_RADIUS_KM, Math.max(1, input.radiusKm ?? DEFAULT_RADIUS_KM));
    let cursor: EventDecodedCursor | null = null;
    if (input.cursor) cursor = decodeCursor(input.cursor);
    const q: NearbyEventsQuery = {
      origin: input.origin, radiusKm, category: input.category, now, limit: PAGE_LIMIT, cursor,
    };
    const rows = await this.repo.findNearby(q);
    assertNoOriginLeak(rows as unknown as Array<Record<string, unknown>>, input.origin);
    let next: string | null = null;
    if (rows.length === PAGE_LIMIT) {
      const last = rows[rows.length - 1];
      next = encodeCursor({ t: last.startUTC ?? 0, i: last.id, depth: (cursor?.depth ?? 0) + 1 });
    }
    return { results: rows, cursor: next, state: rows.length === 0 ? 'empty' : 'ok' };
  }

  async getById(id: string): Promise<EventRow | null> {
    return this.repo.findById(id);
  }
}
