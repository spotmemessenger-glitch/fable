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
/* THREE DECIMALS, NOT FOUR. The server refuses a finer fix outright rather
 * than rounding it — the refusal is the privacy feature (~110 m grid), and the
 * web client rounds before sending. My first run sent 12.9766/77.5913 and every
 * create came back 400, which then cascaded into eleven confusing failures
 * downstream. Matching the client's own round3(). */
const HERE = { lat: 12.977, lon: 77.591 };
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

/* TWO SEPARATE REFUSALS, and my first run tripped both — which is why all four
 * creates failed rather than the two I would have predicted:
 *
 *   1. `COORD_PRECISE = /\d{1,3}\.\d{4,}/` — a 4-decimal coordinate IS a
 *      precise fix and is refused outright rather than rounded. The refusal is
 *      the privacy feature. Hence 3 decimals, matching the client's round3().
 *   2. `if (visibility === 'private' || visibility === 'friends') throw
 *      locationTierRefused()` — a location may only ride on nearby/public.
 *      Attaching one to a friends post is refused, not silently dropped.
 *
 * So the friends and private posts carry NO location at all. That makes the
 * nearby-mode assertion below sharper, not weaker: the author's own friends
 * post has no geography whatsoever, so its appearance in the nearby feed can
 * only come from `isAuthor` short-circuiting the geo predicate — which is
 * exactly what A1 claims. */
const post = (token: string, visibility: string, text: string) => {
  const canCarryLocation = visibility === 'nearby' || visibility === 'public';
  return fetch(`${url}/api/v1/moments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'text', text, mediaIds: [], visibility,
      ...(canCarryLocation ? { location: HERE } : {}),
    }),
  });
};

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
    /* FAIL LOUDLY, HERE. Swallowing a failed create left `made[v]` undefined and
     * turned ONE cause into eleven downstream assertion failures, none of which
     * named it. A setup that cannot set up must say so in its own words. */
    if (!res.ok || !body.id) {
      throw new Error(`setup: creating a '${v}' moment failed with HTTP ${res.status}: ${JSON.stringify(body)}`);
    }
    made[v] = body.id;
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

describe("the `global` feed — what makes `public` an honest option", () => {
  /* `public` was removed from the composer because it reached exactly the same
   * people `nearby` did. `global` is the surface that makes the two different,
   * so these assert the difference is REAL and not just labelled. */
  const globalFeed = (token: string) => feed(token, 'global');

  it('a stranger anywhere sees the public post — no follow, no proximity', async () => {
    const ids = (await globalFeed(stranger.token)).map((m) => m.id);
    expect(ids).toContain(made.public);
  });

  it('NO LOCATION IS REQUIRED to read it — global is not a question about a place', async () => {
    // Deliberately no lat/lon: every other mode returns [] without an origin.
    const r = await fetch(`${url}/api/v1/moments/feed?mode=global`, {
      headers: { Authorization: `Bearer ${stranger.token}` },
    });
    const b = (await r.json()) as { results?: Array<{ id: string }> };
    expect((b.results ?? []).map((m) => m.id)).toContain(made.public);
  });

  it("THE LEAK THAT MUST NOT HAPPEN: a NEARBY post never reaches the global feed", async () => {
    // The author chose an audience bounded by proximity. Honouring that is the
    // whole point of having audiences — opening a different tab must not widen
    // somebody else's post.
    const ids = (await globalFeed(stranger.token)).map((m) => m.id);
    expect(ids).not.toContain(made.nearby);
  });

  it('…and neither does a friends post or a private one', async () => {
    const ids = (await globalFeed(stranger.token)).map((m) => m.id);
    expect(ids).not.toContain(made.friends);
    expect(ids).not.toContain(made.private);
  });

  it('the author still sees their own posts in global, as in every mode', async () => {
    const ids = (await globalFeed(author.token)).map((m) => m.id);
    expect(ids).toContain(made.public);
    expect(ids).toContain(made.private);
  });
});

describe('changing a post\'s audience after the fact', () => {
  const setVis = (token: string, id: string, visibility: string, expectedVersion: number) =>
    fetch(`${url}/api/v1/moments/${id}/visibility`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility, expectedVersion }),
    });

  it('the author can narrow a nearby post to private', async () => {
    const res = await post(author.token, 'nearby', `${RUN} movable`);
    const { id, version } = (await res.json()) as { id: string; version: number };
    const r = await setVis(author.token, id, 'private', version);
    expect(r.status).toBeLessThan(300);
    const row = await prisma.moment.findUniqueOrThrow({ where: { id } });
    expect(row.visibility).toBe('private');
  });

  it('THE PRIVACY POINT: narrowing CLEARS the stored location, in the same statement', async () => {
    const res = await post(author.token, 'nearby', `${RUN} loc-drop`);
    const { id, version } = (await res.json()) as { id: string; version: number };
    const before = await prisma.moment.findUniqueOrThrow({ where: { id } });
    expect(before.coarseCell).toBeTruthy();          // it had one to lose

    await setVis(author.token, id, 'friends', version);
    const after = await prisma.moment.findUniqueOrThrow({ where: { id } });
    // A location collected under one audience must not survive on a post the
    // author has just narrowed — that is what the create-side refusal exists
    // to prevent, and an edit must not be the way around it.
    expect(after.coarseCell).toBeNull();
    expect(after.coarseLat).toBeNull();
    expect(after.coarseLon).toBeNull();
    expect(after.cityCell).toBeNull();
  });

  it('A STRANGER MAY NOT CHANGE SOMEBODY ELSE\'S AUDIENCE', async () => {
    const res = await post(author.token, 'nearby', `${RUN} notyours`);
    const { id, version } = (await res.json()) as { id: string; version: number };
    const r = await setVis(stranger.token, id, 'public', version);
    expect(r.status).toBe(404);                      // 404, not 403: no existence leak
    const row = await prisma.moment.findUniqueOrThrow({ where: { id } });
    expect(row.visibility).toBe('nearby');           // and nothing was written
  });

  it('a STALE version is refused rather than applied', async () => {
    const res = await post(author.token, 'nearby', `${RUN} stale`);
    const { id, version } = (await res.json()) as { id: string; version: number };
    await setVis(author.token, id, 'friends', version);          // bumps the version
    const second = await setVis(author.token, id, 'public', version);  // same one again
    expect(second.status).toBeGreaterThanOrEqual(400);
    const row = await prisma.moment.findUniqueOrThrow({ where: { id } });
    expect(row.visibility).toBe('friends');          // the stale write did not land
  });

  it('an unknown audience value is refused', async () => {
    const res = await post(author.token, 'nearby', `${RUN} badvis`);
    const { id, version } = (await res.json()) as { id: string; version: number };
    expect((await setVis(author.token, id, 'everyone', version)).status).toBeGreaterThanOrEqual(400);
  });

  it('the change is REAL: a narrowed post leaves the stranger\'s feed', async () => {
    const res = await post(author.token, 'nearby', `${RUN} vanish`);
    const { id, version } = (await res.json()) as { id: string; version: number };
    expect((await feed(stranger.token, 'nearby')).map((m) => m.id)).toContain(id);
    await setVis(author.token, id, 'private', version);
    expect((await feed(stranger.token, 'nearby')).map((m) => m.id)).not.toContain(id);
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
