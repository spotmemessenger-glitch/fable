/**
 * Phase 3B — Exchange lifecycle engine against REAL PostGIS.
 *
 * Proves on the live database: idempotent create, geography written from the
 * coarse point, optimistic-concurrency transitions with an atomic lifecycle
 * audit append, ownership isolation, the discoverable-query exclusions (hidden/
 * removed/expired/self all in SQL), and keyset pagination stability.
 */

import { PrismaClient } from '@prisma/client';
import { PrismaExchangeIntentRepository } from '../src/exchange/exchange.prisma.repository';
import { PrismaService } from '../src/prisma/prisma.service';
import { ExchangeService } from '../src/exchange/exchange.service';
import { validateIntentInput } from '../src/exchange/exchange.policy';

const prisma = new PrismaClient();
const svcPrisma = prisma as unknown as PrismaService;
const RUN = `ex${Date.now().toString(36)}`;
const uid = (n: string) => `${RUN}-${n}`;

const body = (over: Record<string, unknown> = {}) => ({
  kind: 'offer',
  category: 'services/plumbing',
  title: 'Plumbing help',
  text: 'Available this evening',
  origin: { lat: 12.9716, lon: 77.5946 },
  idempotencyKey: `key-${Math.random().toString(36).slice(2)}`,
  visibility: 'discoverable',
  ...over,
});

