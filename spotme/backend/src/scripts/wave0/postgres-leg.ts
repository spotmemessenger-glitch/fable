/**
 * Wave 0 — Postgres / PostGIS leg. IN-NETWORK ONLY (DATABASE_URL is on
 * Railway's private network; unreachable from outside a Railway deployment).
 *
 * This is the Phase-1A production-permission gate: can PostGIS be enabled on
 * this Railway Postgres image? The leg answers it for real, or reports the
 * exact owner remedy if the image cannot support it — it NEVER substitutes.
 *
 * SAFETY. The mandatory user-data check runs FIRST, aggregate counts only, no
 * row contents. Any DDL/mutation (CREATE EXTENSION) is gated behind BOTH a
 * SAFE verdict AND an explicit `WAVE0_DB_MUTATE=1` opt-in. If real user data is
 * present or indistinguishable, the leg reports and refuses to mutate.
 */

import { PrismaClient } from '@prisma/client';
import { LegResult, round2, timed } from './guard';

/** Above this many users we will not assume "seeds/tests only" — refuse to mutate. */
const SEED_USER_CEILING = Number(process.env.WAVE0_MAX_SEED_USERS || '25');

async function scalar(prisma: PrismaClient, sql: string): Promise<unknown> {
  const rows = (await prisma.$queryRawUnsafe(sql)) as Array<Record<string, unknown>>;
  const row = rows?.[0] ?? {};
  return Object.values(row)[0];
}

export async function runPostgresLeg(): Promise<LegResult> {
  const notes: string[] = [];
  const detail: Record<string, unknown> = {};
  const prisma = new PrismaClient();

  const connect = await timed(() => prisma.$connect());
  detail.connectMs = round2(connect.ms);
  if (connect.error) {
    notes.push(`connect failed: ${connect.error}`);
    await prisma.$disconnect().catch(() => undefined);
    return { leg: 'postgres', status: 'FAIL', detail, notes };
  }

  try {
    // --- versions ---
    detail.serverVersion = String(await scalar(prisma, 'SHOW server_version'));

    // --- MANDATORY user-data safety check (aggregate counts only) ---
    const userCount = Number(await scalar(prisma, 'SELECT count(*)::int FROM "User"').catch(() => -1));
    detail.userDataCheck = { userCount, ceiling: SEED_USER_CEILING };
    let safe: boolean;
    if (userCount < 0) {
      safe = false;
      notes.push('user-data check inconclusive (User table not readable) — refusing to mutate.');
    } else if (userCount > SEED_USER_CEILING) {
      safe = false;
      notes.push(`STOP-condition sentinel: ${userCount} users exceeds seed ceiling ${SEED_USER_CEILING}; possible real user data — refusing to mutate, asking owner.`);
    } else {
      safe = true;
      notes.push(`user-data check: ${userCount} users (<= ceiling) — consistent with seeds/tests.`);
    }
    (detail.userDataCheck as Record<string, unknown>).verdict = safe ? 'SAFE' : 'STOP';

    // --- PostGIS availability (read-only) ---
    const avail = (await prisma.$queryRawUnsafe(
      `SELECT default_version FROM pg_available_extensions WHERE name='postgis'`,
    )) as Array<{ default_version: string }>;
    const installable = avail.length > 0;
    const installedVersion = await scalar(prisma, `SELECT extversion FROM pg_extension WHERE extname='postgis'`).catch(() => undefined);
    detail.postgis = {
      installable,
      availableVersion: avail[0]?.default_version ?? null,
      installed: Boolean(installedVersion),
      installedVersion: installedVersion ?? null,
    };

    const mutate = process.env.WAVE0_DB_MUTATE === '1';
    // --- install PostGIS if permitted, safe, available, and not yet present ---
    if (!installedVersion) {
      if (!installable) {
        (detail.postgis as Record<string, unknown>).gate = 'BLOCKED';
        notes.push(
          'PHASE-1A GATE = BLOCKED: PostGIS is NOT available in this Railway Postgres image. ' +
            'Do NOT substitute. Owner remedy: switch the Postgres service to a PostGIS-capable image ' +
            '(e.g. ghcr.io/railwayapp-templates/postgres-postgis, or an approved PostGIS build) and re-run this leg.',
        );
      } else if (safe && mutate) {
        const inst = await timed(() => prisma.$executeRawUnsafe('CREATE EXTENSION IF NOT EXISTS postgis'));
        (detail.postgis as Record<string, unknown>).installMs = round2(inst.ms);
        (detail.postgis as Record<string, unknown>).gate = inst.error ? 'BLOCKED' : 'PASS';
        if (inst.error) notes.push(`PostGIS install failed: ${inst.error}. Owner remedy: PostGIS-capable image.`);
        else notes.push('PHASE-1A GATE = PASS: PostGIS installed/enabled on this image.');
      } else {
        (detail.postgis as Record<string, unknown>).gate = 'DEFERRED';
        notes.push(`PostGIS installable but not installed: ${!safe ? 'user-data verdict not SAFE' : 'WAVE0_DB_MUTATE!=1'}.`);
      }
    } else {
      (detail.postgis as Record<string, unknown>).gate = 'PASS';
      notes.push('PHASE-1A GATE = PASS: PostGIS already present.');
    }

    // --- geospatial smoke (table-free; needs PostGIS present) ---
    if (detail.postgis && (await scalar(prisma, `SELECT extversion FROM pg_extension WHERE extname='postgis'`).catch(() => undefined))) {
      const smoke = await timed(async () =>
        scalar(
          prisma,
          // distance between two wave0 test coordinates, in metres, via geography
          `SELECT round(ST_Distance(ST_MakePoint(0,0)::geography, ST_MakePoint(0,1)::geography)::numeric,1)`,
        ),
      );
      detail.geoSmoke = { ms: round2(smoke.ms), meters: smoke.value ?? null, error: smoke.error ?? null };
      if (!smoke.error) notes.push(`geospatial smoke OK: 0,0→0,1 = ${String(smoke.value)} m.`);
    }

    // --- migration state ---
    const mig = (await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS applied, count(*) FILTER (WHERE finished_at IS NULL)::int AS pending, count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::int AS rolledback FROM _prisma_migrations`,
    ).catch(() => null)) as Array<Record<string, number>> | null;
    detail.migrations = mig?.[0] ?? { note: '_prisma_migrations absent — run prisma migrate deploy (see DEPLOYMENT.md)' };

    const gate = (detail.postgis as Record<string, unknown>).gate;
    const status = gate === 'BLOCKED' ? 'BLOCKED' : 'PASS';
    return { leg: 'postgres', status, detail, notes };
  } catch (e) {
    notes.push(`postgres leg error: ${(e as Error).message}`);
    return { leg: 'postgres', status: 'FAIL', detail, notes };
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}
