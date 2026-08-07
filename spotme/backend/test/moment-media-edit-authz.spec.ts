/**
 * THE "moments is not available" ON POST, PINNED.
 *
 * Symptom: pick a video, drag the trim or move the cover, press Post — and the
 * composer says "moments is not available". The feed was loading, the stories
 * rail was full, the upload had succeeded. Nothing about the feature was off.
 *
 * Cause: `POST /v1/moments/media/:mediaId/edit` began
 *
 *     if (!asset || asset.refCount < 1) throw new NotFoundException();
 *
 * `refCount` counts the moments and stories REFERENCING an asset. The composer
 * records trim and cover BEFORE creating the moment — deliberately, so the
 * first transcode already carries them — so at the only instant this route is
 * ever called, refCount is 0 BY CONSTRUCTION. The guard was copied from the
 * read route below it, where it is correct (an asset nobody posted is an asset
 * nobody may fetch) and where it does not have this ordering problem.
 *
 * It surfaced as "moments is not available" because the client read any 404 on
 * this domain as the gate's 404 — one broken route reported the whole product
 * as switched off. Both halves are fixed; this spec owns the server half.
 *
 * The replacement rule is STRICTER, not looser. `u` was previously unused, so
 * any authenticated account could rewrite the trim and cover of any referenced
 * asset — including someone else's. Only the uploader may edit now, identified
 * by the storage key ingest wrote (`moments/<ownerId>/<mediaId>`), and a
 * non-owner gets 404 rather than 403 so an unknown id and a foreign id stay
 * indistinguishable.
 *
 * Assets are created directly through Prisma: the rule under test is the
 * controller's, and going through ingest would drag ffmpeg availability into a
 * test about authorisation.
 */

import { INestApplication, ValidationPipe, RequestMethod } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module';

const prisma = new PrismaClient();
const RUN = `me${Date.now().toString(36)}`;
const ADULT = `${new Date().getUTCFullYear() - 30}-01`;
let app: INestApplication;
let url: string;
let seq = 0;

/** A real adult account through the real guest route; returns its token. */
async function account(tag: string): Promise<{ id: string; token: string }> {
  const n = (seq++).toString(16);
  const id = `${n}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
  const username = `${RUN}${n}${tag}`.slice(0, 16);
  const r = await fetch(`${url}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, username, secret: `sec-${id}-12345678`, birthYearMonth: ADULT }),
  });
  const body = (await r.json()) as { accessToken?: string; userId?: string };
  return { id: body.userId ?? id, token: body.accessToken ?? '' };
}

/** An UNREFERENCED video asset owned by `ownerId` — the composer's exact state. */
async function unreferencedVideo(ownerId: string): Promise<string> {
  const mediaId = `mm-${randomUUID()}`;
  await prisma.momentMediaAsset.create({
    data: {
      id: mediaId,
      kind: 'video',
      mimeType: 'video/mp4',
      contentHash: `h-${RUN}-${mediaId}`,
      storageKey: `moments/${ownerId}/${mediaId}`,
      refCount: 0,                       // nothing references it yet — the whole point
      durationMs: 14_000,
    },
  });
  return mediaId;
}

