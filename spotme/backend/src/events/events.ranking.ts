/**
 * Live Nearby Events — transparent, deterministic ranking (Phase 4C).
 *
 * Ports #61 `ranking.js` and adapts it for the corrections:
 *  - CLOSED signal registry: `time`, `distance`, `relevance`, `popularity`. There
 *    is NO engagement/sponsored/personalised path — supplying such a signal or
 *    weight THROWS (`EventRankingRegistryError`).
 *  - POPULARITY is weighted LAST and, per C2, acts ONLY as a tie-breaker: the
 *    primary order is the substantive score (time+distance+relevance); popularity
 *    breaks a genuine tie but can NEVER resurrect a materially lower-scored (e.g.
 *    materially more distant) result. Ineligible/expired/blocked/cancelled rows
 *    are removed BEFORE ranking, so no weight can bring them back.
 *  - UNKNOWN popularity contributes nothing and is DISCLOSED as an omitted
 *    signal — never an invented zero (C2).
 *  - Every result carries a full breakdown; ties break by id (stable order).
 *
 * Weights are [PROPOSED] config defaults (pending A5); only the SHAPE is fixed.
 */

import type { EventState } from './events.types';

export const EVENT_RANKING_SIGNALS = ['time', 'distance', 'relevance', 'popularity'] as const;
export type EventRankingSignal = (typeof EVENT_RANKING_SIGNALS)[number];

/** [PROPOSED] defaults (pending A5). Popularity is LAST and is only a tie-break. */
export const EVENT_RANKING_WEIGHTS: Record<EventRankingSignal, number> = {
  time: 0.40,
  distance: 0.30,
  relevance: 0.20,
  popularity: 0.10,
};

/** The substantive (non-popularity) signals — these set the primary order. */
const SUBSTANTIVE: readonly EventRankingSignal[] = ['time', 'distance', 'relevance'];

/** Upcoming events within this horizon get full-to-decaying time credit. */
export const TIME_HORIZON_MS = 72 * 60 * 60 * 1000;

export class EventRankingRegistryError extends Error {
  constructor(signal: string) {
    super(`unregistered event ranking signal '${signal}' — the registry is closed (no engagement/sponsored/personalised path exists)`);
    this.name = 'EventRankingRegistryError';
  }
}
export class EventRankingWeightError extends Error {
  constructor(signal: string) {
    super(`event ranking weight for '${signal}' must be a finite number >= 0`);
    this.name = 'EventRankingWeightError';
  }
}

export interface RankableEvent {
  id: string;
  state: EventState;
  startUTC: number | null;
  distanceBand: string | null;
  category: string;
  title: string;
  description: string | null;
  /** Sourced popularity 0..1, or null when unknown (ranks as omitted). */
  popularity: number | null;
}

export interface EventRankingComponent {
  signal: EventRankingSignal;
  weight: number;
  value: number;
  weighted: number;
}
export interface EventRankingBreakdown {
  components: EventRankingComponent[];
  omittedSignals: EventRankingSignal[];
  total: number;
}
export interface RankedEvent<T extends RankableEvent = RankableEvent> {
  event: T;
  ranking: EventRankingBreakdown;
}

const BAND_VALUE: Record<string, number> = { under500m: 1, under1km: 0.8, under2km: 0.6, under5km: 0.4, over5km: 0.2 };

function clamp01(n: number): number {
  return !Number.isFinite(n) ? 0 : n < 0 ? 0 : n > 1 ? 1 : n;
}

function timeSignal(ev: RankableEvent, now: number): number {
  if (ev.state === 'happening-now') return 1;
  if (ev.state === 'ended' || ev.state === 'cancelled') return 0;
  if (ev.state === 'postponed') return 0.1; // real but undated
  if (typeof ev.startUTC === 'number' && Number.isFinite(now)) {
    const ahead = ev.startUTC - now;
    if (ahead <= 0) return 1;
    return clamp01(1 - ahead / TIME_HORIZON_MS);
  }
  return 0.2; // upcoming, tbd start
}

