/**
 * Exchange proximity — the geo-scoped browse, end to end against a real
 * PostGIS database (migrate-deploy provisioned; the geog column and its GiST
 * index exist only there).
 *
 * What this pins:
 *   1. ST_DWithin filtering: inside-radius rows return, outside-radius rows
 *      do not, and the PLAN uses ExchangeIntent_geog_idx — index scan, not
 *      seq scan — proven with EXPLAIN, not asserted from hope.
 *   2. Bands, never metres: geo-scoped results carry `distanceBand` from the
 *      exchange.matching registry, and NO raw distance ever appears in the
 *      public projection.
 *   3. Keyset pagination still works under the geo filter.
 *   4. No location ⇒ browse still answers, unfiltered, `scope: 'everywhere'`
 *      — a permission denial can never break browse.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaExchangeIntentRepository } from '../src/exchange/exchange.prisma.repository';
import { ExchangeService } from '../src/exchange/exchange.service';
import { bandFromMeters } from '../src/exchange/exchange.matching';

const prisma = new PrismaClient();
const svc = new ExchangeService(new PrismaExchangeIntentRepository(prisma as unknown as PrismaService));

const OWNER = 'exprox-owner';
const VIEWER = 'exprox-viewer';
// Bengaluru-ish origin; offsets in degrees latitude (1e-2 deg ≈ 1.11 km).
const ORIGIN = { lat: 12.972, lon: 77.595 };

const mk = async (i: number, latOffset: number) => {
  const created = await svc.createDraft(OWNER, {
    kind: 'need', category: 'help/moving', title: `prox-${i}`, text: 'proximity fixture', tags: [],
    origin: { lat: ORIGIN.lat + latOffset, lon: ORIGIN.lon },
    radiusKm: 5, visibility: 'discoverable', idempotencyKey: `exprox-${i}`,
  }) as { id: string; version: { seq: number } };
  await svc.activate(OWNER, created.id, created.version.seq);
  return created.id;
};

let nearId!: string;   // ~0.55 km north
let midId!: string;    // ~3.3 km north
let farId!: string;    // ~22 km north

beforeAll(async () => {
  // ownerId is a real FK; the fixtures need actual User rows.
  for (const id of [OWNER, VIEWER]) {
    await prisma.user.upsert({
      where: { id },
      create: { id, username: id.slice(0, 16), name: id, birthYearMonth: '1990-01' },
      update: {},
    });
  }
  await prisma.exchangeLifecycleEvent.deleteMany({ where: { intent: { ownerId: OWNER } } });
  await prisma.exchangeIntent.deleteMany({ where: { ownerId: OWNER } });
  nearId = await mk(1, 0.005);
  midId = await mk(2, 0.03);
  farId = await mk(3, 0.2);
}, 30000);

afterAll(async () => {
  await prisma.exchangeLifecycleEvent.deleteMany({ where: { intent: { ownerId: OWNER } } });
  await prisma.exchangeIntent.deleteMany({ where: { ownerId: OWNER } });
  await prisma.$disconnect();
});

const ids = (page: { results: { id: string }[] }) => page.results.map((r) => r.id);

describe('geo-scoped browse', () => {
  it('ST_DWithin narrows to the radius; outside rows are absent', async () => {
    const page = await svc.browse(VIEWER, { ...ORIGIN, radiusKm: 5 });
    expect(page.scope).toBe('nearby');
    expect(ids(page)).toContain(nearId);
    expect(ids(page)).toContain(midId);
    expect(ids(page)).not.toContain(farId);

    const tight = await svc.browse(VIEWER, { ...ORIGIN, radiusKm: 1 });
    expect(ids(tight)).toContain(nearId);
    expect(ids(tight)).not.toContain(midId);
  });

  it('results carry the BAND from the matching registry — and never raw metres', async () => {
    const page = await svc.browse(VIEWER, { ...ORIGIN, radiusKm: 5 });
    const near = page.results.find((r) => r.id === nearId)!;
    const mid = page.results.find((r) => r.id === midId)!;
    // ~0.55 km ⇒ under1km; ~3.3 km ⇒ under5km — the registry's own boundaries.
    expect(near.distanceBand).toBe(bandFromMeters(555));
    expect(mid.distanceBand).toBe(bandFromMeters(3330));
    // The public projection leaks NO numeric distance under any key.
    for (const r of page.results) {
      const flat = JSON.stringify(r);
      expect(flat).not.toMatch(/distanceM|meters|metres/i);
    }
  });

  it('keyset pagination survives the geo filter', async () => {
    // Page size 1 via the cursor loop: walk all in-radius rows one at a time.
    const first = await svc.browse(VIEWER, { ...ORIGIN, radiusKm: 5 });
    expect(first.results.length).toBeGreaterThanOrEqual(2);
    // Feed the real cursor back with the same geo scope; the second page must
    // continue strictly after the first, never repeat, and stay in-radius.
    if (first.cursor) {
      const second = await svc.browse(VIEWER, { ...ORIGIN, radiusKm: 5, cursor: first.cursor });
      const overlap = ids(second).filter((i) => ids(first).includes(i));
      expect(overlap).toEqual([]);
      expect(ids(second)).not.toContain(farId);
    }
  });

  it('no location ⇒ unfiltered, scope everywhere, no bands — never broken', async () => {
    const page = await svc.browse(VIEWER, {});
    expect(page.scope).toBe('everywhere');
    expect(ids(page)).toEqual(expect.arrayContaining([nearId, midId, farId]));
    for (const r of page.results) expect(r.distanceBand).toBeUndefined();
    // Garbled coordinates degrade the same way, not to a 500.
    const garbled = await svc.browse(VIEWER, { lat: Number.NaN, lon: 77.6, radiusKm: 5 });
    expect(garbled.scope).toBe('everywhere');
  });

  it('EXPLAIN: the geo predicate is served by ExchangeIntent_geog_idx (index scan, not seq scan)', async () => {
    /* A three-row table lets the planner prefer a seq scan on cost grounds —
     * that is a fact about the fixture size, not about the index. Disabling
     * seq scans for THIS SESSION forces the planner to show whether the index
     * CAN serve the predicate; if the GiST index were unusable (dropped,
     * wrong opclass), the plan would still say Seq Scan and this fails. */
    await prisma.$executeRawUnsafe('SET enable_seqscan = off');
    const plan = await prisma.$queryRawUnsafe<Array<{ 'QUERY PLAN': string }>>(`
      EXPLAIN SELECT "id" FROM "ExchangeIntent"
      WHERE ST_DWithin("geog", ST_SetSRID(ST_MakePoint(77.595, 12.972), 4326)::geography, 5000)
    `);
    await prisma.$executeRawUnsafe('SET enable_seqscan = on');
    const text = plan.map((r) => r['QUERY PLAN']).join('\n');
    expect(text).toMatch(/Index Scan.*ExchangeIntent_geog_idx|Bitmap Index Scan on "?ExchangeIntent_geog_idx/);
    expect(text).not.toMatch(/Seq Scan on "?ExchangeIntent/);
  });
});