const edit = (token: string, mediaId: string, body: unknown) =>
  fetch(`${url}/api/v1/moments/media/${mediaId}/edit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

let owner: { id: string; token: string };
let stranger: { id: string; token: string };

beforeAll(async () => {
  process.env.JWT_ACCESS_SECRET ||= 'moment-media-edit-authz-0123456789ab';
  const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = m.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }, { path: 'ready', method: RequestMethod.GET }],
  });
  /* MIRROR bootstrap()'s BODY PARSERS, or this suite tests a server that does
   * not exist. A Nest testing app installs none of them, which is how the
   * prefix-matching bug shipped: `app.use('/api/v1/moments/media', raw(...))`
   * matches every path UNDER the mount point too, so in production the edit
   * route received a Buffer where it expected JSON and silently discarded
   * every trim and cover it was sent. The suite was green throughout.
   *
   * Kept byte-identical in shape to main.ts. If that file's parsers change,
   * this must change with them. */
  {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { raw } = require('express') as { raw: (o?: unknown) => unknown };
    type Mw = (req: { path: string }, res: unknown, next: () => void) => void;
    const onlyAtMountPoint = (mw: unknown): Mw => (req, res, next) =>
      (req.path === '/' ? (mw as Mw)(req, res, next) : next());
    app.getHttpAdapter().getInstance().use(
      '/api/v1/moments/media',
      onlyAtMountPoint(raw({ type: '*/*', limit: '50mb' })),
    );
  }

  await app.listen(0);
  url = await app.getUrl();
  // The domain must be ON, or every assertion here would pass for the wrong
  // reason: the gate's 404 looks exactly like the bug's 404.
  await prisma.runtimeFlag.upsert({
    where: { key: 'moments' }, update: { enabled: true }, create: { key: 'moments', enabled: true },
  });
  owner = await account('ow');
  stranger = await account('st');
}, 40_000);

afterAll(async () => {
  await prisma.momentMediaAsset.deleteMany({ where: { contentHash: { startsWith: `h-${RUN}` } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { username: { startsWith: RUN } } }).catch(() => {});
  await prisma.runtimeFlag.deleteMany({ where: { key: 'moments' } }).catch(() => {});
  await app.close();
  await prisma.$disconnect();
});

describe('moment media edit — authorised by uploader, not by refCount', () => {
  it('THE BUG: the uploader may edit an asset no moment references yet', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    const res = await edit(owner.token, mediaId, { trimStartMs: 0, trimEndMs: 14_000, coverAtMs: 6200 });
    // Before the fix this was 404, and the composer rendered it as
    // "moments is not available".
    expect(res.status).toBeLessThan(300);
    const body = (await res.json()) as { coverAtMs: number; trimEndMs: number };
    expect(body.coverAtMs).toBe(6200);
    expect(body.trimEndMs).toBe(14_000);
  });

  it('…and the choices are persisted, not merely accepted', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    await edit(owner.token, mediaId, { trimStartMs: 1500, trimEndMs: 9000, coverAtMs: 2000 });
    const row = await prisma.momentMediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect([row.trimStartMs, row.trimEndMs, row.coverAtMs]).toEqual([1500, 9000, 2000]);
  });

  it('A STRANGER MAY NOT EDIT SOMEONE ELSE\'S ASSET — this was open before', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    const res = await edit(stranger.token, mediaId, { coverAtMs: 1 });
    expect(res.status).toBe(404);              // 404, not 403: no existence leak
    const row = await prisma.momentMediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect(row.coverAtMs).toBeNull();          // and nothing was written
  });

  it('a referenced asset is still editable by its uploader — refCount is not the rule either way', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    await prisma.momentMediaAsset.update({ where: { id: mediaId }, data: { refCount: 1 } });
    expect((await edit(owner.token, mediaId, { coverAtMs: 500 })).status).toBeLessThan(300);
  });

  it('an unknown id is 404, indistinguishable from a foreign one', async () => {
    expect((await edit(owner.token, `mm-${randomUUID()}`, { coverAtMs: 1 })).status).toBe(404);
  });

  it('a photo still refuses trim points, with a reason the composer can show', async () => {
    const mediaId = `mm-${randomUUID()}`;
    await prisma.momentMediaAsset.create({
      data: {
        id: mediaId, kind: 'image', mimeType: 'image/jpeg',
        contentHash: `h-${RUN}-${mediaId}`, storageKey: `moments/${owner.id}/${mediaId}`, refCount: 0,
      },
    });
    const res = await edit(owner.token, mediaId, { coverAtMs: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toMatch(/video/i);
  });

  it('validation still refuses nonsense rather than coercing it', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    expect((await edit(owner.token, mediaId, { coverAtMs: -1 })).status).toBe(400);
    expect((await edit(owner.token, mediaId, { trimStartMs: 5000, trimEndMs: 1000 })).status).toBe(400);
  });

  /* THE RAW-PARSER PREFIX BUG.
   *
   * `app.use('/api/v1/moments/media', raw(...))` matches every path under the
   * mount point, so this route was handed a Buffer where it expected JSON.
   * Every field read undefined, the handler wrote nulls, requeued a transcode
   * with no trim, and answered 201 — an edit that looked like it worked and
   * discarded everything it was sent. In production, trimming a clip has never
   * once taken effect.
   *
   * The two assertions are deliberately different in kind. A 400 proves the
   * VALIDATION saw the body; a persisted value proves the HANDLER did. A body
   * swallowed by the raw parser fails both, and fails them as a 201 — which is
   * why "the request succeeded" was never evidence of anything here. */
  it('THE BODY ACTUALLY ARRIVES: the raw upload parser must not swallow this route', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    expect((await edit(owner.token, mediaId, { coverAtMs: -1 })).status).toBe(400);

    const res = await edit(owner.token, mediaId, { trimStartMs: 250, trimEndMs: 7750, coverAtMs: 3100 });
    expect(res.status).toBeLessThan(300);
    const row = await prisma.momentMediaAsset.findUniqueOrThrow({ where: { id: mediaId } });
    expect([row.trimStartMs, row.trimEndMs, row.coverAtMs]).toEqual([250, 7750, 3100]);
  });

  it('…while the upload route still gets its RAW bytes, which is what the parser is for', async () => {
    // One byte-exact JPEG header: proof the mount point itself still parses raw.
    const res = await fetch(`${url}/api/v1/moments/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'image/jpeg' },
      body: Buffer.from([0xff, 0xd8, 0xff]),
    });
    // Refused for being an unusable image (400), NOT for arriving empty — an
    // "expected raw media bytes" 400 would mean the parser stopped running.
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toMatch(/expected raw media bytes/);
  });

  it('unauthenticated is 401, before any of this', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    const res = await fetch(`${url}/api/v1/moments/media/${mediaId}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
