/**
 * Prisma/PostGIS implementation of the Events repository (Phase 4B).
 *
 * Upsert-by-id (exact provider identity) with the geography written from the
 * coarse venue point, dedup decisions + sanitized projections persisted
 * alongside, and retention expiry set from the time engine. Nearby browse is a
 * raw ST_DWithin query with keyset pagination on (startAt DESC, id DESC) and a
 * coarse distance BAND computed in SQL — never a raw metre distance on the wire.
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { EventsRepository, NearbyEventsQuery, UpsertResult } from './events.repository';
import type { EventRow, NormalizedEvent, StatedEvent, EventState } from './events.types';
import type { EventDedupDecision } from './events.dedup';
import { deriveEventState, retentionExpiryUTC } from './events.time';
import { toEventSearchProjection } from './events.search';

const toDate = (ms: number | null): Date | null => (ms == null ? null : new Date(ms));
const toMs = (d: Date | null): number | null => (d == null ? null : d.getTime());

function bandOf(distanceM: number | null): string | null {
  if (distanceM == null || !Number.isFinite(distanceM)) return null;
  if (distanceM < 500) return 'under500m';
  if (distanceM < 1000) return 'under1km';
  if (distanceM < 2000) return 'under2km';
  if (distanceM < 5000) return 'under5km';
  return 'over5km';
}

@Injectable()
export class PrismaEventsRepository implements EventsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsertBatch(canonical: StatedEvent[], decisions: EventDedupDecision[], now: number): Promise<UpsertResult> {
    let written = 0;
    for (const ev of canonical) {
      const expiresAt = toDate(retentionExpiryUTC(ev));
      await this.prisma.$transaction(async (tx) => {
        const data = {
          provider: ev.source.provider,
          providerEventId: ev.source.providerEventId,
          providerSourceId: ev.source.providerSourceId,
          organizerRef: ev.source.organizerRef,
          sourceName: ev.source.sourceName,
          url: ev.source.url,
          revisionAt: toDate(ev.source.revisionUTC),
          confidence: ev.source.confidence,
          category: ev.category,
          title: ev.title,
          description: ev.description,
          startAt: toDate(ev.startUTC),
          endAt: toDate(ev.endUTC),
          timezone: ev.timezone,
          allDay: ev.allDay,
          occurrenceId: ev.occurrenceId,
          lifecycle: ev.lifecycle,
          provenanceBy: ev.source.provenance?.assertedBy ?? null,
          provenanceAt: toDate(ev.source.provenance?.assertedAtUTC ?? null),
          provenanceNote: ev.source.provenance?.note ?? null,
          coarseLat: ev.coarseLat,
          coarseLon: ev.coarseLon,
          coarseCell: ev.coarseCell,
          popularity: ev.popularity,
          canonicalId: null as string | null, // a surviving canonical points at no one
          fetchedAt: toDate(ev.fetchedAtUTC),
          expiresAt,
        };
        await tx.event.upsert({ where: { id: ev.id }, create: { id: ev.id, ...data }, update: data });
        await tx.$executeRaw`UPDATE "Event" SET "geog" = ST_SetSRID(ST_MakePoint(${ev.coarseLon}, ${ev.coarseLat}), 4326)::geography WHERE "id" = ${ev.id}`;
        const proj = toEventSearchProjection(ev);
        await tx.eventSearchProjection.upsert({
          where: { id: proj.id },
          create: { id: proj.id, category: proj.category, title: proj.title, normalizedText: proj.normalizedText, coarseCell: proj.coarseCell, startAt: toDate(proj.startUTC), state: proj.state },
          update: { category: proj.category, title: proj.title, normalizedText: proj.normalizedText, coarseCell: proj.coarseCell, startAt: toDate(proj.startUTC), state: proj.state },
        });
        written += 1;
      });
    }
    for (const d of decisions) {
      await this.prisma.eventDedupDecision.upsert({
        where: { mergedId: d.mergedId },
        create: { canonicalId: d.canonicalId, mergedId: d.mergedId, basis: d.basis, titleMatch: d.evidence?.normalizedTitleMatch ?? false, venueMatch: d.evidence?.venueIdentityMatch ?? false, timeOverlap: d.evidence?.timeWindowOverlap ?? false, areaMatch: d.evidence?.coarseAreaMatch ?? false },
        update: { canonicalId: d.canonicalId, basis: d.basis, titleMatch: d.evidence?.normalizedTitleMatch ?? false, venueMatch: d.evidence?.venueIdentityMatch ?? false, timeOverlap: d.evidence?.timeWindowOverlap ?? false, areaMatch: d.evidence?.coarseAreaMatch ?? false },
      });
      // Mark the merged row as folded (so it never surfaces as its own result).
      await this.prisma.event.updateMany({ where: { id: d.mergedId }, data: { canonicalId: d.canonicalId } });
    }
    return { written, decisions };
  }

  async findNearby(q: NearbyEventsQuery): Promise<EventRow[]> {
    const radiusM = Math.max(0, q.radiusKm) * 1000;
    const nowDate = new Date(q.now);
    // Keyset on COALESCE("startAt", epoch) so NULL-start (tbd/postponed) rows
    // order deterministically (as epoch, last) AND remain reachable across page
    // boundaries — a plain "startAt < x" makes NULL rows unpageable (review
    // KEYSET-NULL). The cursor's `t` is 0 for a NULL-start anchor, matching epoch.
    const keyset = q.cursor
      ? Prisma.sql`AND (COALESCE("startAt", TIMESTAMP '1970-01-01 00:00:00') < ${new Date(q.cursor.t)} OR (COALESCE("startAt", TIMESTAMP '1970-01-01 00:00:00') = ${new Date(q.cursor.t)} AND "id" < ${q.cursor.i}))`
      : Prisma.empty;
    const catF = q.category ? Prisma.sql`AND "category" = ${q.category}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<Record<string, unknown>>>(Prisma.sql`
      SELECT "id", "provider", "providerEventId", "providerSourceId", "organizerRef", "sourceName", "url",
             "revisionAt", "confidence", "category", "title", "description", "startAt", "endAt", "timezone",
             "allDay", "occurrenceId", "lifecycle", "provenanceBy", "provenanceAt", "provenanceNote",
             "coarseLat", "coarseLon", "coarseCell", "popularity", "canonicalId", "fetchedAt", "expiresAt",
             ST_Distance("geog", ST_SetSRID(ST_MakePoint(${q.origin.lon}, ${q.origin.lat}), 4326)::geography) AS "distanceM"
      FROM "Event"
      WHERE "canonicalId" IS NULL
        AND ("expiresAt" IS NULL OR "expiresAt" > ${nowDate})
        AND "geog" IS NOT NULL
        AND ST_DWithin("geog", ST_SetSRID(ST_MakePoint(${q.origin.lon}, ${q.origin.lat}), 4326)::geography, ${radiusM})
        ${catF} ${keyset}
      ORDER BY COALESCE("startAt", TIMESTAMP '1970-01-01 00:00:00') DESC, "id" DESC
      LIMIT ${q.limit}
    `);
    return rows.map((r) => this.toRow(r, q.now, Number(r.distanceM)));
  }

  async findById(id: string): Promise<EventRow | null> {
    const row = await this.prisma.event.findUnique({ where: { id } });
    if (!row || row.canonicalId) return null;
    return this.toRow(row as unknown as Record<string, unknown>, Date.now(), null);
  }

  async getNormalized(id: string): Promise<NormalizedEvent | null> {
    const row = await this.prisma.event.findUnique({ where: { id } });
    if (!row) return null;
    return this.toNormalized(row as unknown as Record<string, unknown>);
  }

  async sweepExpired(now: number): Promise<number> {
    const res = await this.prisma.event.deleteMany({ where: { expiresAt: { not: null, lte: new Date(now) } } });
    return res.count;
  }

  private toNormalized(r: Record<string, unknown>): NormalizedEvent {
    const asDate = (v: unknown): Date | null => (v instanceof Date ? v : v ? new Date(v as string) : null);
    return {
      id: String(r.id),
      category: r.category as NormalizedEvent['category'],
      title: String(r.title),
      description: (r.description as string) ?? null,
      startUTC: toMs(asDate(r.startAt)),
      endUTC: toMs(asDate(r.endAt)),
      timezone: (r.timezone as string) ?? null,
      allDay: r.allDay === true,
      occurrenceId: (r.occurrenceId as string) ?? null,
      lifecycle: r.lifecycle as NormalizedEvent['lifecycle'],
      coarseLat: Number(r.coarseLat),
      coarseLon: Number(r.coarseLon),
      coarseCell: String(r.coarseCell),
      popularity: r.popularity == null ? null : Number(r.popularity),
      source: {
        provider: String(r.provider),
        providerEventId: String(r.providerEventId),
        providerSourceId: (r.providerSourceId as string) ?? null,
        organizerRef: (r.organizerRef as string) ?? null,
        sourceName: (r.sourceName as string) ?? null,
        url: (r.url as string) ?? null,
        revisionUTC: toMs(asDate(r.revisionAt)),
        confidence: r.confidence == null ? null : Number(r.confidence),
        provenance: r.lifecycle === 'scheduled' ? null : {
          lifecycle: r.lifecycle as 'cancelled' | 'postponed',
          assertedBy: (r.provenanceBy as string) ?? String(r.provider),
          assertedAtUTC: toMs(asDate(r.provenanceAt)),
          ...((r.provenanceNote as string) ? { note: r.provenanceNote as string } : {}),
        },
      },
      fetchedAtUTC: toMs(asDate(r.fetchedAt)),
      restricted: false,
      unsafe: false,
    };
  }

  private toRow(r: Record<string, unknown>, now: number, distanceM: number | null): EventRow {
    const n = this.toNormalized(r);
    const state: EventState = deriveEventState(n, now);
    return {
      ...n,
      canonicalId: (r.canonicalId as string) ?? null,
      expiresAtUTC: toMs(r.expiresAt instanceof Date ? r.expiresAt : r.expiresAt ? new Date(r.expiresAt as string) : null),
      state,
      distanceBand: bandOf(distanceM),
    };
  }
}
