/**
 * A1 — STORIES FAIL ON ANDROID; POSTS SUCCEED. Reproduction and fix.
 *
 * The reproduction that finally explained the asymmetry: Android WebViews and
 * camera intents routinely hand the page a File whose `type` is EMPTY. The
 * uploader forwards that as `application/octet-stream`, the media service
 * refused it (`bad-mime`), and `uploaded` stayed null on the client. From
 * there the two composers diverge:
 *
 *   POST:  a null upload quietly degrades to kind=text -- the caption posts,
 *          so the flow LOOKS green.
 *   STORY: hard-requires media ("A story needs a photo or video") -- red.
 *
 * Same file, same device, one path green and one red: exactly the reported
 * symptom. Captured against the real HTTP stack in this suite:
 *
 *   BEFORE the fix:   POST /api/v1/moments/media (octet-stream) ->
 *                     400 {"error":"media_refused","reason":"bad-mime"}
 *                     so POST /api/v1/moments/stories is never reachable.
 *   AFTER the fix:    201 {mediaId,...} -> stories 201.
 *
 * The fix sniffs MAGIC BYTES only when the declared type says nothing, and
 * only into the already-accepted format set. A payload that is genuinely
 * unrecognisable still refuses -- proven below, so the sniff cannot widen the
 * format set.
 *
 * Also fixed and pinned here: a story with an unknown/absent mediaId used to
 * reach Prisma as an FK violation and surface as HTTP 500. Caller input gets
 * a typed 404 like every other foreign id.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { raw } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { sniffMime } from '../src/moment-media/normalize';

const prisma = new PrismaClient();
const RUN = `st${Date.now().toString(36)}`.replace(/[^a-f0-9]/g, 'e');
const PNG = readFileSync(join(__dirname, 'fixtures', 'media', 'px.png'));

let app: INestApplication;
let url: string;
let token = '';

/* The gate passes on RuntimeFlag OR allowlist. These suites use the ALLOWLIST,
 * scoped to their own throwaway accounts, because the R7 kill-switch fence
 * (flags-kill-switch.spec.ts) asserts NO domain RuntimeFlag row exists on a
 * migrated database -- and jest runs suites in parallel against one database,
 * so a suite that seeds the flag races that fence. Per-account rows race
 * nothing and clean up with the accounts. */
async function allowMoments(userId: string) {
  await prisma.domainAllowlist.upsert({
    where: { domain_userId: { domain: 'moments', userId } },
    create: { domain: 'moments', userId, note: 'stories-android spec' },
    update: {},
  });
}

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'stories-android-0123456789abcdef01';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  // Mirror bootstrap: the raw-body mount the media route depends on. A Nest
  // testing app installs no middleware, and without this every upload 400s
  // for a reason production never produces.
  type Mw = (req: { path: string }, res: unknown, next: () => void) => void;
  const only = (mw: unknown): Mw => (req, res, next) => (req.path === '/' ? (mw as Mw)(req, res, next) : next());
  app.getHttpAdapter().getInstance().use('/api/v1/moments/media', only(raw({ type: '*/*', limit: '50mb' })));
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }],
  });
  await app.listen(0);
  url = await app.getUrl();

  const id = `${RUN}00000000000000`.slice(0, 16);
  const r = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username: `st${id.slice(0, 10)}`, secret: `sec-${id}-12345678`, birthYearMonth: '1996-01' }),
  });
  const body = (await r.json()) as { accessToken?: string; userId?: string };
  token = body.accessToken ?? '';
  expect(token).not.toBe('');
  await allowMoments(body.userId ?? `${RUN}00000000000000`.slice(0, 16));
}, 120_000);

afterAll(async () => {
  await prisma.domainAllowlist.deleteMany({ where: { domain: 'moments', note: 'stories-android spec' } }).catch(() => {});
  await app?.close();
  await prisma.$disconnect();
});

const auth = { get Authorization() { return `Bearer ${token}`; } };

/** Upload exactly as the client does: raw bytes, content-type header. */
async function upload(bytes: Buffer, contentType: string) {
  const r = await fetch(`${url}/api/v1/moments/media`, {
    method: 'POST',
    headers: { Authorization: auth.Authorization, 'Content-Type': contentType },
    body: new Uint8Array(bytes),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

async function story(mediaId: unknown) {
  const r = await fetch(`${url}/api/v1/moments/stories`, {
    method: 'POST',
    headers: { Authorization: auth.Authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mediaId, visibility: 'friends' }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
}

describe('A1 — the Android reproduction: an empty file.type becomes octet-stream', () => {
  it('an octet-stream upload of a real image is ACCEPTED via magic bytes, and the story posts', async () => {
    // This is the exact request an Android camera capture produces: valid
    // image bytes, useless declared type.
    const up = await upload(PNG, 'application/octet-stream');
    expect(up.status).toBe(201);
    expect(up.body.mediaId).toBeTruthy();

    const st = await story(up.body.mediaId);
    expect(st.status).toBe(201);
    expect(st.body.state).toBe('active');
    expect(st.body.visibility).toBe('friends');
  });

  it('a declared, accepted type still wins — sniffing is fallback, not override', async () => {
    const up = await upload(PNG, 'image/png');
    expect(up.status).toBe(201);
  });

  it('the sniff does NOT widen the format set: garbage octet-stream still refuses', async () => {
    const garbage = Buffer.from('not media at all, just text pretending'.repeat(4));
    const up = await upload(garbage, 'application/octet-stream');
    expect(up.status).toBe(400);
    expect(up.body).toMatchObject({ error: 'media_refused' });
  });

  it('sniffMime recognises exactly the accepted magic families', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(16)]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]))).toBe('video/webm');
    const ftyp = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`, 'latin1'), Buffer.alloc(8)]);
    expect(sniffMime(ftyp('isom'))).toBe('video/mp4');
    expect(sniffMime(ftyp('3gp4'))).toBe('video/mp4'); // older Android camera
    expect(sniffMime(ftyp('qt  '))).toBe('video/quicktime');
    expect(sniffMime(ftyp('heic'))).toBe('image/heic');
    expect(sniffMime(Buffer.from('plain text here, definitely'))).toBe(null);
  });
});

describe('A1 — stories are covered separately from posts', () => {
  let mediaId: string;
  beforeAll(async () => {
    const up = await upload(PNG, 'image/png');
    mediaId = up.body.mediaId as string;
  });

  it('a story with valid media posts, independent of any moment', async () => {
    const st = await story(mediaId);
    expect(st.status).toBe(201);
    expect(st.body.mediaId).toBe(mediaId);
  });

  it('an unknown mediaId is a typed 404, never a 500', async () => {
    const st = await story('mm-00000000-0000-0000-0000-000000000000');
    expect(st.status).toBe(404);
  });

  it('an ABSENT mediaId is refused, never a 500', async () => {
    const st = await story(undefined);
    expect([400, 404]).toContain(st.status);
    expect(st.status).not.toBe(500);
  });

  it('the divergence itself: with NO media, a text post succeeds where a story cannot', async () => {
    // This is what made the bug read as "stories are broken, posts are fine".
    const post = await fetch(`${url}/api/v1/moments`, {
      method: 'POST',
      headers: { Authorization: auth.Authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'text', text: 'caption only', mediaIds: [], visibility: 'friends' }),
    });
    expect(post.status).toBe(201);
  });
});
