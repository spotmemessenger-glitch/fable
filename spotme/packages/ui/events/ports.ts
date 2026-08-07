/**
 * Live Nearby Events client ports (Phase 4C). The controller composes these;
 * this phase ships only fixture/disabled adapters. No component fetches; only a
 * port could ever touch a network, and this phase none do. The precise device
 * fix exists only behind GeolocationPort and is converted to the branded coarse
 * contract before ANY outbound call (mutation tests prove it never escapes).
 */

import type { CoarsePublicLocation } from '@spotme/contracts';
import type { DeviceFix, GeolocationPort, ClockPort } from '../discovery/ports';

export type { DeviceFix, GeolocationPort, ClockPort };

export type EventState = 'upcoming' | 'happening-now' | 'ended' | 'cancelled' | 'postponed';

export interface EventRankingComponentView {
  signal: 'time' | 'distance' | 'relevance' | 'popularity';
  weight: number;
  value: number;
  weighted: number;
}
export interface EventRankingView {
  components: EventRankingComponentView[];
  omittedSignals: EventRankingComponentView['signal'][];
  total: number;
}

export interface EventSourceView {
  provider: string;
  sourceName: string | null;
  url: string | null;
  confidence: number | null;
  /** Present only when the source asserted a cancel/postpone. */
  provenance: { lifecycle: 'cancelled' | 'postponed'; assertedBy: string; note?: string } | null;
}

export interface EventView {
  id: string;
  category: string;
  title: string;
  description: string | null;
  time: { startUTC: number | null; endUTC: number | null; timezone: string | null; allDay: boolean; occurrenceId?: string };
  state: EventState;
  /** Coarse public venue point — never a precise fix. */
  venue: { lat: number; lon: number; cell: string };
  distanceBand: string | null;
  /** Sourced popularity 0..1, or null when unknown (shown as omitted). */
  popularity: number | null;
  source: EventSourceView;
  ranking: EventRankingView;
  saved?: boolean;
}

export interface EventPage {
  results: EventView[];
  cursor: string | null;
  state: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';
}

export interface EventsBrowseInput {
  /** Already-coarse origin (P2). */
  origin: CoarsePublicLocation;
  category?: string;
  cursor?: string | null;
}

export interface EventsApiPort {
  browseNearby(input: EventsBrowseInput): Promise<EventPage>;
  getById(id: string): Promise<EventView | null>;
  save(id: string): Promise<void>;
  unsave(id: string): Promise<void>;
}

/** A map marker for an event — the venue's own public location, never the user. */
export interface EventMapMarker {
  id: string;
  lat: number;
  lon: number;
  title: string;
  state: EventState;
  category: string;
}
