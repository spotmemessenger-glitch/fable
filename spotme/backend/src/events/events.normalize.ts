/**
 * Live Nearby Events — the normalize boundary (Phase 4B).
 *
 * The ONE place a provider-shaped candidate becomes a trusted NormalizedEvent.
 * It is an ALLOW-LIST builder: only whitelisted fields are copied into a fresh
 * record, so a provider's raw payload (tracking ids, credential echoes, billing
 * metadata) NEVER rides along and is never persisted (C3, T-EV-4).
 *
 * Boundary guarantees:
 *  - VENUE is coarsened to the public grid here (3-decimal round + derived cell)
 *    — the stored/served venue is coarse by construction; a precise provider
 *    point never survives.
 *  - POPULARITY is trusted ONLY as an explicit bounded number the source
 *    supplied; it is clamped to 0..1. Absent ⇒ null (unknown), never invented (C2).
 *  - SOURCE attribution is mandatory and fully populated (C3).
 *  - TIME: instants are coerced to UTC epoch-ms; end < start is REJECTED (C5);
 *    recurrence occurrenceId is copied ONLY when the provider supplied one (C5).
 */

import {
  EVENT_CATEGORIES, EventCategory, EventProviderCandidate, EventSourceLifecycle,
  EventStateProvenance, NormalizedEvent,
} from './events.types';
import { assertValidWindow } from './events.time';

const SOURCE_LIFECYCLES: readonly EventSourceLifecycle[] = ['scheduled', 'cancelled', 'postponed'];

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
/** Accept an epoch-ms instant or an ISO-8601 string → epoch ms, else null. */
function toEpochMs(v: unknown): number | null {
  const n = num(v);
  if (n != null) return n;
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

/** Round to the public 3-decimal grid (~110 m), matching the discovery/exchange
 *  coarsening granularity. The ONLY place a venue coordinate is set. */
function coarsen(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function buildProvenance(candidate: EventProviderCandidate, lifecycle: EventSourceLifecycle, provider: string): EventStateProvenance | null {
  if (lifecycle === 'scheduled') return null;
  const p = candidate.provenance && typeof candidate.provenance === 'object' ? (candidate.provenance as Record<string, unknown>) : {};
  return {
    lifecycle,
    assertedBy: str(p.assertedBy) || str(candidate.source) || str(candidate.sourceName) || provider,
    assertedAtUTC: toEpochMs(p.assertedAtUTC),
    ...(str(p.note) ? { note: str(p.note) as string } : {}),
  };
}

/**
 * Normalize a provider candidate into a {@link NormalizedEvent}. Returns null
 * when the minimum (providerEventId, title, usable coordinates) is missing —
 * we never fabricate an event to fill a gap.
 */
export function normalizeEvent(candidate: EventProviderCandidate, providerName: string, opts: { fetchedAtUTC?: number } = {}): NormalizedEvent | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const provider = str(providerName) || str(candidate.provider as unknown) || 'unknown';
  const providerEventId = str(candidate.providerEventId) || str(candidate.id);
  const title = str(candidate.title) || str(candidate.name);
  if (!providerEventId || !title) return null;

  const rawLat = num(candidate.lat);
  const rawLon = num(candidate.lon);
  if (rawLat == null || rawLon == null || rawLat < -90 || rawLat > 90 || rawLon < -180 || rawLon > 180) return null;
  const coarseLat = coarsen(rawLat);
  const coarseLon = coarsen(rawLon);
  const coarseCell = `g${coarseLat.toFixed(3)}:${coarseLon.toFixed(3)}`;

  const category: EventCategory = EVENT_CATEGORIES.includes(candidate.category as EventCategory)
    ? (candidate.category as EventCategory) : 'other';
  const lifecycle: EventSourceLifecycle = SOURCE_LIFECYCLES.includes(candidate.lifecycle as EventSourceLifecycle)
    ? (candidate.lifecycle as EventSourceLifecycle) : 'scheduled';

  const startUTC = toEpochMs(candidate.startUTC ?? candidate.start);
  const endUTC = toEpochMs(candidate.endUTC ?? candidate.end);
  assertValidWindow(startUTC, endUTC); // C5: end < start is refused, loud

  const rawPop = num(candidate.popularity);
  const popularity = rawPop != null ? Math.max(0, Math.min(1, rawPop)) : null;

  return {
    id: `${provider}:${providerEventId}`,
    category,
    title,
    description: str(candidate.description),
    startUTC,
    endUTC,
    timezone: str(candidate.timezone),
    allDay: candidate.allDay === true,
    occurrenceId: str(candidate.occurrenceId), // C5: provider-supplied only; never inferred
    lifecycle,
    coarseLat,
    coarseLon,
    coarseCell,
    popularity,
    source: {
      provider,
      providerEventId,
      providerSourceId: str(candidate.providerSourceId),
      organizerRef: str(candidate.organizerRef),
      sourceName: str(candidate.source) || str(candidate.sourceName),
      url: str(candidate.url),
      revisionUTC: toEpochMs(candidate.revisionUTC),
      confidence: num(candidate.confidence) != null ? Math.max(0, Math.min(1, num(candidate.confidence) as number)) : null,
      provenance: buildProvenance(candidate, lifecycle, provider),
    },
    fetchedAtUTC: num(opts.fetchedAtUTC),
    restricted: candidate.restricted === true,
    unsafe: candidate.unsafe === true,
  };
}
