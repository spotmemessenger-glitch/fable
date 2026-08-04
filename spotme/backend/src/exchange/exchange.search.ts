/**
 * Exchange search projection + provider port (Phase 3C).
 *
 * The index holds ONLY a sanitized public projection: kind, category, title,
 * a normalized text projection, authorized intent labels, and a coarse cell —
 * NEVER coordinates, private profile, message content, contact-book data, or
 * age/gender (threat model T-EX-19). `toSearchProjection` is an ALLOW-LIST
 * builder: whatever an intent carries, only these fields survive, and a
 * coordinate-shaped value is dropped even from an allow-listed string field.
 *
 * Typesense sits BEHIND `ExchangeSearchPort` (the same provider-neutral seam as
 * discovery); no coordinate field exists in the schema, and the whole module is
 * dark — the adapter is unconfigured by default.
 */

import { ExchangeIntentRow } from './exchange.types';

/** The complete indexed document — the allowed field set. No coordinate field. */
export interface ExchangeSearchDoc {
  id: string;
  kind: 'need' | 'offer' | 'service';
  category: string;
  title: string;
  normalizedText: string;
  intentLabels: string[];
  /** Discretized cell ONLY — never a precise point. */
  coarseCell: string;
}

/** NFKC + zero-width strip + casefold (mirrors the discovery normalizer). */
export function normalizeExchangeText(s: string): string {
  return s.normalize('NFKC').replace(/[​-‍﻿]/g, '').toLowerCase().trim();
}

const COORDINATE_SHAPE = /-?\d{1,3}\.\d{3,}\s*,\s*-?\d{1,3}\.\d{3,}|-?\d{1,3}\.\d{4,}/;
const COORDINATE_SHAPE_G = new RegExp(COORDINATE_SHAPE.source, 'g');

/** Drop a coordinate-shaped string; pass everything else. */
function coordinateSafe<T>(v: T): T | '' {
  if (typeof v === 'string') return (COORDINATE_SHAPE.test(v) ? '' : v) as T | '';
  return v;
}

/** Strip coordinate-shaped TOKENS from free text so a coordinate embedded in a
 *  title/body/tag can never ride into the searchable projection. */
function stripCoordinateTokens(s: string): string {
  return s.replace(COORDINATE_SHAPE_G, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Build the sanitized index document from an intent row. This is the ONLY path
 * an intent enters the index; coordinates, precise fields, owner internals,
 * budget, and price NEVER appear.
 */
export function toSearchProjection(row: ExchangeIntentRow, intentLabels: string[] = []): ExchangeSearchDoc {
  return {
    id: row.id,
    kind: row.kind as ExchangeSearchDoc['kind'],
    // Category is free-form per policy, so a coordinate could be embedded — strip
    // it here too (review INDEX-CATEGORY). coarseCell is server-derived (3B), so
    // it is coarse by construction.
    category: stripCoordinateTokens(row.category),
    title: stripCoordinateTokens(row.title),
    normalizedText: stripCoordinateTokens(normalizeExchangeText([row.title, row.text, ...row.tags].join(' '))),
    intentLabels: intentLabels.map((l) => String(coordinateSafe(l))).filter((l) => l !== ''),
    coarseCell: row.coarseCell,
  };
}

/** Discriminated search result — a search NEVER fabricates; unavailability is typed. */
export type ExchangeSearchResult =
  | { state: 'ok'; hits: { id: string; kind: string; exactMatch?: boolean }[] }
  | { state: 'no-results' }
  | { state: 'provider-unavailable'; reason: 'unconfigured' | 'circuit-open' | 'timeout' | 'error' };

export interface ExchangeSearchQueryOptions {
  kind?: 'need' | 'offer' | 'service';
  limit?: number;
}

export interface ExchangeSearchPort {
  readonly name: string;
  search(query: string, opts?: ExchangeSearchQueryOptions): Promise<ExchangeSearchResult>;
  index(doc: ExchangeSearchDoc): Promise<{ ok: boolean }>;
}

export const EXCHANGE_SEARCH_PORT = Symbol('EXCHANGE_SEARCH_PORT');

/** Pin exact public-identifier matches ahead of fuzzy text hits, deterministically
 *  (mirrors the discovery exact-handle pin). An exact match on a business handle
 *  or category identifier outranks a fuzzy text hit. */
export function orderExchangeHits<T extends { id: string; exactMatch?: boolean }>(hits: T[]): T[] {
  return [...hits].sort((a, b) => Number(Boolean(b.exactMatch)) - Number(Boolean(a.exactMatch)) || a.id.localeCompare(b.id));
}

/** Default adapter: UNCONFIGURED — typed unavailability, no network, dark. */
export class UnconfiguredExchangeSearchAdapter implements ExchangeSearchPort {
  readonly name = 'unconfigured';
  async search(_query: string, _opts?: ExchangeSearchQueryOptions): Promise<ExchangeSearchResult> {
    return { state: 'provider-unavailable', reason: 'unconfigured' };
  }
  async index(_doc: ExchangeSearchDoc): Promise<{ ok: boolean }> {
    return { ok: false };
  }
}