function distanceSignal(band: string | null): number {
  if (band == null) return 0;
  return BAND_VALUE[band] ?? 0;
}

function relevanceSignal(ev: RankableEvent, query: { text?: string; category?: string }): number {
  const q = (query.text || '').toLowerCase().trim();
  const cat = query.category || null;
  let score = 0;
  if (cat && ev.category === cat) score += 0.5;
  if (q) {
    const hay = `${ev.title || ''} ${ev.category || ''} ${ev.description || ''}`.toLowerCase();
    const tokens = q.split(/\s+/).filter(Boolean);
    if (tokens.length) score += 0.5 * (tokens.filter((t) => hay.includes(t)).length / tokens.length);
  } else if (!cat) {
    return 0.5; // nothing to match on ⇒ neutral
  }
  return clamp01(score);
}

/** Validate the weight table is the closed registry with finite non-negative weights. */
function assertClosedWeights(weights: Record<string, number>): void {
  const registered = new Set<string>(EVENT_RANKING_SIGNALS);
  for (const s of EVENT_RANKING_SIGNALS) {
    const w = weights[s];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) throw new EventRankingWeightError(s);
  }
  for (const k of Object.keys(weights)) if (!registered.has(k)) throw new EventRankingRegistryError(k);
}

/** Full transparent breakdown for one event. Unknown popularity is OMITTED. */
export function scoreBreakdown(ev: RankableEvent, query: { text?: string; category?: string }, now: number, weights = EVENT_RANKING_WEIGHTS): EventRankingBreakdown {
  assertClosedWeights(weights);
  const values: Record<EventRankingSignal, number | null> = {
    time: timeSignal(ev, now),
    distance: distanceSignal(ev.distanceBand),
    relevance: relevanceSignal(ev, query),
    popularity: typeof ev.popularity === 'number' && Number.isFinite(ev.popularity) ? clamp01(ev.popularity) : null,
  };
  const components: EventRankingComponent[] = [];
  const omittedSignals: EventRankingSignal[] = [];
  for (const signal of EVENT_RANKING_SIGNALS) {
    const v = values[signal];
    if (v == null) { omittedSignals.push(signal); continue; }
    const weight = weights[signal];
    components.push({ signal, weight, value: +v.toFixed(4), weighted: +(weight * v).toFixed(4) });
  }
  const total = +components.reduce((s, c) => s + c.weighted, 0).toFixed(4);
  return { components, omittedSignals, total };
}

/** The substantive (non-popularity) subtotal — the PRIMARY sort key (C2). */
function substantiveScore(b: EventRankingBreakdown): number {
  return +b.components.filter((c) => (SUBSTANTIVE as readonly string[]).includes(c.signal)).reduce((s, c) => s + c.weighted, 0).toFixed(4);
}
function popularityScore(b: EventRankingBreakdown): number {
  return b.components.find((c) => c.signal === 'popularity')?.weighted ?? 0;
}

const TIE_EPSILON = 1e-9;

/**
 * Rank events. Ineligible rows must already be filtered out. Primary order is the
 * substantive score; popularity breaks a genuine tie ONLY (C2) and can never
 * override a materially higher substantive score. Deterministic (ties → id asc).
 */
export function rankEvents<T extends RankableEvent>(events: T[], query: { text?: string; category?: string } = {}, now = 0, weights = EVENT_RANKING_WEIGHTS): RankedEvent<T>[] {
  if (!Array.isArray(events)) return [];
  const ranked = events
    .filter((e) => e && e.id != null)
    .map((event) => ({ event, ranking: scoreBreakdown(event, query, now, weights) }));
  ranked.sort((a, b) => {
    const sa = substantiveScore(a.ranking);
    const sb = substantiveScore(b.ranking);
    if (Math.abs(sa - sb) > TIE_EPSILON) return sb - sa;          // primary: substantive
    const pa = popularityScore(a.ranking);
    const pb = popularityScore(b.ranking);
    if (Math.abs(pa - pb) > TIE_EPSILON) return pb - pa;          // tie-break: popularity
    return a.event.id.localeCompare(b.event.id);                   // stable
  });
  return ranked;
}
