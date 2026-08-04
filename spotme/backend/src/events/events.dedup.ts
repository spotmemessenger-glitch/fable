/**
 * Live Nearby Events — conservative, explainable cross-provider dedup (C4).
 *
 * Rules, in order:
 *  1. EXACT PROVIDER IDENTITY wins automatically: two rows with the same
 *     `${provider}:${providerEventId}` id are the same event.
 *  2. A CROSS-PROVIDER merge requires ALL FOUR signals to hold:
 *       normalized-title match · venue-identity (same coarse cell) ·
 *       overlapping time window · coarse-area match.
 *     Anything short of all four leaves the candidates SEPARATE — we NEVER merge
 *     on title similarity alone. Every decision is explainable: the evidence is
 *     carried on the returned decision, not discarded.
 *
 * The canonical survivor of a merge is the higher-confidence row (ties broken by
 * the lexicographically smaller id), so the choice is deterministic.
 */

import type { NormalizedEvent } from './events.types';
import { effectiveEndUTC } from './events.time';

export type EventDedupBasis = 'exact-provider-identity' | 'cross-provider-match';

export interface EventDedupEvidence {
  normalizedTitleMatch: boolean;
  venueIdentityMatch: boolean;
  timeWindowOverlap: boolean;
  coarseAreaMatch: boolean;
}

export interface EventDedupDecision {
  canonicalId: string;
  mergedId: string;
  basis: EventDedupBasis;
  evidence: EventDedupEvidence | null;
}

/** NFKC + strip zero-width + collapse non-alphanumeric + casefold. */
export function normalizeTitle(s: string): string {
  return (s || '')
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** The ~1.1 km "coarse area" cell (2-decimal), broader than the ~110 m venue cell. */
function coarseArea(e: NormalizedEvent): string {
  return `${e.coarseLat.toFixed(2)}:${e.coarseLon.toFixed(2)}`;
}

/** True when two effective [start,end] windows overlap. Unknown starts never overlap
 *  (a tbd event is not confidently the same instance as a dated one). */
function windowsOverlap(a: NormalizedEvent, b: NormalizedEvent): boolean {
  if (a.startUTC == null || b.startUTC == null) return false;
  const aEnd = effectiveEndUTC(a) ?? a.startUTC;
  const bEnd = effectiveEndUTC(b) ?? b.startUTC;
  return a.startUTC <= bEnd && b.startUTC <= aEnd;
}

/** Compute the four-signal evidence for a candidate pair. */
export function dedupEvidence(a: NormalizedEvent, b: NormalizedEvent): EventDedupEvidence {
  const ta = normalizeTitle(a.title);
  const tb = normalizeTitle(b.title);
  return {
    normalizedTitleMatch: ta.length > 0 && ta === tb,
    venueIdentityMatch: a.coarseCell === b.coarseCell,
    timeWindowOverlap: windowsOverlap(a, b),
    coarseAreaMatch: coarseArea(a) === coarseArea(b),
  };
}

function allFour(e: EventDedupEvidence): boolean {
  return e.normalizedTitleMatch && e.venueIdentityMatch && e.timeWindowOverlap && e.coarseAreaMatch;
}

/** Deterministic canonical winner: higher confidence, then smaller id. */
function preferred(a: NormalizedEvent, b: NormalizedEvent): NormalizedEvent {
  const ca = a.source.confidence ?? -1;
  const cb = b.source.confidence ?? -1;
  if (ca !== cb) return ca > cb ? a : b;
  return a.id <= b.id ? a : b;
}

export interface DedupResult<T extends NormalizedEvent> {
  canonical: T[];
  decisions: EventDedupDecision[];
}

/**
 * Dedup a set of normalized events. Exact-id duplicates collapse; a full
 * four-signal cross-provider match folds the weaker row into the stronger; any
 * partial match leaves both as separate canonicals (conservative).
 */
export function dedupeEvents<T extends NormalizedEvent>(events: T[]): DedupResult<T> {
  const decisions: EventDedupDecision[] = [];
  const canonical: T[] = [];
  const byId = new Map<string, T>();

  for (const ev of events) {
    if (!ev || !ev.id) continue;

    // 1. Exact provider identity.
    const existing = byId.get(ev.id);
    if (existing) {
      decisions.push({ canonicalId: existing.id, mergedId: ev.id, basis: 'exact-provider-identity', evidence: null });
      continue;
    }

    // 2. Conservative cross-provider match against existing canonicals.
    let mergedInto: T | null = null;
    let evidence: EventDedupEvidence | null = null;
    for (const c of canonical) {
      const ev4 = dedupEvidence(ev, c);
      if (allFour(ev4)) { mergedInto = c; evidence = ev4; break; }
    }
    if (mergedInto && evidence) {
      const winner = preferred(mergedInto, ev);
      const loser = winner.id === mergedInto.id ? ev : mergedInto;
      if (winner.id !== mergedInto.id) {
        // The newcomer outranks the seated canonical: swap it in.
        const idx = canonical.indexOf(mergedInto);
        if (idx >= 0) canonical[idx] = ev;
        byId.delete(mergedInto.id);
        byId.set(ev.id, ev);
      }
      decisions.push({ canonicalId: winner.id, mergedId: loser.id, basis: 'cross-provider-match', evidence });
      continue;
    }

    canonical.push(ev);
    byId.set(ev.id, ev);
  }

  return { canonical, decisions };
}
