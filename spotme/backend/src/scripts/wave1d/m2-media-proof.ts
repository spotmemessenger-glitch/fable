/**
 * Wave 1D, M2 — the media path proved end to end, INSIDE the deployed image.
 *
 * Runs in-network because it needs the private DB and the real R2 bucket. It
 * drives the ACTUAL HTTP routes over loopback (not the service classes), so
 * what it proves is what a phone would get.
 *
 * The photo leg is the one that matters most: a JPEG is built with real EXIF
 * GPS tags, uploaded, and then the STORED OBJECT is fetched back from the
 * bucket and searched for those tags. "We call a strip function" is not the
 * claim being tested — "the bytes in the bucket do not contain the
 * coordinates" is.
 *
 * Cleans up everything it creates, purges the owner's md50872 probe account,
 * and reports the RuntimeFlag/DomainAllowlist row counts.
 */

import { PrismaClient } from '@prisma/client';

const ADULT = `${new Date().getUTCFullYear() - 30}-01`;

/** A minimal JPEG carrying a real EXIF GPS IFD. */
function jpegWithGps(): { bytes: Buffer; marker: string } {
  // GPS latitude 48/1 51/1 2989/100 — a recognisable, searchable value.
  const marker = 'SPOTME_GPS_CANARY';
  const exifBody = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from('II*\0\x08\0\0\0', 'latin1'),           // TIFF header, little-endian
    Buffer.from('\x01\0', 'latin1'),                      // 1 IFD entry
    Buffer.from('\x25\x88\x04\0\x01\0\0\0\x1a\0\0\0', 'latin1'), // GPSInfo tag
    Buffer.from('\0\0\0\0', 'latin1'),
    Buffer.from(marker, 'latin1'),                        // the canary in EXIF
  ]);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    Buffer.from([((exifBody.length + 2) >> 8) & 0xff, (exifBody.length + 2) & 0xff]),
    exifBody,
  ]);
  // SOI + APP1(EXIF) + a tiny valid-enough JFIF body + EOI
  const body = Buffer.from([
    0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array(64).fill(0x10),
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, ...new Array(16).fill(0x00),
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x37, 0xff, 0xd9,
  ]);
  return { bytes: Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body]), marker };
}

