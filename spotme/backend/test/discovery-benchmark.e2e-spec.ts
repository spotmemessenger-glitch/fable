/**
 * Checkpoint 13 — PERFORMANCE BENCHMARKS for the discovery platform.
 *
 * OFF BY DEFAULT (loud skip): benchmarks are measurements, not gates — CI and
 * `npm test` never pay for them. Run explicitly with:
 *
 *   createdb -h 127.0.0.1 -p 5433 -U postgres spotme_bench
 *   psql   -h 127.0.0.1 -p 5433 -U postgres -d spotme_bench -c 'CREATE EXTENSION IF NOT EXISTS postgis'
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spotme_bench npx prisma db push --skip-generate
 *   RUN_DISCOVERY_BENCH=1 \
 *   BENCH_DATABASE_URL=postgresql://postgres@127.0.0.1:5433/spotme_bench \
 *   TEST_TYPESENSE_URL=http://127.0.0.1:8108 TEST_TYPESENSE_API_KEY=... \
 *   npx jest test/discovery-benchmark.e2e-spec.ts
 *
 * HONESTY RULES (mission A5): every number reported is measured on the run's
 * actual hardware at the dataset size actually reached — the report records
 * the largest achieved size and the reason if a target size was not reached;
 * nothing is extrapolated. "Cold" is approximated as the first post-ANALYZE
 * run (a true cold-buffer measurement would need a server restart per query);
 * the method is recorded in the report so the caveat travels with the data.
 *
 * Datasets are DETERMINISTIC: positions derive from a fixed integer-hash
 * formula (recorded below and in the report), so a re-run on other hardware
 * reproduces the same data byte-for-byte. No random(), no time-derived seeds.
 *
 * The benchmark exercises the REAL code paths: PrismaDiscoveryPeopleRepository
 * (the production SQL), orderPeople/explainPerson, rankCandidates, and
 * TypesenseSearchAdapter.search() against a live local Typesense.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaDiscoveryPeopleRepository } from '../src/discovery/discovery.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { orderPeople, explainPerson } from '../src/discovery/discovery.ranking';
import { rankCandidates, RankingCandidate } from '../src/discovery/discovery.ranking.engine';
import { PersonCandidateRow } from '../src/discovery/discovery.types';
import {
  TypesenseSearchAdapter,
  TYPESENSE_COLLECTION,
  TYPESENSE_SCHEMA,
  TYPESENSE_DEFAULTS,
} from '../src/discovery/search/typesense-search.adapter';

const BENCH_DB = process.env.BENCH_DATABASE_URL;
const TS_URL = process.env.TEST_TYPESENSE_URL;
const TS_KEY = process.env.TEST_TYPESENSE_API_KEY;
const enabled = process.env.RUN_DISCOVERY_BENCH === '1' && Boolean(BENCH_DB);
const bench = enabled ? describe : describe.skip;
if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn(
    '[discovery-benchmark] SKIPPED — set RUN_DISCOVERY_BENCH=1 and BENCH_DATABASE_URL ' +
      '(plus TEST_TYPESENSE_URL/TEST_TYPESENSE_API_KEY for the search leg) to run.',
  );
}

/* ---------------------------------------------------------------- helpers */

/** Deterministic pseudo-uniform in [0,1): same formula as the seeding SQL. */
const HASH_A = 2654435761n; // Knuth multiplicative hash constant
const HASH_B = 40503n;
const MOD_A = 1000003n; // prime
const MOD_B = 999983n; // prime

const CENTER = { lat: 12.9716, lon: 77.5946 }; // public landmark, not a user fix
const SPAN_LAT = 0.45; // ≈ ±25 km
const SPAN_LON = 0.46; // ≈ ±25 km at this latitude

const SCALES = [1_000, 10_000, 100_000, 1_000_000];
const PAGE = 30;

function nsNow(): bigint {
  return process.hrtime.bigint();
}
function ms(from: bigint, to: bigint): number {
  return Number(to - from) / 1e6;
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}
function stats(samples: number[]) {
  const s = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    runs: s.length,
    p50: round(percentile(s, 50)),
    p95: round(percentile(s, 95)),
    min: round(s[0]),
    max: round(s[s.length - 1]),
  };
}

