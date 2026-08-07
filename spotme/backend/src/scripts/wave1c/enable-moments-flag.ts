/**
 * Wave 1C — OPEN `moments` TO EVERY VERIFIED ADULT (owner directive).
 *
 * One RuntimeFlag row is the whole change. The DomainAllowlist is NOT touched:
 * this script never reads or writes it beyond counting, so the three
 * pre-existing rows survive untouched and keep working (the gate grants
 * existence on flag OR allowlist, so they become redundant, not broken).
 *
 * REVOCATION: delete the single row —
 *   DELETE FROM "RuntimeFlag" WHERE key = 'moments';
 * Moments is dark again for everyone not on the allowlist within one 5s
 * flag-cache window. No deploy, no restart, no code change.
 *
 * The flag opens EXISTENCE only. `requireAdult` still runs after it, so a
 * non-adult or frozen account gets 403 exactly as before — this widens who can
 * see the surface, never who may bypass the age gate.
 *
 * Runs inside the deployed image: it needs the private database and a loopback
 * HTTP call to prove the gate actually answers.
 */

import { PrismaClient } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import { createHash } from 'node:crypto';

const DOMAIN = 'moments';

export async function runEnableMomentsFlag(port: number): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient();
  const base = `http://127.0.0.1:${port}/api`;
  const secret = process.env.JWT_ACCESS_SECRET as string;
  const out: Record<string, unknown> = {};
  const probeIds: string[] = [];
  const mint = (sub: string) => sign({ sub, role: 'USER' }, secret, { expiresIn: '10m' });
  const get = (token: string, path: string) =>
    fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.status);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  try {
    // ---- 0. PRE-OP state. Allowlist is COUNTED, never modified. ----
    out.pre_runtimeflag_rows = await prisma.runtimeFlag.count({ where: { key: DOMAIN } });
    out.pre_allowlist_count = await prisma.domainAllowlist.count({ where: { domain: DOMAIN } });

    // ---- 1. A brand-new account with NO allowlist row: 404 before. ----
    const newId = createHash('sha256').update(`flagprobe${port}`).digest('hex').slice(0, 24);
    probeIds.push(newId);
    await prisma.user.upsert({
      where: { id: newId },
      update: { ageVerified: true, accountStatus: 'active' },
      create: {
        id: newId,
        username: `zzflagprobe${String(port).slice(-2)}`.slice(0, 16),
        claimSecretHash: createHash('sha256').update('probe').digest('hex'),
        ageVerified: true,
        accountStatus: 'active',
        birthYearMonth: `${new Date().getUTCFullYear() - 30}-01`,
      },
    });
    const newTok = mint(newId);
    out.before_newaccount_feed = await get(newTok, '/v1/moments/feed?mode=friends'); // expect 404

    // ---- 2. THE CHANGE: one row. ----
    await prisma.runtimeFlag.upsert({
      where: { key: DOMAIN },
      update: { enabled: true },
      create: { key: DOMAIN, enabled: true },
    });
    await sleep(6000); // flag cache is 5s

    // ---- 3. VERIFY the surface opened for an account with no allowlist row. ----
    out.after_newaccount_feed = await get(newTok, '/v1/moments/feed?mode=friends'); // expect 200
    out.after_newaccount_stories_rail = await get(newTok, '/v1/moments/stories/rail'); // expect 200

    // ---- 4. @yuv2 (has no allowlist row either — the flag is what opens it). ----
    const yuv = await prisma.user.findFirst({
      where: { username: 'yuv2', deletedAt: null },
      select: { id: true, ageVerified: true, accountStatus: true },
    });
    out.yuv2_found = !!yuv;
    out.yuv2_eligible = yuv ? yuv.ageVerified === true && yuv.accountStatus === 'active' : null;
    if (yuv) {
      const t = mint(yuv.id);
      out.yuv2_feed = await get(t, '/v1/moments/feed?mode=friends'); // expect 200
      out.yuv2_stories_rail = await get(t, '/v1/moments/stories/rail'); // expect 200
    }

    // ---- 5. ONLY moments opened. Every other gated domain must still 404. ----
    out.other_domains_still_dark = {
      exchange: await get(newTok, '/v1/exchange/feed'),
      discovery: await get(newTok, '/v2/discovery/visibility'),
      events: await get(newTok, '/v1/events/feed'),
    }; // expect 404 each

    // ---- 6. Allowlist untouched; flag rows for other domains untouched. ----
    out.post_allowlist_count = await prisma.domainAllowlist.count({ where: { domain: DOMAIN } });
    out.allowlist_unchanged = out.post_allowlist_count === out.pre_allowlist_count;
    out.runtimeflag_rows_all_domains = (
      await prisma.runtimeFlag.findMany({ select: { key: true, enabled: true } })
    ).map((r) => `${r.key}=${r.enabled}`);
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    // The probe account is removed; the flag row is the only thing left behind.
    await prisma.user.deleteMany({ where: { id: { in: probeIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  return out;
}
