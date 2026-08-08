/**
 * Deterministic fixture Events API (Phase 4C) — the only EventsApiPort this
 * phase. No network. Records everything that "left" through the port for the
 * privacy mutation battery.
 */

import type { EventsApiPort, EventsBrowseInput, EventPage, EventView } from './ports';

export class FixtureEventsApi implements EventsApiPort {
  readonly outbound: string[] = [];
  offline = false;
  unavailable = false;
  private saved = new Set<string>();

  private record(op: string, payload: unknown) {
    this.outbound.push(JSON.stringify({ op, payload }));
    if (this.offline) throw new TypeError('network request failed');
  }

  async browseNearby(input: EventsBrowseInput): Promise<EventPage> {
    this.record('browseNearby', input);
    if (this.unavailable) return { results: [], cursor: null, state: 'unavailable' };
    return { results: [this.eventFixture('fixture:e1'), this.eventFixture('fixture:e2', 'cancelled')], cursor: null, state: 'ok' };
  }

  async getById(id: string): Promise<EventView | null> {
    this.record('getById', { id });
    return this.eventFixture(id);
  }

  async save(id: string): Promise<void> { this.record('save', { id }); this.saved.add(id); }
  async unsave(id: string): Promise<void> { this.record('unsave', { id }); this.saved.delete(id); }

  private eventFixture(id: string, state: EventView['state'] = 'happening-now'): EventView {
    return {
      id,
      category: 'music',
      title: 'Rooftop set',
      description: 'Live music tonight',
      time: { startUTC: 1_900_000_000_000, endUTC: 1_900_010_800_000, timezone: 'Asia/Kolkata', allDay: false },
      state,
      venue: { lat: 12.972, lon: 77.595, cell: 'g12.972:77.595' },
      distanceBand: 'under1km',
      popularity: state === 'cancelled' ? null : 0.6,
      source: {
        provider: 'fixture', sourceName: 'Acme Listings', url: 'https://example.test/e', confidence: 0.9,
        provenance: state === 'cancelled' ? { lifecycle: 'cancelled', assertedBy: 'Acme Listings', note: 'Venue closed' } : null,
      },
      ranking: {
        components: [
          { signal: 'time', weight: 0.4, value: 1, weighted: 0.4 },
          { signal: 'distance', weight: 0.3, value: 0.8, weighted: 0.24 },
          { signal: 'relevance', weight: 0.2, value: 0.5, weighted: 0.1 },
          ...(state === 'cancelled' ? [] : [{ signal: 'popularity' as const, weight: 0.1, value: 0.6, weighted: 0.06 }]),
        ],
        omittedSignals: state === 'cancelled' ? ['popularity' as const] : [],
        total: state === 'cancelled' ? 0.74 : 0.8,
      },
      saved: this.saved.has(id),
    };
  }
}