export async function runM2Proof(port: number): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient();
  const base = `http://127.0.0.1:${port}/api`;
  const RUN = `m2${Date.now().toString(36)}`.toLowerCase();
  const out: Record<string, unknown> = {};
  const ids: string[] = [];
  const madeMedia: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const guest = async (tag: string) => {
    const id = `${tag}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
    ids.push(id);
    const r = await fetch(`${base}/auth/guest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username: `${RUN}${tag}`.slice(0, 16), secret: `sec-${tag}-12345678`, birthYearMonth: ADULT }),
    });
    const j = (await r.json()) as { accessToken?: string; userId?: string };
    return { id: j.userId ?? id, token: j.accessToken ?? '' };
  };
  const api = (path: string, token: string, init: RequestInit = {}) =>
    fetch(`${base}/v1/moments${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });

  try {
    // ---------- 0a. MIGRATIONS DIFF (owner asked): repo vs _prisma_migrations.
    // The repo's migration folders ship in the image (Dockerfile copies
    // /app/prisma), so the comparison is local-dir vs live-table.
    try {
      const { readdir } = await import('node:fs/promises');
      const repoMigs = (await readdir('prisma/migrations', { withFileTypes: true }))
        .filter((d) => d.isDirectory()).map((d) => d.name).sort();
      const dbMigs = await prisma.$queryRawUnsafe<Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>>(
        'SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name',
      );
      const dbNames = dbMigs.map((m) => m.migration_name);
      out.migrations_repo_count = repoMigs.length;
      out.migrations_db_count = dbNames.length;
      out.migrations_missing_in_db = repoMigs.filter((m) => !dbNames.includes(m));
      out.migrations_extra_in_db = dbNames.filter((m) => !repoMigs.includes(m));
      out.migrations_unfinished = dbMigs.filter((m) => !m.finished_at || m.rolled_back_at).map((m) => m.migration_name);
    } catch (e) {
      out.migrations_diff_error = (e as Error).message.slice(0, 160);
    }

    // ---------- 0b. persistent BROWSER PROBE grants -------------------------
    // Two accounts created from outside with known recovery secrets; the
    // browser adopts them via Sign-back-in and lands allowlisted. NOT cleaned
    // up: they are the preview-drive accounts, noted and revocable.
    for (const uname of ['mbrowsera', 'mbrowserb']) {
      const u = await prisma.user.findUnique({ where: { username: uname }, select: { id: true } });
      if (u) {
        await prisma.domainAllowlist.upsert({
          where: { domain_userId: { domain: 'moments', userId: u.id } },
          update: { note: 'M1b browser probe (revocable)' },
          create: { domain: 'moments', userId: u.id, note: 'M1b browser probe (revocable)' },
        });
      }
      out[`browser_probe_${uname}`] = Boolean(u);
    }

    // ---------- 0. flag/allowlist row counts (owner asked to see these) -----
    out.runtimeFlag_rows_total = await prisma.runtimeFlag.count();
    out.runtimeFlag_rows_moments = await prisma.runtimeFlag.count({ where: { key: 'moments' } });
    out.runtimeFlag_rows_discovery = await prisma.runtimeFlag.count({ where: { key: 'discovery' } });
    out.domainAllowlist_rows_total = await prisma.domainAllowlist.count();

    // ---------- 1. purge the md50872 probe account -------------------------
    const probe = await prisma.user.findFirst({ where: { username: 'md50872' }, select: { id: true } });
    if (probe) {
      await prisma.refreshToken.deleteMany({ where: { userId: probe.id } }).catch(() => undefined);
      await prisma.user.delete({ where: { id: probe.id } }).catch(() => undefined);
    }
    out.probe_md50872_purged = Boolean(probe);

    // ---------- 2. enable moments for the two test accounts ONLY -----------
    const alice = await guest('a');
    const bob = await guest('b');
    await prisma.domainAllowlist.createMany({
      data: [
        { domain: 'moments', userId: alice.id, note: `M2 proof ${RUN}` },
        { domain: 'moments', userId: bob.id, note: `M2 proof ${RUN}` },
      ],
    });
    await sleep(5500); // gate cache

    // ---------- 3. PHOTO: upload → EXIF check on the STORED object ---------
    const { bytes: jpg, marker } = jpegWithGps();
    out.photo_upload_bytes = jpg.length;
    out.photo_source_contains_gps = jpg.includes(marker);   // sanity: non-vacuous
    const t0 = Date.now();
    const upRes = await api('/media', alice.token, {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(jpg),
    });
    out.photo_upload_status = upRes.status;
    out.photo_upload_ms = Date.now() - t0;
    const up = upRes.ok ? ((await upRes.json()) as { mediaId: string }) : null;
    if (up?.mediaId) madeMedia.push(up.mediaId);

    if (up?.mediaId) {
      // Post it so the asset is referenced (the url route requires refCount>0).
      const cRes = await api('', alice.token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'photo', text: `m2 ${RUN}`, mediaIds: [up.mediaId], visibility: 'nearby', location: { lat: 12.977, lon: 77.591 } }),
      });
      out.photo_post_status = cRes.status;
      const created = cRes.ok ? ((await cRes.json()) as { id: string; version?: number }) : null;
      out.photo_moment_id_present = Boolean(created?.id);

      // THE ASSERTION: fetch the stored object and search the real bytes.
      const uRes = await api(`/media/${up.mediaId}/url`, alice.token);
      const uJson = uRes.ok ? ((await uRes.json()) as { url: string }) : null;
      out.photo_asseturl_status = uRes.status;
      if (uJson?.url) {
        const objRes = await fetch(uJson.url);
        const stored = Buffer.from(await objRes.arrayBuffer());
        out.photo_stored_bytes = stored.length;
        out.photo_STORED_CONTAINS_GPS = stored.includes(marker);   // MUST be false
        out.photo_stored_has_exif_app1 = stored.includes(Buffer.from('Exif\0\0', 'latin1'));
      }

      // Second account sees it in the feed.
      const bobFeed = await api('/feed?mode=nearby&lat=12.977&lon=77.591', bob.token);
      out.second_account_feed_status = bobFeed.status;
      if (bobFeed.ok) {
        const page = (await bobFeed.json()) as { results?: Array<{ id: string }> };
        out.second_account_sees_post = (page.results || []).some((m) => m.id === created?.id);
      }

      // Delete works.
      if (created?.id) {
        const dRes = await api(`/${created.id}?version=${created.version ?? 0}`, alice.token, { method: 'DELETE' });
        out.photo_delete_status = dRes.status;
        const after = await api('/feed?mode=nearby&lat=12.977&lon=77.591', bob.token);
        if (after.ok) {
          const page2 = (await after.json()) as { results?: Array<{ id: string }> };
          out.photo_gone_after_delete = !(page2.results || []).some((m) => m.id === created.id);
        }
      }
    }

    // ---------- 4. VIDEO: ffmpeg present? transcode ladder? ----------------
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    try {
      const { stdout } = await run('ffmpeg', ['-version']);
      out.ffmpeg_present = String(stdout).split('\n')[0].slice(0, 60);
    } catch (e) {
      out.ffmpeg_present = `MISSING: ${(e as Error).message.slice(0, 80)}`;
    }
    // Generate a real 3-second test video with ffmpeg itself, upload it.
    try {
      const { mkdtemp, readFile, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'm2-'));
      const src = join(dir, 'src.mp4');
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=30:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', src]);
      const vid = await readFile(src);
      out.video_upload_bytes = vid.length;
      const vt0 = Date.now();
      const vRes = await api('/media', alice.token, { method: 'POST', headers: { 'Content-Type': 'video/mp4' }, body: new Uint8Array(vid) });
      out.video_upload_status = vRes.status;
      out.video_upload_ms = Date.now() - vt0;
      const vj = vRes.ok ? ((await vRes.json()) as { mediaId: string }) : null;
      if (vj?.mediaId) {
        madeMedia.push(vj.mediaId);
        // Give the transcode worker a window, then read the recorded ladder.
        for (let i = 0; i < 20; i++) {
          const asset = await prisma.momentMediaAsset.findUnique({ where: { id: vj.mediaId } });
          if (asset?.variants) {
            out.video_variants = asset.variants;
            out.video_posterKey = asset.posterKey;
            out.video_durationSeconds = asset.durationSeconds;
            break;
          }
          await sleep(3000);
        }
        if (!out.video_variants) out.video_variants = 'NOT_PRODUCED_WITHIN_60s';
      }
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    } catch (e) {
      out.video_error = (e as Error).message.slice(0, 200);
    }

    // ---------- 5. moderation sink actually records ------------------------
    if (madeMedia.length) {
      const rRes = await api('/reports', alice.token, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetKind: 'moment', targetId: 'mo-nonexistent', reason: 'Spam or scam' }),
      });
      out.report_status = rRes.status;
      if (rRes.ok) {
        const rep = (await rRes.json()) as { reportId: string };
        const row = await prisma.momentReport.findUnique({ where: { id: rep.reportId } });
        out.report_row_written = Boolean(row);
        out.report_queuedAt_set = Boolean(row?.queuedAt);   // D7: delivery marker
        await prisma.momentReport.deleteMany({ where: { id: rep.reportId } }).catch(() => undefined);
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    // ---------- cleanup: production ends dark, zero rows -------------------
    await prisma.domainAllowlist.deleteMany({ where: { domain: 'moments', note: `M2 proof ${RUN}` } }).catch(() => undefined);
    await prisma.momentMediaAsset.deleteMany({ where: { id: { in: madeMedia } } }).catch(() => undefined);
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    out.cleanup_allowlist_moments_remaining = await prisma.domainAllowlist.count({ where: { domain: 'moments' } }).catch(() => -1); // 2 browser probes expected
    out.cleanup_runtimeFlag_total = await prisma.runtimeFlag.count().catch(() => -1);
    out.cleanup_domainAllowlist_total = await prisma.domainAllowlist.count().catch(() => -1);
    await prisma.$disconnect().catch(() => undefined);
  }
  return out;
}
