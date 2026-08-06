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

    // --- geospatial smoke: ST_Distance + ST_DWithin + GiST (Discovery's real deps) ---
    // Discovery's Smart Nearby map does GiST-indexed ST_DWithin radius queries on a
    // geography column, so proving the extension loads is not enough — this proves
    // the index type + operator Wave 1 depends on actually function on the image.
    const installedNow = await scalar(prisma, `SELECT extversion FROM pg_extension WHERE extname='postgis'`).catch(() => undefined);
    if (installedNow) {
      (detail.postgis as Record<string, unknown>).installedVersion = installedNow;
      const geo = await timed(() =>
        // One interactive transaction so the TEMP table lives on a single connection
        // and auto-drops ON COMMIT (nothing wave0 persists).
        prisma.$transaction(async (tx) => {
          const dist = (await tx.$queryRawUnsafe(
            `SELECT round(ST_Distance(ST_MakePoint(0,0)::geography, ST_MakePoint(0,1)::geography)::numeric,1) AS m`,
          )) as Array<{ m: unknown }>;
          await tx.$executeRawUnsafe(`CREATE TEMP TABLE wave0_geo (id int, geog geography(Point,4326)) ON COMMIT DROP`);
          await tx.$executeRawUnsafe(`CREATE INDEX wave0_geo_gix ON wave0_geo USING GIST (geog)`);
          await tx.$executeRawUnsafe(`INSERT INTO wave0_geo SELECT g, ST_MakePoint(0, g*0.0005)::geography FROM generate_series(1,500) g`);
          await tx.$executeRawUnsafe(`ANALYZE wave0_geo`);
          await tx.$executeRawUnsafe(`SET LOCAL enable_seqscan = off`);
          const within = (await tx.$queryRawUnsafe(
            `SELECT count(*)::int AS n FROM wave0_geo WHERE ST_DWithin(geog, ST_MakePoint(0,0)::geography, 300)`,
          )) as Array<{ n: number }>;
          const plan = (await tx.$queryRawUnsafe(
            `EXPLAIN SELECT id FROM wave0_geo WHERE ST_DWithin(geog, ST_MakePoint(0,0)::geography, 300)`,
          )) as Array<Record<string, string>>;
          const planText = plan.map((r) => Object.values(r)[0]).join(' | ');
          return {
            distanceMeters: dist[0]?.m ?? null,
            dWithinCount: within[0]?.n ?? null,
            gistIndexUsed: /Index Scan|Index Only Scan|Bitmap Index Scan/i.test(planText),
          };
        }),
      );
      const g = (geo.value ?? {}) as { distanceMeters?: unknown; dWithinCount?: unknown; gistIndexUsed?: boolean };
      detail.geoSmoke = { ms: round2(geo.ms), ...g, error: geo.error ?? null };
      if (geo.error) {
        notes.push(`geospatial smoke FAILED: ${geo.error}`);
      } else {
        notes.push(`geospatial: ST_Distance OK; ST_DWithin matched ${String(g.dWithinCount)} rows; GiST index used by planner=${g.gistIndexUsed}.`);
        if (!g.gistIndexUsed) notes.push('WARN: ST_DWithin did not plan a GiST index scan — Discovery relies on GiST; investigate before Wave 1.');
      }
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
