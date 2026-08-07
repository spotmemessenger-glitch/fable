/**
 * B2 — A LIKE MUST REACH THE AUTHOR.
 *
 * Real HTTP against real Postgres with two accounts, because every claim here
 * is about what a SECOND viewer sees. A service-level test with one identity
 * cannot distinguish "the count is right" from "the count is my own reaction
 * echoed back", which is the defect this suite exists to rule out.
 *
 * The alert side is asserted at the PORT, not at a table, because no durable
 * alerts mechanism exists in this repository -- see the report. Moments
 * already calls `MomentRealtimePort.publish({kind:'reaction', ...})` on every
 * reaction, and the only shipped adapter is `DisabledMomentRealtime`, which
 * returns `{delivered:false}` and stores nothing. A recording adapter is
 * injected here so the CALL is provable without inventing a second mechanism.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import {
  MOMENT_REALTIME_PORT,
  MomentRealtimePort,
  MomentRealtimeNotification,
} from '../src/moments/moments.ports';

const prisma = new PrismaClient();
const RUN = `b2${Date.now().toString(36)}`;
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;
const HERE = { lat: 12.971, lon: 77.594 };

/** Records what the service tried to publish; delivers nothing. */
class RecordingRealtime implements MomentRealtimePort {
  readonly name = 'recording';
  readonly sent: MomentRealtimeNotification[] = [];
  async publish(n: MomentRealtimeNotification): Promise<{ delivered: boolean }> {
    this.sent.push(n);
    return { delivered: false };
  }
  reactionsFor(userId: string) {
    return this.sent.filter((n) => n.kind === 'reaction' && n.targetUserId === userId);
  }
}

const realtime = new RecordingRealtime();
let app: INestApplication;
let url: string;
let seq = 1;

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

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function post(token: string, visibility: string, text: string): Promise<string> {
  const canCarryLocation = visibility === 'nearby' || visibility === 'public';
  const r = await fetch(`${url}/api/v1/moments`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      kind: 'text', text, mediaIds: [], visibility,
      ...(canCarryLocation ? { location: HERE } : {}),
    }),
  });
  const b = (await r.json()) as { id?: string };
  return b.id ?? '';
}

const react = (token: string, id: string, reaction = 'like') =>
  fetch(`${url}/api/v1/moments/${id}/reactions`, {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction }),
  });

const unreact = (token: string, id: string) =>
  fetch(`${url}/api/v1/moments/${id}/reactions`, { method: 'DELETE', headers: auth(token) });

/** The count AS THAT VIEWER SEES IT, read out of the feed, not the write path. */
async function countInFeed(token: string, id: string): Promise<number | undefined> {
  const r = await fetch(`${url}/api/v1/moments/feed?mode=nearby&lat=${HERE.lat}&lon=${HERE.lon}`, {
    headers: auth(token),
  });
  const b = (await r.json()) as { results?: Array<{ id: string; reactionCount?: number }> };
  return b.results?.find((m) => m.id === id)?.reactionCount;
}

let A: { id: string; token: string };
let B: { id: string; token: string };

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'moments-reactions-0123456789abcd01';
  const m = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MOMENT_REALTIME_PORT)
    .useValue(realtime)
    .compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }],
  });
  await app.listen(0);
  url = await app.getUrl();
  A = await account('a');
  B = await account('b');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  realtime.sent.length = 0;
});

describe('B2 — a like reaches the author', () => {
  it("A likes B's post -> B's OWN feed shows count 1, and B gets the alert", async () => {
    const id = await post(B.token, 'nearby', 'b2 cross-account');
    const r = await react(A.token, id);
    expect(r.ok).toBe(true);

    // The count is read from B's feed, not A's: an author must see reactions
    // they did not make. This is the assertion a single-account test cannot do.
    expect(await countInFeed(B.token, id)).toBe(1);
    expect(await countInFeed(A.token, id)).toBe(1);

    const alerts = realtime.reactionsFor(B.id);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'reaction', targetUserId: B.id, actorId: A.id, refId: id });
  });

  it('A unlikes -> the count returns to 0 for both viewers', async () => {
    const id = await post(B.token, 'nearby', 'b2 unlike');
    await react(A.token, id);
    expect(await countInFeed(B.token, id)).toBe(1);

    await unreact(A.token, id);
    expect(await countInFeed(B.token, id)).toBe(0);
    expect(await countInFeed(A.token, id)).toBe(0);
  });

  it('A likes TWICE -> the count stays 1, not 2', async () => {
    const id = await post(B.token, 'nearby', 'b2 idempotent');
    await react(A.token, id);
    await react(A.token, id);
    expect(await countInFeed(B.token, id)).toBe(1);

    // Proven at the row level too: the primary key is (momentId,userId), so a
    // second like is an UPDATE, never a second row.
    const rows = await prisma.momentReactionRow.count({ where: { momentId: id } });
    expect(rows).toBe(1);
  });

  it('changing reaction type is still ONE reactor, not two', async () => {
    const id = await post(B.token, 'nearby', 'b2 switch');
    await react(A.token, id, 'like');
    await react(A.token, id, 'love');
    expect(await countInFeed(B.token, id)).toBe(1);
  });

  it('B likes their OWN post -> count 1, and NOBODY is alerted', async () => {
    const id = await post(B.token, 'nearby', 'b2 self');
    await react(B.token, id);

    // The count still moves -- the suppression is about notification, not
    // about pretending the reaction did not happen.
    expect(await countInFeed(B.token, id)).toBe(1);
    expect(realtime.reactionsFor(B.id)).toHaveLength(0);
    expect(realtime.sent.filter((n) => n.kind === 'reaction')).toHaveLength(0);
  });

  it('a like on a post the liker CANNOT see is refused, and changes no count', async () => {
    const id = await post(B.token, 'private', 'b2 unseeable');
    const r = await react(A.token, id);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404); // non-enumerable: "cannot see" reads as "not there"

    expect(await prisma.momentReactionRow.count({ where: { momentId: id } })).toBe(0);
    expect(realtime.reactionsFor(B.id)).toHaveLength(0);
  });

  it('an unknown reaction is refused by the CLOSED registry (M4 still holds)', async () => {
    const id = await post(B.token, 'nearby', 'b2 closed registry');
    const r = await react(A.token, id, 'angry');
    expect(r.ok).toBe(false);
    expect(await prisma.momentReactionRow.count({ where: { momentId: id } })).toBe(0);
  });

  it('the count is per-post, not global: two posts keep separate totals', async () => {
    const one = await post(B.token, 'nearby', 'b2 post one');
    const two = await post(B.token, 'nearby', 'b2 post two');
    await react(A.token, one);
    expect(await countInFeed(B.token, one)).toBe(1);
    expect(await countInFeed(B.token, two)).toBe(0);
  });
});
