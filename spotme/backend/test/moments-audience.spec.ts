/**
 * A1–A4 — THE AUTHOR SEES THEIR OWN POSTS, AND THE AUDIENCE IS REAL.
 *
 * Three independent clauses in `findFeed` excluded the author from their own
 * posts, and each looked reasonable alone:
 *
 *   1. `WHERE m."visibility" <> 'private'` — so a 'private' post was invisible
 *      to EVERYONE INCLUDING ITS AUTHOR. Not "only you": nobody. The composer
 *      offered the option and choosing it silently threw the post away.
 *   2. friends mode required a `MomentFollow` row, and nobody follows
 *      themselves — so posting to Friends and opening Friends showed an empty
 *      feed containing the post you had just made.
 *   3. nearby/city filtered on visibility and geography, so your own 'friends'
 *      post, or one with no fix, vanished from the tab you were looking at.
 *
 * These drive REAL HTTP against a real database, because the bug is in raw SQL
 * that a service-level test never executes.
 *
 * The moderation clause is deliberately asserted separately: `isAuthor` widens
 * WHO may see a post, and must never widen WHAT may be shown.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

const prisma = new PrismaClient();
const RUN = `ma${Date.now().toString(36)}`;
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;
const HERE = { lat: 12.9766, lon: 77.5913 };
let app: INestApplication;
let url: string;
let seq = 0;

async function account(tag: string): Promise<{ id: string; token: string }> {
  const n = (seq++).toString(16);
  const id = `${n}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${n}${tag}`.slice(0, 16);
  const r = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username, secret: `sec-${id}-12345678`, birthYearMonth: ADULT }),
  });
  const b = (await r.json()) as { accessToken?: string; userId?: string };
  return { id: b.userId ?? id, token: b.accessToken ?? '' };
}

const post = (token: string, visibility: string, text: string) =>
  fetch(`${url}/api/v1/moments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'text', text, mediaIds: [], visibility, location: HERE }),
  });

async function feed(token: string, mode: string): Promise<Array<{ id: string; visibility: string }>> {
  const qs = mode === 'friends' ? '' : `&lat=${HERE.lat}&lon=${HERE.lon}`;
  const r = await fetch(`${url}/api/v1/moments/feed?mode=${mode}${qs}`, { headers: { Authorization: `Bearer ${token}` } });
  const b = (await r.json()) as { results?: Array<{ id: string; visibility: string }> };
  return b.results ?? [];
}

let author: { id: string; token: string };
let stranger: { id: string; token: string };
const made: Record<string, string> = {};

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'moments-audience-0123456789abcdef01';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }],
  });
  await app.listen(0);
  url = await app.getUrl();
  await prisma.runtimeFlag.upsert({
    where: { key: 'moments' }, update: { enabled: true }, create: { key: 'moments', enabled: true },
  });
  author = await account('au');
  stranger = await account('st');

  /* A3 — ONE POST PER AUDIENCE VALUE, created through the real HTTP route, and
   * the STORED value read back from the database rather than echoed. */
  for (const v of ['nearby', 'friends', 'public', 'private']) {
    const res = await post(author.token, v, `${RUN} ${v}`);
    const body = (await res.json()) as { id?: string };
    if (body.id) made[v] = body.id;
  }
}, 60_000);

afterAll(async () => {
  await prisma.moment.deleteMany({ where: { text: { startsWith: RUN } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await prisma.runtimeFlag.deleteMany({ where: { key: 'moments' } }).catch(() => {});
  await app.close();
  await prisma.$disconnect();
});

describe('A3 — the composer selection reaches the create call and is stored', () => {
  for (const v of ['nearby', 'friends', 'public', 'private']) {
    it(`'${v}' is accepted and PERSISTED as '${v}'`, async () => {
      expect(made[v]).toBeTruthy();
      const row = await prisma.moment.findUniqueOrThrow({ where: { id: made[v] } });
      // Read from the DATABASE, not from the create response: an echo would
      // pass even if the column were written with a default.
      expect(row.visibility).toBe(v);
    });
  }
});

describe('A1 — the author always sees their own posts, in every mode', () => {
  it('THE BUG: their own friends post appears in the friends feed, with no self-follow', async () => {
    const ids = (await feed(author.token, 'friends')).map((m) => m.id);
    expect(ids).toContain(made.friends);
    const follows = await prisma.momentFollow.count({ where: { followerId: author.id, targetId: author.id } });
    expect(follows).toBe(0);          // fixed in the query, NOT by inventing a self-follow row
  });

  it("…and a 'private' post is visible to its author — 'only you' means you", async () => {
    const ids = (await feed(author.token, 'friends')).map((m) => m.id);
    expect(ids).toContain(made.private);
  });

  it('their own nearby post appears in the nearby feed', async () => {
    const ids = (await feed(author.token, 'nearby')).map((m) => m.id);
    expect(ids).toContain(made.nearby);
  });

  it('their own FRIENDS post appears in NEARBY too — own posts are not audience-filtered from the author', async () => {
    const ids = (await feed(author.token, 'nearby')).map((m) => m.id);
    expect(ids).toContain(made.friends);
  });
});

describe('the widening is exactly one person wide', () => {
  it("a stranger NEVER sees the author's private post", async () => {
    for (const mode of ['nearby', 'friends', 'city']) {
      const ids = (await feed(stranger.token, mode)).map((m) => m.id);
      expect(ids).not.toContain(made.private);
    }
  });

  it("a stranger who follows nobody does not see the author's friends post", async () => {
    const ids = (await feed(stranger.token, 'friends')).map((m) => m.id);
    expect(ids).not.toContain(made.friends);
  });

  it('a stranger DOES see the nearby post — the fix did not narrow anything', async () => {
    const ids = (await feed(stranger.token, 'nearby')).map((m) => m.id);
    expect(ids).toContain(made.nearby);
  });

  it('MODERATION IS NOT WIDENED: the author does not see their own removed post', async () => {
    await prisma.moment.update({ where: { id: made.nearby }, data: { moderationState: 'removed' } });
    const ids = (await feed(author.token, 'nearby')).map((m) => m.id);
    expect(ids).not.toContain(made.nearby);
    await prisma.moment.update({ where: { id: made.nearby }, data: { moderationState: 'visible' } });
  });

  it('a deleted post stays gone for its author too', async () => {
    await prisma.moment.update({ where: { id: made.public }, data: { deletedAt: new Date() } });
    const ids = (await feed(author.token, 'nearby')).map((m) => m.id);
    expect(ids).not.toContain(made.public);
    await prisma.moment.update({ where: { id: made.public }, data: { deletedAt: null } });
  });
});
