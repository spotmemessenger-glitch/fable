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

  it('unauthenticated is 401, before any of this', async () => {
    const mediaId = await unreferencedVideo(owner.id);
    const res = await fetch(`${url}/api/v1/moments/media/${mediaId}/edit`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
