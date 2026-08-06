/**
 * Live Nearby Events — sanitized search projection + provider-neutral port (4B).
 *
 * The index holds ONLY a sanitized public projection: id, category, title, a
 * normalized text projection, a coarse cell, a start instant, and the derived
 * state — NEVER coordinates, raw payload, source credentials, or age/gender
 * (T-EV-5/6). `toEventSearchProjection` is an ALLOW-LIST builder; a
 * coordinate-shaped token is stripped even from an allow-listed string field.
 *
 * The provider search adapter sits BEHIND `EventSearchPort` (the same seam as
 * discovery/exchange); the default adapter is UNCONFIGURED — no network, typed
 * unavailability — so the whole module is dark.
 */

import type { StatedEvent } from './events.types';

/** The complete indexed document — the allowed field set. No coordinate field. */
export interface EventSearchDoc {
  id: string;
  category: string;
  title: string;
  normalizedText: string;
  /** Discretized cell ONLY — never a precise point. */
  coarseCell: string;
  startUTC: number | null;
  state: string;
}

const COORDINATE_SHAPE = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/;
const COORDINATE_SHAPE_G = new RegExp(COORDINATE_SHAPE.source, 'g');

/** NFKC + zero-width strip + casefold. */
export function normalizeEventText(s: string): string {
  return (s || '').normalize('NFKC').replace(/[​-‍﻿]/g, '').toLowerCase().trim();
}

/** Strip coordinate-shaped TOKENS from free text so a coordinate embedded in a
 *  title/description can never ride into the searchable projection. */
export function stripCoordinateTokens(s: string): string {
  return (s || '').replace(COORDINATE_SHAPE_G, ' ').replace(/\s+/g, ' ').trim();
}

/** Build the sanitized index document. The ONLY path an event enters the index;
 *  coordinates, raw payload, and source internals NEVER appear. */
export function toEventSearchProjection(ev: StatedEvent): EventSearchDoc {
  return {
    id: ev.id,
    category: stripCoordinateTokens(ev.category),
    title: stripCoordinateTokens(ev.title),
    normalizedText: stripCoordinateTokens(normalizeEventText([ev.title, ev.description ?? ''].join(' '))),
    coarseCell: ev.coarseCell, // server-derived, coarse by construction
    startUTC: ev.startUTC,
    state: ev.state,
  };
}

/** Discriminated search result — a search NEVER fabricates; unavailability is typed. */
export type EventSearchResult =
  | { state: 'ok'; hits: { id: string; exactMatch?: boolean }[] }
  | { state: 'no-results' }
  | { state: 'provider-unavailable'; reason: 'unconfigured' | 'circuit-open' | 'timeout' | 'error' };

export interface EventSearchQueryOptions {
  category?: string;
  limit?: number;
}

export interface EventSearchPort {
  readonly name: string;
  search(query: string, opts?: EventSearchQueryOptions): Promise<EventSearchResult>;
  index(doc: EventSearchDoc): Promise<{ ok: boolean }>;
}

export const EVENT_SEARCH_PORT = Symbol('EVENT_SEARCH_PORT');

/** Pin exact identifier matches ahead of fuzzy hits, deterministically. */
export function orderEventHits<T extends { id: string; exactMatch?: boolean }>(hits: T[]): T[] {
  return [...hits].sort((a, b) => Number(Boolean(b.exactMatch)) - Number(Boolean(a.exactMatch)) || a.id.localeCompare(b.id));
}

/** Default adapter: UNCONFIGURED — typed unavailability, no network, dark. */
export class UnconfiguredEventSearchAdapter implements EventSearchPort {
  readonly name = 'unconfigured';
  async search(_query: string, _opts?: EventSearchQueryOptions): Promise<EventSearchResult> {
    return { state: 'provider-unavailable', reason: 'unconfigured' };
  }
  async index(_doc: EventSearchDoc): Promise<{ ok: boolean }> {
    return { ok: false };
  }
}
