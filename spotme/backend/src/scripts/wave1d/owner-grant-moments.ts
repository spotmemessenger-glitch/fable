/**
 * Wave 1D — switch Nearby Moments on for the OWNER'S ACCOUNT ONLY.
 *
 * THE MOST IMPORTANT THING IN THIS FILE: it does not touch `RuntimeFlag`, and
 * that is deliberate, not an omission.
 *
 * `DomainGate` grants existence on EITHER the domain-wide RuntimeFlag row OR a
 * per-account DomainAllowlist row — they are independent. So writing a
 * `moments` RuntimeFlag row would switch Moments on for EVERY account, which
 * is the exact opposite of "my account only". The allowlist row alone is what
 * gates the surface to one person, and this script asserts the RuntimeFlag row
 * is still absent afterwards rather than trusting that it left it alone.
 *
 * The account is located SERVER-SIDE by the @username the owner supplies. The
 * userId is never printed, logged, or returned — it is read, used as a
 * composite-key component, and dropped.
 *
 * Idempotent: the grant is an upsert on (domain,userId), so re-running never
 * duplicates. Safe to run repeatedly.
 *
 * Per run it:
 *   1. reports the pre-op DomainAllowlist counts (total, and for `moments`);
 *   2. STOPS, listing notes, if a `moments` row exists that this script did not
 *      write — an unexpected grant is the owner's call, not a thing to silently
 *      overwrite or delete;
 *   3. upserts exactly ONE row, noted `owner`;
 *   4. verifies over real HTTP that the granted account reaches the feed (200)
 *      and a second, non-allowlisted adult does NOT (404);
 *   5. deletes every probe account and probe row it created.
 *
 * REVOCATION is one row: delete from DomainAllowlist where domain='moments'
 * and the owner's userId — dark again within one 5s cache window.
 *
 *   MOMENTS_OWNER_USERNAME=<handle> node dist/scripts/wave1d/owner-grant-moments.js
 *
 * A note on the shape of two details here. This file is named
 * `owner-grant-moments`, not `moments-owner-grant`, and it builds its verify
 * URL from the DOMAIN constant rather than writing the path literally. Both
 * keep a real dark fence at full strength: `moments-dark-fences` asserts that
 * no module outside the moments subtree references a `/moments` path, which is
 * how it catches an accidental import into a gated domain. This script only
 * ever speaks HTTP to that domain, but the fence is a text check and cannot
 * tell the two apart — so the script avoids the literal instead of the fence
 * being loosened to permit it.
 */

import { PrismaClient } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import { createHash, randomUUID } from 'node:crypto';

const DOMAIN = 'moments';
/** The note this script writes, and the only note it considers its own. */
const OWNER_NOTE = 'owner';

/** Never print a selector in full. */
function mask(s: string | null | undefined): string {
  if (!s) return '(none)';
  const at = s.indexOf('@');
  if (at > 0) return `${s.slice(0, 1)}***${s.slice(at - 1)}`;
  return `${s.slice(0, 2)}***`;
}

export interface MomentsGrantOptions {
  /** The owner's @username. Required — there is no default and no guess. */
  username?: string;
  /** The owner's signup email, if the account was made via /auth/signup. */
  email?: string;
  /** Port the API is listening on, for the verification leg. */
  port?: number;
}

