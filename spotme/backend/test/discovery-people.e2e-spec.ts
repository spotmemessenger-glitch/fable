/**
 * Checkpoint 5 — people discovery query engine against REAL PostGIS.
 *
 * Every privacy exclusion the repository contract promises is proven with
 * seeded rows on the live database: expired presence, self, blocks in both
 * directions, visibility off, non-discoverable profile — none may surface.
 * Ordering is nearest-first with the deterministic tie-breaker; pagination is
 * keyset-stable; output carries only the coarse values that were stored.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaDiscoveryPeopleRepository, PrismaDiscoveryVisibilityRepository } from '../src/discovery/discovery.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { DiscoveryService } from '../src/discovery/discovery.service';

const prisma = new PrismaClient();
const svcPrisma = prisma as unknown as PrismaService;

const RUN = `disc${Date.now().toString(36)}`;
const uid = (n: string) => `${RUN}-${n}`;

/** Origin for all queries. ~0.001 lat ≈ 111 m. */
const ORIGIN = { lat: 12.97, lon: 77.59 };
const NOW = new Date();
const soon = (mins: number) => new Date(NOW.getTime() + mins * 60_000);

async function seedUser(n: string, opts: {
  latOffset: number;
  enabled?: boolean;
  discoverable?: boolean;
  expired?: boolean;
  handle?: string;
} ) {
  const id = uid(n);
  await prisma.user.create({ data: { id, username: `${RUN}_${n}` } });
  await prisma.discoveryPublicProfileProjection.create({
    data: {
      userId: id,
      displayName: `Person ${n}`,
      discoverable: opts.discoverable ?? true,
      ...(opts.handle ? { handle: opts.handle, normalizedHandle: opts.handle.toLowerCase() } : {}),
    },
  });
  const repo = new PrismaDiscoveryVisibilityRepository(svcPrisma);
  await repo.setVisibility(id, {
    enabled: opts.enabled ?? true,
    coarseLat: ORIGIN.lat + opts.latOffset,
    coarseLon: ORIGIN.lon,
    coarseCell: `cell-${n}`,
    expiresAt: opts.expired ? new Date(NOW.getTime() - 60_000) : soon(25),
  });
  return id;
}