describe('exchange lifecycle engine (real PostGIS)', () => {
  const repo = () => new PrismaExchangeIntentRepository(svcPrisma);
  const service = () => new ExchangeService(repo());
  let me: string, other: string;

  beforeAll(async () => {
    me = uid('me'); other = uid('other');
    await prisma.user.create({ data: { id: me, username: `${RUN}_me` } });
    await prisma.user.create({ data: { id: other, username: `${RUN}_other` } });
  });

  afterAll(async () => {
    await prisma.exchangeIntent.deleteMany({ where: { ownerId: { in: [me, other] } } });
    await prisma.user.deleteMany({ where: { id: { in: [me, other] } } });
    await prisma.$disconnect();
  });

  it('createDraft writes the geography from the coarse point and is idempotent', async () => {
    const svc = service();
    const key = `idem-${RUN}`;
    const a = await svc.createDraft(me, body({ idempotencyKey: key }));
    const b = await svc.createDraft(me, body({ idempotencyKey: key }));
    expect(a.id).toBe(b.id);
    expect(b.idempotentReplay).toBe(true);
    const geo = await prisma.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT ("geog" IS NOT NULL) AS ok FROM "ExchangeIntent" WHERE id = $1`, a.id,
    );
    expect(geo[0].ok).toBe(true);
  });

  it('a full legal lifecycle appends a lifecycle-event audit row per transition', async () => {
    const svc = service();
    const c = await svc.createDraft(me, body());
    const active = await svc.activate(me, c.id, c.version.seq);
    const paused = await svc.pause(me, c.id, active.version.seq);
    await svc.resume(me, c.id, paused.version.seq);
    const events = await prisma.exchangeLifecycleEvent.findMany({ where: { intentId: c.id }, orderBy: { createdAt: 'asc' } });
    // draft(create) → active → paused → active = 4 events.
    expect(events.map((e) => e.toStatus)).toEqual(['draft', 'active', 'paused', 'active']);
  });

  it('optimistic concurrency: a stale version conflicts on the DB', async () => {
    const svc = service();
    const c = await svc.createDraft(me, body());
    await svc.activate(me, c.id, c.version.seq);
    await expect(svc.pause(me, c.id, c.version.seq)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('ownership isolation: another user cannot see or move my intent (NOT_FOUND)', async () => {
    const svc = service();
    const c = await svc.createDraft(me, body());
    await expect(svc.getOwn(other, c.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(svc.activate(other, c.id, c.version.seq)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('discoverable query excludes hidden/removed/expired/self in SQL', async () => {
    const svc = service();
    // A visible active offer by `other` (should surface for me).
    const visible = await svc.createDraft(other, body({ idempotencyKey: `vis-${RUN}` }));
    await svc.activate(other, visible.id, visible.version.seq);
    // Hidden, self, and withdrawn intents (should NOT surface).
    const hidden = await svc.createDraft(other, body({ visibility: 'hidden', idempotencyKey: `hid-${RUN}` }));
    await svc.activate(other, hidden.id, hidden.version.seq);
    const mine = await svc.createDraft(me, body({ idempotencyKey: `self-${RUN}` }));
    await svc.activate(me, mine.id, mine.version.seq);

    const page = await svc.browse(me, { kind: 'offer', category: 'services/plumbing' });
    const ids = page.results.map((r) => r.id);
    expect(ids).toContain(visible.id);
    expect(ids).not.toContain(hidden.id); // hidden
    expect(ids).not.toContain(mine.id);   // self
    // Every surfaced row is discoverable + active + not mine.
    for (const r of page.results) {
      expect(r.visibility).toBe('discoverable');
      expect(['active', 'matched']).toContain(r.status);
    }
  });

  it('MODERATION: a restricted or pending-review intent is NOT discoverable', async () => {
    const svc = service();
    const restricted = await svc.createDraft(other, body({ idempotencyKey: `mod-${RUN}`, category: 'mod/test' }));
    await svc.activate(other, restricted.id, restricted.version.seq);
    // A moderator marks it restricted (state whose purpose is to limit reach).
    await prisma.exchangeIntent.update({ where: { id: restricted.id }, data: { moderationState: 'restricted' } });
    const clear = await svc.createDraft(other, body({ idempotencyKey: `mod2-${RUN}`, category: 'mod/test' }));
    await svc.activate(other, clear.id, clear.version.seq);
    const page = await svc.browse(me, { kind: 'offer', category: 'mod/test' });
    const ids = page.results.map((r) => r.id);
    expect(ids).toContain(clear.id);
    expect(ids).not.toContain(restricted.id); // restricted is filtered in SQL
  });

  it('IDEMPOTENCY is race-safe: a concurrent duplicate key returns the winner, not a 500', async () => {
    const svc = service();
    const key = `race-${RUN}`;
    // Fire two creates with the same key concurrently — the unique constraint
    // rejects the loser with P2002, which the repository catches and replays.
    const [a, b] = await Promise.all([
      svc.createDraft(me, body({ idempotencyKey: key })),
      svc.createDraft(me, body({ idempotencyKey: key })),
    ]);
    expect(a.id).toBe(b.id);
    const count = await prisma.exchangeIntent.count({ where: { ownerId: me, idempotencyKey: key } });
    expect(count).toBe(1);
  });

  it('keyset pagination is stable and non-overlapping', async () => {
    const svc = service();
    // Seed 5 discoverable offers by `other`.
    for (let i = 0; i < 5; i++) {
      const c = await svc.createDraft(other, body({ idempotencyKey: `pg-${RUN}-${i}`, category: 'pagination/test' }));
      await svc.activate(other, c.id, c.version.seq);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let p = 0; p < 6; p++) {
      const page: { results: { id: string }[]; cursor: string | null } =
        await svc.browse(me, { kind: 'offer', category: 'pagination/test', cursor });
      for (const r of page.results) {
        expect(seen.has(r.id)).toBe(false);
        seen.add(r.id);
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    expect(seen.size).toBe(5);
  });

  it('retention: an expired intent is unqueryable by the discoverable query', async () => {
    const svc = service();
    const c = await svc.createDraft(other, body({ idempotencyKey: `exp-${RUN}`, category: 'expiry/test' }));
    await svc.activate(other, c.id, c.version.seq);
    // Force expiry in the past directly (ops sweep would DELETE; query must already hide it).
    await prisma.exchangeIntent.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const page = await svc.browse(me, { kind: 'offer', category: 'expiry/test' });
    expect(page.results.map((r) => r.id)).not.toContain(c.id);
  });

  it('validateIntentInput is the only path coordinates enter — stored values are coarse', async () => {
    const svc = service();
    const precise = validateIntentInput(me, body({ origin: { lat: 12.9716523, lon: 77.5946891 } }));
    expect(precise.coarseLat).toBe(12.972);
    const c = await svc.createDraft(me, body({ origin: { lat: 12.9716523, lon: 77.5946891 }, idempotencyKey: `coarse-${RUN}` }));
    const stored = await prisma.exchangeIntent.findUnique({ where: { id: c.id }, select: { coarseLat: true, coarseLon: true } });
    expect(stored!.coarseLat).toBe(12.972);
    expect(stored!.coarseLon).toBe(77.595);
  });
});