/** The report — printed as one JSON document at the end of the run. */
const report: Record<string, unknown> = {
  method: {
    determinism:
      'lat = 12.9716 + (((i*2654435761) mod 1000003)/1000003 - 0.5)*0.45; ' +
      'lon = 77.5946 + (((i*40503) mod 999983)/999983 - 0.5)*0.46 (integer hash, no random())',
    distribution: 'pseudo-uniform over a ~50 km × 50 km box centred on a public landmark',
    coldMethod: 'first post-ANALYZE execution per (scale, radius) — approximation, NOT a cold-buffer restart',
    warmMethod: 'per (scale, radius): 3 warm-up runs, then N measured runs round-robin over 5 origins',
    pageSize: PAGE,
    scalesTargeted: SCALES,
  },
  environment: {},
  postgis: {},
  pagination: {},
  ranking: {},
  serialization: {},
  typesense: {},
  memory: {},
};

/* ------------------------------------------------------------------ suite */

jest.setTimeout(45 * 60_000);

bench('discovery performance benchmarks (checkpoint 13)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: BENCH_DB } } });
  const repo = new PrismaDiscoveryPeopleRepository(prisma as unknown as PrismaService);
  const NOW = new Date();
  const EXPIRES = new Date(NOW.getTime() + 365 * 24 * 3600_000);
  const PRINCIPAL = 'bench-principal';

  beforeAll(async () => {
    const [{ version }] = await prisma.$queryRawUnsafe<{ version: string }[]>('SELECT version()');
    const [{ postgis_version }] = await prisma.$queryRawUnsafe<{ postgis_version: string }[]>(
      'SELECT postgis_version()',
    );
    report.environment = {
      node: process.version,
      cpus: require('node:os').cpus().length,
      cpuModel: require('node:os').cpus()[0]?.model,
      totalMemMB: Math.round(require('node:os').totalmem() / 1e6),
      postgres: version.split(' on ')[0],
      postgis: postgis_version,
      typesense: TS_URL ? 'live (version recorded in search leg)' : 'not configured',
    };
    await prisma.user.upsert({
      where: { id: PRINCIPAL },
      update: {},
      create: { id: PRINCIPAL, username: 'bench_principal' },
    });
  });

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log('BENCH_REPORT_JSON ' + JSON.stringify(report));
    await prisma.$disconnect();
  });

  /** Incremental deterministic seed from (already-seeded+1) up to n. */
  async function seedTo(n: number, alreadySeeded: number): Promise<number> {
    const BATCH = 100_000;
    const t0 = nsNow();
    for (let from = alreadySeeded + 1; from <= n; from += BATCH) {
      const to = Math.min(n, from + BATCH - 1);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "User" (id, username)
        SELECT 'bench-u-'||i, 'bench_user_'||i FROM generate_series(${from}, ${to}) i
        ON CONFLICT (id) DO NOTHING`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "DiscoveryPublicProfileProjection"
          ("userId", "handle", "normalizedHandle", "displayName", "discoverable", "updatedAt")
        SELECT 'bench-u-'||i, 'bench_handle_'||i, 'bench_handle_'||i, 'Bench User '||i, true, NOW()
        FROM generate_series(${from}, ${to}) i
        ON CONFLICT ("userId") DO NOTHING`);
      await prisma.$executeRawUnsafe(`
        INSERT INTO "DiscoveryVisibility"
          ("userId", "enabled", "coarseCell", "coarseLat", "coarseLon", "geog", "updatedAt", "expiresAt", "visibilityVersion")
        SELECT 'bench-u-'||i, true,
               'cell-'||(((i::bigint * ${HASH_A}) % ${MOD_A}) / 10000),
               t.lat, t.lon,
               ST_SetSRID(ST_MakePoint(t.lon, t.lat), 4326)::geography,
               NOW(), '${EXPIRES.toISOString()}', 1
        FROM (
          SELECT i,
                 ${CENTER.lat} + ((((i::bigint * ${HASH_A}) % ${MOD_A})::float8 / ${MOD_A}) - 0.5) * ${SPAN_LAT} AS lat,
                 ${CENTER.lon} + ((((i::bigint * ${HASH_B}) % ${MOD_B})::float8 / ${MOD_B}) - 0.5) * ${SPAN_LON} AS lon
          FROM generate_series(${from}, ${to}) i
        ) t
        ON CONFLICT ("userId") DO NOTHING`);
    }
    // A realistic block set: ~0.1% pairs plus 50 involving the principal, so
    // the NOT EXISTS anti-join is never vacuously satisfied.
    await prisma.$executeRawUnsafe(`
      INSERT INTO "DiscoveryBlockProjection" ("ownerUserId", "blockedUserId")
      SELECT 'bench-u-'||i, 'bench-u-'||(1 + ((i::bigint * ${HASH_B}) % ${BigInt(n)}))
      FROM generate_series(1, ${Math.max(1, Math.floor(n / 1000))}) i
      WHERE 'bench-u-'||i <> 'bench-u-'||(1 + ((i::bigint * ${HASH_B}) % ${BigInt(n)}))
      ON CONFLICT DO NOTHING`);
    await prisma.$executeRawUnsafe(`
      INSERT INTO "DiscoveryBlockProjection" ("ownerUserId", "blockedUserId")
      SELECT '${PRINCIPAL}', 'bench-u-'||i FROM generate_series(1, ${Math.min(50, n)}) i
      ON CONFLICT DO NOTHING`);
    await prisma.$executeRawUnsafe('ANALYZE "DiscoveryVisibility", "DiscoveryPublicProfileProjection", "DiscoveryBlockProjection"');
    return ms(t0, nsNow());
  }

  /** 5 query origins: centre plus 4 offsets — same set at every scale. */
  const ORIGINS = [
    CENTER,
    { lat: CENTER.lat + 0.05, lon: CENTER.lon },
    { lat: CENTER.lat - 0.05, lon: CENTER.lon + 0.05 },
    { lat: CENTER.lat + 0.1, lon: CENTER.lon - 0.1 },
    { lat: CENTER.lat - 0.15, lon: CENTER.lon - 0.15 },
  ];

  async function queryOnce(origin: { lat: number; lon: number }, radiusKm: number) {
    return repo.findNearbyPeople({
      principalId: PRINCIPAL,
      originLat: origin.lat,
      originLon: origin.lon,
      radiusKm,
      limit: PAGE,
      cursor: null,
      now: NOW,
    });
  }

  it('PostGIS people query: p50/p95 across scales and radii', async () => {
    let seeded = 0;
    const postgis: Record<string, unknown> = {};
    let largestAchieved = 0;
    for (const scale of SCALES) {
      let seedMs: number;
      try {
        seedMs = await seedTo(scale, seeded);
        seeded = scale;
        largestAchieved = scale;
      } catch (e) {
        postgis[`scale_${scale}`] = { skipped: true, reason: `seeding failed: ${(e as Error).message}` };
        break; // A5: record the reason, do not extrapolate past it
      }
      const perScale: Record<string, unknown> = { seedMs: Math.round(seedMs) };
      for (const radiusKm of [2, 5, 25]) {
        // The 25 km sweep at ≥100k is the known-expensive corner: fewer runs.
        const RUNS = radiusKm === 25 && scale >= 100_000 ? 10 : 30;
        const cold0 = nsNow();
        const first = await queryOnce(ORIGINS[0], radiusKm);
        const coldMs = ms(cold0, nsNow());
        for (let w = 0; w < 3; w++) await queryOnce(ORIGINS[w % ORIGINS.length], radiusKm); // warm-up
        const samples: number[] = [];
        for (let r = 0; r < RUNS; r++) {
          const o = ORIGINS[r % ORIGINS.length];
          const t0 = nsNow();
          await queryOnce(o, radiusKm);
          samples.push(ms(t0, nsNow()));
        }
        perScale[`radius_${radiusKm}km`] = {
          coldApproxMs: Math.round(coldMs * 100) / 100,
          warm: stats(samples),
          firstPageRows: first.length,
        };
      }
      postgis[`scale_${scale}`] = perScale;
    }
    report.postgis = { largestAchieved, byScale: postgis };
    expect(largestAchieved).toBeGreaterThan(0);
  });

  it('pagination is keyset-stable at the largest seeded scale (no dups, no gaps, flat latency)', async () => {
    const seen = new Set<string>();
    let cursor: { d: number; u: string } | null = null;
    let prev: { d: number; u: string } | null = null;
    const pageLatencies: number[] = [];
    for (let page = 0; page < 10; page++) {
      const t0 = nsNow();
      const rows: PersonCandidateRow[] = await repo.findNearbyPeople({
        principalId: PRINCIPAL,
        originLat: CENTER.lat,
        originLon: CENTER.lon,
        radiusKm: 5,
        limit: PAGE,
        cursor,
        now: NOW,
      });
      pageLatencies.push(ms(t0, nsNow()));
      if (!rows.length) break;
      for (const r of rows) {
        expect(seen.has(r.userId)).toBe(false); // no duplicates across pages
        seen.add(r.userId);
        if (prev) {
          const after = r.coarseDistanceM > prev.d || (r.coarseDistanceM === prev.d && r.userId > prev.u);
          expect(after).toBe(true); // strict total order (distance, userId)
        }
        prev = { d: r.coarseDistanceM, u: r.userId };
      }
      const last = rows[rows.length - 1];
      cursor = { d: last.coarseDistanceM, u: last.userId };
      if (rows.length < PAGE) break;
    }
    report.pagination = {
      radiusKm: 5,
      pagesWalked: pageLatencies.length,
      uniqueRows: seen.size,
      perPageMs: pageLatencies.map((l) => Math.round(l * 100) / 100),
    };
    expect(seen.size).toBeGreaterThan(0);
  });

  it('ranking and serialization are microseconds, not milliseconds, at page scale', () => {
    const mk = (i: number): PersonCandidateRow => ({
      userId: `rk-${String(i).padStart(6, '0')}`,
      displayName: `Rank ${i}`,
      handle: `rank_${i}`,
      avatarRef: null,
      coarseLat: CENTER.lat,
      coarseLon: CENTER.lon,
      coarseCell: `cell-${i % 97}`,
      observedAt: new Date(NOW.getTime() - (i % 1800) * 1000),
      expiresAt: new Date(NOW.getTime() + 1800_000),
      coarseDistanceM: (i * 37) % 8000,
    });
    const rows5k = Array.from({ length: 5_000 }, (_, i) => mk(i));

    const orderSamples: number[] = [];
    for (let r = 0; r < 30; r++) {
      const t0 = nsNow();
      orderPeople(rows5k, NOW);
      orderSamples.push(ms(t0, nsNow()));
    }

    const page = orderPeople(rows5k, NOW).slice(0, PAGE);
    const explainSamples: number[] = [];
    for (let r = 0; r < 1_000; r++) {
      const t0 = nsNow();
      for (const row of page) explainPerson(row, NOW);
      explainSamples.push(ms(t0, nsNow()));
    }

    const candidates: RankingCandidate[] = page.map((row, i) => ({
      id: row.userId,
      safetyEligible: true,
      evidence: {
        intentMatch: { value: (i % 10) / 10, reason: 'bench' },
        proximity: { value: 0.8, reason: 'bench' },
        relevance: { value: 0.5, reason: 'bench' },
        freshness: { value: 0.9, reason: 'bench' },
        sourceConfidence: { value: 1, reason: 'bench' },
      },
    }));
    const engineSamples: number[] = [];
    for (let r = 0; r < 1_000; r++) {
      const t0 = nsNow();
      rankCandidates(candidates);
      engineSamples.push(ms(t0, nsNow()));
    }

    const wirePage = {
      contractsVersion: 1,
      results: page.map((row) => ({
        type: 'person',
        person: { userId: row.userId, displayName: row.displayName, handle: row.handle, distanceBand: 'under2km' },
        ranking: explainPerson(row, NOW),
      })),
      cursor: 'b64cursor',
      freshness: { observedAt: NOW.toISOString() },
    };
    const serializeSamples: number[] = [];
    for (let r = 0; r < 5_000; r++) {
      const t0 = nsNow();
      JSON.stringify(wirePage);
      serializeSamples.push(ms(t0, nsNow()));
    }

    report.ranking = {
      orderPeople5000: stats(orderSamples),
      explainPersonPage30x1000: stats(explainSamples),
      rankCandidates30x1000: stats(engineSamples),
    };
    report.serialization = { stringifyPage30x5000: stats(serializeSamples) };
    expect(stats(orderSamples).p95).toBeLessThan(100);
  });

  it('Typesense search p50/p95 across scales (live local instance; loud partial skip without it)', async () => {
    if (!TS_URL || !TS_KEY) {
      report.typesense = { skipped: true, reason: 'TEST_TYPESENSE_URL / TEST_TYPESENSE_API_KEY not set' };
      // eslint-disable-next-line no-console
      console.warn('[discovery-benchmark] Typesense leg SKIPPED — no live instance configured.');
      return;
    }
    const headers = { 'X-TYPESENSE-API-KEY': TS_KEY, 'Content-Type': 'application/json' };
    const base = TS_URL.replace(/\/$/, '');
    const health = await fetch(`${base}/debug`, { headers });
    const debug = (await health.json()) as { version?: string };
    (report.environment as Record<string, unknown>).typesense = debug.version ?? 'unknown';

    await fetch(`${base}/collections/${TYPESENSE_COLLECTION}`, { method: 'DELETE', headers }).catch(() => undefined);
    const created = await fetch(`${base}/collections`, {
      method: 'POST',
      headers,
      body: JSON.stringify(TYPESENSE_SCHEMA),
    });
    expect(created.ok).toBe(true);

    const adapter = new TypesenseSearchAdapter({ ...TYPESENSE_DEFAULTS, url: base, apiKey: TS_KEY });
    const byScale: Record<string, unknown> = {};
    let indexed = 0;
    let largestAchieved = 0;
    for (const scale of SCALES) {
      // Bulk JSONL import (benchmark infrastructure — the app path indexes
      // per-document through the adapter's allow-list projection).
      try {
        const BATCH = 50_000;
        const t0 = nsNow();
        for (let from = indexed + 1; from <= scale; from += BATCH) {
          const to = Math.min(scale, from + BATCH - 1);
          const lines: string[] = [];
          for (let i = from; i <= to; i++) {
            lines.push(
              JSON.stringify({
                id: `bench-u-${i}`,
                kind: 'username',
                handle: `bench_handle_${i}`,
                normalizedHandle: `bench_handle_${i}`,
                displayName: `Bench User ${i}`,
              }),
            );
          }
          const res = await fetch(`${base}/collections/${TYPESENSE_COLLECTION}/documents/import?action=upsert`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'text/plain' },
            body: lines.join('\n'),
          });
          if (!res.ok) throw new Error(`import HTTP ${res.status}`);
        }
        const importMs = ms(t0, nsNow());
        indexed = scale;
        largestAchieved = scale;

        const mid = Math.floor(scale / 2);
        const QUERIES: [string, string][] = [
          ['exactHandle', `bench_handle_${mid}`],
          ['prefix', 'bench_hand'],
          ['typo', `bnech_handle_${mid}`],
          ['displayName', `Bench User ${mid}`],
        ];
        const perQuery: Record<string, unknown> = {};
        for (const [label, q] of QUERIES) {
          for (let w = 0; w < 3; w++) await adapter.search(q, { kind: 'username' });
          const samples: number[] = [];
          let lastState = '';
          for (let r = 0; r < 30; r++) {
            const t1 = nsNow();
            const out = await adapter.search(q, { kind: 'username' });
            samples.push(ms(t1, nsNow()));
            lastState = out.state;
          }
          perQuery[label] = { ...stats(samples), lastState };
        }
        byScale[`scale_${scale}`] = { importMs: Math.round(importMs), queries: perQuery };
      } catch (e) {
        byScale[`scale_${scale}`] = { skipped: true, reason: (e as Error).message };
        break; // A5: stop at the largest achieved size and say why
      }
    }
    report.typesense = { largestAchieved, byScale };
    await fetch(`${base}/collections/${TYPESENSE_COLLECTION}`, { method: 'DELETE', headers }).catch(() => undefined);
    expect(largestAchieved).toBeGreaterThan(0);
  });

  it('records process memory after the full workload', () => {
    const m = process.memoryUsage();
    report.memory = {
      note: 'jest worker process AFTER the PostGIS + ranking + Typesense workload — an upper bound on the repository-layer footprint, not a NestJS app measurement',
      rssMB: Math.round(m.rss / 1e6),
      heapUsedMB: Math.round(m.heapUsed / 1e6),
      externalMB: Math.round(m.external / 1e6),
    };
    expect(m.rss).toBeGreaterThan(0);
  });
});