describe('people discovery engine (real PostGIS)', () => {
  const people = () => new PrismaDiscoveryPeopleRepository(svcPrisma);
  let me: string;

  beforeAll(async () => {
    me = uid('me');
    await prisma.user.create({ data: { id: me, username: `${RUN}_me` } });
    // Me: visible too — must NEVER appear in my own results.
    await prisma.discoveryPublicProfileProjection.create({
      data: { userId: me, displayName: 'Me', discoverable: true },
    });
    await new PrismaDiscoveryVisibilityRepository(svcPrisma).setVisibility(me, {
      enabled: true, coarseLat: ORIGIN.lat, coarseLon: ORIGIN.lon, coarseCell: 'cell-me', expiresAt: soon(25),
    });

    await seedUser('a100', { latOffset: 0.0009 });          // ~100 m → under500m
    await seedUser('b600', { latOffset: 0.0054 });          // ~600 m → under1km
    await seedUser('c1500', { latOffset: 0.0135 });         // ~1.5 km → under2km
    await seedUser('d3000', { latOffset: 0.027 });          // ~3 km → under5km
    await seedUser('e6000', { latOffset: 0.054 });          // ~6 km → over5km
    await seedUser('expired', { latOffset: 0.001, expired: true });
    await seedUser('off', { latOffset: 0.001, enabled: false });
    await seedUser('hidden', { latOffset: 0.001, discoverable: false });
    const blockedByMe = await seedUser('blockedByMe', { latOffset: 0.001 });
    const blocksMe = await seedUser('blocksMe', { latOffset: 0.001 });
    await prisma.discoveryBlockProjection.createMany({
      data: [
        { ownerUserId: me, blockedUserId: blockedByMe },
        { ownerUserId: blocksMe, blockedUserId: me },
      ],
    });
  }, 30000);

  afterAll(async () => {
    await prisma.discoveryBlockProjection.deleteMany({ where: { OR: [{ ownerUserId: { startsWith: RUN } }, { blockedUserId: { startsWith: RUN } }] } });
    await prisma.user.deleteMany({ where: { id: { startsWith: RUN } } }); // cascades visibility+projection
    await prisma.$disconnect();
  }, 30000);

  const query = (over: Partial<Parameters<PrismaDiscoveryPeopleRepository['findNearbyPeople']>[0]> = {}) =>
    people().findNearbyPeople({
      principalId: me,
      originLat: ORIGIN.lat,
      originLon: ORIGIN.lon,
      radiusKm: 10,
      limit: 50,
      cursor: null,
      now: new Date(),
      ...over,
    });

  it('returns nearest-first and applies EVERY exclusion in SQL', async () => {
    const rows = await query();
    const ids = rows.map((r) => r.userId);
    expect(ids).toEqual([uid('a100'), uid('b600'), uid('c1500'), uid('d3000'), uid('e6000')]);
    for (const bad of ['me', 'expired', 'off', 'hidden', 'blockedByMe', 'blocksMe']) {
      expect(ids).not.toContain(uid(bad));
    }
  });

  it('distances derive the correct bands and stay server-internal coarse values', async () => {
    const rows = await query();
    expect(rows[0].coarseDistanceM).toBeGreaterThan(50);
    expect(rows[0].coarseDistanceM).toBeLessThan(500);
    expect(rows[1].coarseDistanceM).toBeGreaterThan(500);
    expect(rows[1].coarseDistanceM).toBeLessThan(1000);
    // Output coords are exactly the stored COARSE values, nothing finer.
    expect(rows[0].coarseLat).toBeCloseTo(ORIGIN.lat + 0.0009, 10);
    expect(rows[0].coarseCell).toBe('cell-a100');
  });

  it('bounded radius: a 1 km radius drops everything beyond it', async () => {
    const rows = await query({ radiusKm: 1 });
    expect(rows.map((r) => r.userId)).toEqual([uid('a100'), uid('b600')].slice(0, rows.length));
    expect(rows.length).toBeLessThanOrEqual(2);
  });

  it('keyset pagination: pages are disjoint, ordered, and their union is complete', async () => {
    const p1 = await query({ limit: 2 });
    expect(p1).toHaveLength(2);
    const last = p1[p1.length - 1];
    const p2 = await query({ limit: 10, cursor: { d: last.coarseDistanceM, u: last.userId } });
    const ids1 = p1.map((r) => r.userId);
    const ids2 = p2.map((r) => r.userId);
    expect(ids2.some((i) => ids1.includes(i))).toBe(false);
    expect([...ids1, ...ids2]).toEqual([uid('a100'), uid('b600'), uid('c1500'), uid('d3000'), uid('e6000')]);
  });

  it('service end-to-end over the real repository: bands only, breakdown present', async () => {
    const vis = new PrismaDiscoveryVisibilityRepository(svcPrisma);
    const svc = new DiscoveryService(people(), vis);
    const page = await svc.queryPeople(me, {
      contractsVersion: 1,
      intent: { kind: 'people' },
      scope: 'people',
      origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
      radius: { km: 10 },
    });
    expect(page.results.length).toBeGreaterThanOrEqual(5);
    const first = page.results[0];
    expect(first.type === 'person' && first.person.distanceBand).toBe('under500m');
    expect(first.ranking.components.length).toBeGreaterThan(0);
    const json = JSON.stringify(page);
    expect(json).not.toContain('coarseDistanceM');
  });

  it('visibility upsert bumps the monotonic version (C-REPLAY)', async () => {
    const vis = new PrismaDiscoveryVisibilityRepository(svcPrisma);
    const v1 = await vis.setVisibility(me, { enabled: true, coarseLat: ORIGIN.lat, coarseLon: ORIGIN.lon, coarseCell: 'cell-me', expiresAt: soon(30) });
    const v2 = await vis.setVisibility(me, { enabled: false, coarseLat: ORIGIN.lat, coarseLon: ORIGIN.lon, coarseCell: 'cell-me', expiresAt: soon(30) });
    expect(v2.visibilityVersion).toBeGreaterThan(v1.visibilityVersion);
    const read = await vis.getVisibility(me);
    expect(read?.enabled).toBe(false);
  });
});