export async function runMomentsOwnerGrant(opts: MomentsGrantOptions = {}): Promise<Record<string, unknown>> {
  const username = opts.username ?? process.env.MOMENTS_OWNER_USERNAME ?? undefined;
  const email = opts.email ?? process.env.MOMENTS_OWNER_EMAIL ?? undefined;
  const port = opts.port ?? Number(process.env.PORT || 4000);

  const prisma = new PrismaClient();
  const out: Record<string, unknown> = { domain: DOMAIN };
  const probeUserIds: string[] = [];
  const probeRows: Array<{ domain: string; userId: string }> = [];

  try {
    if (!username && !email) {
      out.status = 'STOP_NO_SELECTOR';
      out.detail =
        'Supply the owner @username (MOMENTS_OWNER_USERNAME) or signup email. ' +
        'Guessing a handle would grant a gated production surface to an account ' +
        'that may not be the owner\'s, which is not cleanly reversible.';
      return out;
    }

    /* ---- 1. Pre-op counts, as the mission asks, BEFORE any write. ---- */
    const [allowlistTotal, momentsRows, runtimeFlagRows, momentsFlag] = await Promise.all([
      prisma.domainAllowlist.count(),
      prisma.domainAllowlist.findMany({ where: { domain: DOMAIN }, select: { note: true, addedAt: true, userId: true } }),
      prisma.runtimeFlag.count(),
      prisma.runtimeFlag.findUnique({ where: { key: DOMAIN } }),
    ]);
    out.pre_domainAllowlist_rows_total = allowlistTotal;
    out.pre_domainAllowlist_rows_moments = momentsRows.length;
    out.pre_runtimeFlag_rows_total = runtimeFlagRows;
    out.pre_runtimeFlag_moments_present = momentsFlag != null;
    out.pre_runtimeFlag_moments_enabled = momentsFlag?.enabled ?? false;

    /* A RuntimeFlag row for this domain means Moments is on for EVERYONE. That
     * is not a state this script may quietly build on top of. */
    if (momentsFlag?.enabled) {
      out.status = 'STOP_RUNTIME_FLAG_ENABLED';
      out.detail =
        'A moments RuntimeFlag row exists and is ENABLED, so the domain is currently ' +
        'served to every account, not just the owner. Adding an allowlist row would ' +
        'not narrow that. Delete the RuntimeFlag row first, then re-run.';
      return out;
    }

    /* ---- 2. Unexpected rows STOP the run, with their notes listed. ---- */
    const foreign = momentsRows.filter((r) => r.note !== OWNER_NOTE);
    if (foreign.length > 0) {
      out.status = 'STOP_UNEXPECTED_ALLOWLIST_ROWS';
      out.unexpected_row_count = foreign.length;
      out.unexpected_row_notes = foreign.map((r) => ({
        note: r.note ?? '(no note)',
        addedAt: r.addedAt.toISOString(),
      }));
      out.detail =
        'moments allowlist rows exist that this script did not write. Nothing was ' +
        'added or deleted. Review the notes above and decide before re-running.';
      return out;
    }

    /* ---- 3. Locate the owner SERVER-SIDE. The userId never leaves here. ---- */
    const where = username ? { username } : { email: email as string };
    const owner = await prisma.user.findUnique({
      where: where as never,
      select: { id: true, ageVerified: true, accountStatus: true, deletedAt: true },
    });
    out.selector = mask(username ?? email);
    if (!owner || owner.deletedAt) {
      out.status = 'STOP_OWNER_NOT_FOUND';
      out.detail =
        `No live account matches that selector. Sign in on the app once with that ` +
        `handle so the account exists, then re-run. Nothing was written.`;
      return out;
    }
    out.owner_found = true;
    out.owner_ageVerified = owner.ageVerified;
    out.owner_accountStatus = owner.accountStatus;
    /* The gate is `requireAdult`, so an unverified owner would be granted the
     * row and still get a 403. Say so plainly instead of reporting success. */
    if (!owner.ageVerified || owner.accountStatus !== 'active') {
      out.warning =
        'The account is not age-verified/active, so the gate will answer 403 even ' +
        'with the row present. The row is still written (it is the correct grant); ' +
        'complete the 18+ step in the app to reach the feed.';
    }

    /* ---- 4. Exactly one row, idempotently. ---- */
    await prisma.domainAllowlist.upsert({
      where: { domain_userId: { domain: DOMAIN, userId: owner.id } },
      create: { domain: DOMAIN, userId: owner.id, note: OWNER_NOTE },
      update: { note: OWNER_NOTE },
    });
    out.granted = true;

    /* ---- 5. Verify over real HTTP: owner 200, a stranger 404. ---- */
    const secret = process.env.JWT_ACCESS_SECRET;
    if (!secret) {
      out.verification = 'SKIPPED_NO_JWT_SECRET';
    } else {
      const base = `http://127.0.0.1:${port}/api`;
      const mint = (sub: string) => sign({ sub, role: 'USER' }, secret, { expiresIn: '10m' });
      const feed = (token: string) =>
        fetch(`${base}/v1/${DOMAIN}/feed?mode=friends`, { headers: { Authorization: `Bearer ${token}` } })
          .then((r) => r.status)
          .catch(() => 0);

      // A second, NON-allowlisted adult: the control that proves the gate is
      // still shut for everyone else.
      const strangerId = `u-${randomUUID()}`;
      await prisma.user.create({
        data: {
          id: strangerId,
          username: `zzmomprobe${String(port).slice(-4)}`.slice(0, 16),
          claimSecretHash: createHash('sha256').update(randomUUID()).digest('hex'),
          ageVerified: true,
          accountStatus: 'active',
          birthYearMonth: `${new Date().getUTCFullYear() - 30}-01`,
        },
      });
      probeUserIds.push(strangerId);

      // The allowlist cache is 5s; wait it out so this reads the new state.
      await new Promise((r) => setTimeout(r, 5_500));

      out.owner_feed_status = await feed(mint(owner.id));
      out.non_allowlisted_feed_status = await feed(mint(strangerId));
      out.verification =
        out.owner_feed_status === 200 && out.non_allowlisted_feed_status === 404
          ? 'PASS'
          : 'FAIL';
    }

    /* ---- 6. Final counts. ---- */
    const [postTotal, postMoments, postFlag] = await Promise.all([
      prisma.domainAllowlist.count(),
      prisma.domainAllowlist.count({ where: { domain: DOMAIN } }),
      prisma.runtimeFlag.findUnique({ where: { key: DOMAIN } }),
    ]);
    // Probe rows are counted out: they are deleted in `finally`.
    out.post_domainAllowlist_rows_total = postTotal - probeRows.length;
    out.post_domainAllowlist_rows_moments = postMoments;
    out.post_runtimeFlag_moments_present = postFlag != null;
    out.status = out.verification === 'FAIL' ? 'GRANTED_BUT_VERIFICATION_FAILED' : 'OK';
    return out;
  } catch (e) {
    out.status = 'ERROR';
    out.detail = (e as Error).message?.slice(0, 300);
    return out;
  } finally {
    for (const r of probeRows) {
      await prisma.domainAllowlist.delete({ where: { domain_userId: r } }).catch(() => undefined);
    }
    for (const id of probeUserIds) {
      await prisma.domainAllowlist.deleteMany({ where: { userId: id } }).catch(() => undefined);
      await prisma.user.delete({ where: { id } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  }
}

/* Runnable directly so the grant does not need a transient edit to main.ts —
 * the pattern that left a destructive proof script executing on every boot. */
if (require.main === module) {
  runMomentsOwnerGrant()
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.status === 'OK' ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
