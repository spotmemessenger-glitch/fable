/**
 * Prisma/PostGIS implementations of the discovery repository ports
 * (checkpoint 5 — the people discovery query engine's data layer).
 *
 * Every exclusion the port contract demands is IN THE SQL, not in
 * post-processing: expired presence, self, blocks in both directions,
 * visibility off, non-discoverable profile, and NULL geography all fail the
 * predicate — a row the principal must not see is never even fetched
 * (threat model C-EXPIRE / C-BLOCK / P3). The radius is bounded by policy
 * before this layer; pagination is deterministic keyset on
 * (distance, userId) — no OFFSET, no unbounded scan (ORDER BY + LIMIT rides
 * the GIST index).
 *
 * The computed distance is SERVER-INTERNAL: it derives the band and the
 * cursor and is never serialized to a client (C-BAND — asserted by the
 * service tests and the C12 fences).
 */

import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  DiscoveryPeopleRepository,
  DiscoveryVisibilityRepository,
  NearbyPeopleQuery,
  VisibilityUpsert,
} from './discovery.repository';
import { PersonCandidateRow } from './discovery.types';

interface RawRow {
  userId: string;
  displayName: string;
  handle: string | null;
  avatarRef: string | null;
  coarseLat: number;
  coarseLon: number;
  coarseCell: string;
  observedAt: Date;
  expiresAt: Date;
  coarseDistanceM: number;
}

@Injectable()
export class PrismaDiscoveryPeopleRepository implements DiscoveryPeopleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findNearbyPeople(q: NearbyPeopleQuery): Promise<PersonCandidateRow[]> {
    const radiusM = Math.round(q.radiusKm * 1000);
    const origin = Prisma.sql`ST_SetSRID(ST_MakePoint(${q.originLon}, ${q.originLat}), 4326)::geography`;
    // Keyset continuation: strictly after (distance, userId). Distance ties are
    // broken by userId, so the pair is a total order and pages never overlap.
    const keyset = q.cursor
      ? Prisma.sql`AND (c."coarseDistanceM" > ${q.cursor.d} OR (c."coarseDistanceM" = ${q.cursor.d} AND c."userId" > ${q.cursor.u}))`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      WITH c AS (
        SELECT v."userId",
               p."displayName",
               p."handle",
               p."avatarRef",
               v."coarseLat",
               v."coarseLon",
               v."coarseCell",
               v."updatedAt"  AS "observedAt",
               v."expiresAt",
               ST_Distance(v."geog", ${origin}) AS "coarseDistanceM"
        FROM "DiscoveryVisibility" v
        JOIN "DiscoveryPublicProfileProjection" p
          ON p."userId" = v."userId" AND p."discoverable" = true
        WHERE v."enabled" = true
          AND v."geog" IS NOT NULL
          AND v."expiresAt" > ${q.now}
          AND v."userId" <> ${q.principalId}
          AND ST_DWithin(v."geog", ${origin}, ${radiusM})
          AND NOT EXISTS (
            SELECT 1 FROM "DiscoveryBlockProjection" b
            WHERE (b."ownerUserId" = ${q.principalId} AND b."blockedUserId" = v."userId")
               OR (b."ownerUserId" = v."userId" AND b."blockedUserId" = ${q.principalId})
          )
      )
      SELECT * FROM c
      WHERE TRUE ${keyset}
      ORDER BY c."coarseDistanceM" ASC, c."userId" ASC
      LIMIT ${q.limit}
    `);

    return rows.map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      handle: r.handle,
      avatarRef: r.avatarRef,
      coarseLat: r.coarseLat,
      coarseLon: r.coarseLon,
      coarseCell: r.coarseCell,
      observedAt: r.observedAt,
      expiresAt: r.expiresAt,
      coarseDistanceM: Number(r.coarseDistanceM),
    }));
  }
}

@Injectable()
export class PrismaDiscoveryVisibilityRepository implements DiscoveryVisibilityRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Principal-keyed upsert; geography written from the SAME coarse point. */
  async setVisibility(principalId: string, v: VisibilityUpsert): Promise<{ visibilityVersion: number }> {
    const rows = await this.prisma.$queryRaw<{ visibilityVersion: number }[]>(Prisma.sql`
      INSERT INTO "DiscoveryVisibility"
        ("userId", "enabled", "coarseCell", "coarseLat", "coarseLon", "geog", "updatedAt", "expiresAt", "visibilityVersion")
      VALUES (
        ${principalId}, ${v.enabled}, ${v.coarseCell}, ${v.coarseLat}, ${v.coarseLon},
        ST_SetSRID(ST_MakePoint(${v.coarseLon}, ${v.coarseLat}), 4326)::geography,
        NOW(), ${v.expiresAt}, 1
      )
      ON CONFLICT ("userId") DO UPDATE SET
        "enabled" = EXCLUDED."enabled",
        "coarseCell" = EXCLUDED."coarseCell",
        "coarseLat" = EXCLUDED."coarseLat",
        "coarseLon" = EXCLUDED."coarseLon",
        "geog" = EXCLUDED."geog",
        "updatedAt" = NOW(),
        "expiresAt" = EXCLUDED."expiresAt",
        "visibilityVersion" = "DiscoveryVisibility"."visibilityVersion" + 1
      RETURNING "visibilityVersion"
    `);
    return { visibilityVersion: rows[0]?.visibilityVersion ?? 1 };
  }

  async getVisibility(principalId: string) {
    const row = await this.prisma.discoveryVisibility.findUnique({
      where: { userId: principalId },
      select: { enabled: true, expiresAt: true, visibilityVersion: true },
    });
    return row ?? null;
  }
}
