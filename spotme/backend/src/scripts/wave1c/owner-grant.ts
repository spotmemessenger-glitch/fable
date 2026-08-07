/**
 * Wave 1C, C7 — Stage-A INVITED-SET GRANT (owner + explicitly named friends).
 *
 * Runs INSIDE the deployed image (needs the private DB + a loopback HTTP call),
 * wired transiently into main.ts for one deploy and reverted after capture.
 *
 * SCOPE (owner directive): a SMALL invited set — the owner plus up to ~10
 * friends, each an EXPLICIT row. No wildcard, no "any email" open access;
 * public access is Stage C and needs the owner's explicit go.
 *
 * Each invitee is located SERVER-SIDE by a selector the owner supplies:
 *  - `email`    — for accounts made via /auth/signup (which records email);
 *  - `username` — for accounts made via the web app's guest flow, which
 *                 records NO email; the claimed @username is the identifier.
 * The tool never asks for, prints, or logs a userId; selectors are masked in
 * output. Per run it:
 *   1. reports the pre-op allowlist COUNT **for DOMAIN only**; any row that
 *      does not belong to the current invited set STOPS the run (notes listed,
 *      nothing deleted) for the owner's decision;
 *   2. upserts one row per LOCATED invitee (idempotent — re-runs never
 *      duplicate), note carrying who/why; refuses to exceed MAX_ROWS;
 *   3. verifies: every located invitee → 200; a non-allowlisted adult → 404;
 *      an allowlisted-but-unverified account → 403; RuntimeFlag zero rows;
 *      final row count == located invitees;
 *   4. reports invitees NOT yet found (masked) as pending — they get their row
 *      on a later run, after they sign up;
 *   5. cleans up every probe row it created.
 *
 * REVOCATION: delete that user's row (DomainAllowlist, domain=DOMAIN) — dark
 * again for them within one 5s cache window. Auditable: every row has note +
 * addedAt; list with the DomainAllowlistService or plain SQL.
 *
 * ---------------------------------------------------------------------------
 * CURRENT TARGET (2026-08-07): DOMAIN='moments', invited set = @yuv2 alone.
 *
 * `DOMAIN` scopes every read and write in this file, so a run in this
 * configuration cannot see or modify the `discovery` rows — they live under a
 * different (domain, userId) key and are never queried.
 *
 * What this run does NOT do, and must not: it creates no RuntimeFlag row and
 * flips no flag. A flag row would open Moments for every verified adult; one
 * allowlist row opens it for one account. That difference is the entire point
 * of the change.
 */

import { PrismaClient } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import { createHash } from 'node:crypto';

/** The invited set. Owner first; append friends (email OR username) as they
 *  join, then re-run. Growing this list is a code change — deliberate, so
 *  every widening is diffable and attributable. HARD CAP below. */
const INVITED: Array<{ email?: string; username?: string; note: string }> = [
  { username: 'yuv2', note: 'stage-a invitee: @yuv2 (moments)' },
];
const MAX_ROWS = 11; // owner + ~10 — Stage-A scale guard
/* The domain this run grants. Every query below is scoped by it, so pointing
 * this at 'moments' leaves the 'discovery' allowlist rows completely
 * untouched — they are a different (domain, userId) key space and this script
 * never reads or writes outside DOMAIN. */
const DOMAIN = 'moments';

function mask(s: string | null | undefined): string {
  if (!s) return '(none)';
  const at = s.indexOf('@');
  if (at > 0) return `${s.slice(0, 1)}***${s.slice(at - 1)}`;
  return `${s.slice(0, 2)}***`;
}

export async function runOwnerGrant(port: number): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient();
  const base = `http://127.0.0.1:${port}/api`;
  const secret = process.env.JWT_ACCESS_SECRET as string;
  const out: Record<string, unknown> = {};
  const probeIds: string[] = [];
  const mint = (sub: string) => sign({ sub, role: 'USER' }, secret, { expiresIn: '10m' });
  /* The gated surface this run probes. Moments mounts at /v1/moments behind
   * DomainGate('moments', { requireAdult: true }) — the same guard shape
   * Discovery uses, so the 200 / 404 / 403 expectations below are unchanged. */
  const disc = (token: string, path = '/feed?mode=friends', init: RequestInit = {}) =>
    fetch(`${base}/v1/moments${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  try {
    if (INVITED.length > MAX_ROWS) {
      out.status = 'STOP_INVITED_SET_TOO_LARGE';
      out.detail = `${INVITED.length} invitees exceeds the Stage-A cap of ${MAX_ROWS}. Widening beyond this is Stage B/C and needs the owner's explicit go.`;
      return out;
    }

    // ---- 0. Privacy-safe aggregate diagnostic (counts only, never PII). ----
    const [total, adults, withBYM, frozen, mostRecent] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: null, ageVerified: true, accountStatus: 'active' } }),
      prisma.user.count({ where: { deletedAt: null, birthYearMonth: { not: null } } }),
      prisma.user.count({ where: { deletedAt: null, accountStatus: 'frozen_minor' } }),
      prisma.user.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    out.diag = {
      total_accounts: total,
      adult_active: adults,
      with_birthYearMonth: withBYM,
      frozen_minor: frozen,
      most_recent_signup_utc: mostRecent?.createdAt?.toISOString() ?? '(none)',
    };

    // ---- 1. LOCATE each invitee server-side (exact unique selector). ----
    const located: Array<{ id: string; note: string; masked: string }> = [];
    const pending: string[] = [];
    const notEligible: Array<{ masked: string; why: string }> = [];
    for (const inv of INVITED) {
      const selector = inv.email ? { email: inv.email } : inv.username ? { username: inv.username } : null;
      if (!selector) continue;
      const row = await prisma.user.findFirst({
        where: { ...selector, deletedAt: null },
        select: { id: true, ageVerified: true, accountStatus: true },
      });
      const masked = mask(inv.email ?? inv.username);
      if (!row) {
        pending.push(masked);
      } else if (row.ageVerified !== true || row.accountStatus !== 'active') {
        // The gate would 403 them anyway; recorded so the owner knows why.
        notEligible.push({ masked, why: row.accountStatus !== 'active' ? 'account not active' : 'age not verified' });
      } else {
        located.push({ id: row.id, note: inv.note, masked });
      }
    }
    out.invitees_located = located.map((l) => l.masked);
    out.invitees_pending_signup = pending;
    out.invitees_not_eligible = notEligible;

    // ---- 2. PRE-OP allowlist state (count + notes, never userIds). ----
    const preRows = await prisma.domainAllowlist.findMany({
      where: { domain: DOMAIN },
      select: { userId: true, note: true },
    });
    out.pre_allowlist_count = preRows.length;
    out.pre_allowlist_notes = preRows.map((r) => r.note ?? '(no note)');
    const invitedIds = new Set(located.map((l) => l.id));
    const foreign = preRows.filter((r) => !invitedIds.has(r.userId));
    if (foreign.length > 0) {
      out.status = 'STOP_PREEXISTING_ALLOWLIST_ROWS';
      out.detail = 'Rows exist that are not in the current invited set; not deleting. Notes listed above. Awaiting owner decision.';
      return out;
    }
    if (located.length === 0) {
      out.status = 'STOP_NO_INVITEE_ACCOUNTS_FOUND';
      out.detail = 'No invited account exists (eligible) in this database yet. Sign up + 18+ declaration first, then re-run.';
      return out;
    }

    // ---- 3. UPSERT one row per located invitee (idempotent). ----
    for (const l of located) {
      await prisma.domainAllowlist.upsert({
        where: { domain_userId: { domain: DOMAIN, userId: l.id } },
        update: { note: l.note },
        create: { domain: DOMAIN, userId: l.id, note: l.note },
      });
    }
    await sleep(5500); // gate's 5s allowlist cache

    // ---- 4. VERIFY. ----
    // (a) every located invitee → 200 on Discovery (ephemeral internal token).
    const inviteeStatuses: Record<string, number> = {};
    for (const l of located) inviteeStatuses[l.masked] = (await disc(mint(l.id))).status;
    out.invitee_feed_GET = inviteeStatuses; // expect all 200
    // A second gated route, read-only: proves the whole domain opened, not one
    // handler. GET only — this run must create no Moments content.
    out.first_invitee_stories_rail_GET = (await disc(mint(located[0].id), '/stories/rail')).status; // expect 200

    // (b) a NON-allowlisted adult → 404.
    const otherId = 'zzgrantoth0000000'.slice(0, 16);
    probeIds.push(otherId);
    await prisma.user.create({
      data: { id: otherId, username: `zzgrantoth${port}`.slice(0, 16), claimSecretHash: createHash('sha256').update('x').digest('hex'), ageVerified: true, accountStatus: 'active', birthYearMonth: `${new Date().getUTCFullYear() - 30}-01` },
    });
    out.nonallowlisted_adult_404 = (await disc(mint(otherId))).status; // expect 404

    // (c) an UNVERIFIED account, allowlisted (clears existence) → 403.
    const unvId = 'zzgrantunv0000000'.slice(0, 16);
    probeIds.push(unvId);
    await prisma.user.create({
      data: { id: unvId, username: `zzgrantunv${port}`.slice(0, 16), claimSecretHash: createHash('sha256').update('y').digest('hex') },
    });
    await prisma.domainAllowlist.create({ data: { domain: DOMAIN, userId: unvId, note: 'probe-403 (removed)' } });
    await sleep(5500);
    out.allowlisted_unverified_403 = (await disc(mint(unvId))).status; // expect 403
    await prisma.domainAllowlist.deleteMany({ where: { domain: DOMAIN, userId: unvId } });

    // (d) RuntimeFlag remains zero rows for this domain. This run must NOT
    //     create one: a flag row opens the domain for EVERY verified adult,
    //     which is the opposite of a one-account grant.
    out.runtimeflag_rows_for_domain = await prisma.runtimeFlag.count({ where: { key: DOMAIN } }); // expect 0

    // (e) final rows == located invitees, every note accounted for.
    const finalRows = await prisma.domainAllowlist.findMany({ where: { domain: DOMAIN }, select: { userId: true, note: true, addedAt: true } });
    out.final_allowlist_count = finalRows.length; // expect located.length
    out.final_allowlist_notes = finalRows.map((r) => ({ note: r.note, at: r.addedAt.toISOString() }));
    out.final_rows_match_invited = finalRows.length === located.length && finalRows.every((r) => invitedIds.has(r.userId));
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    await prisma.domainAllowlist.deleteMany({ where: { domain: DOMAIN, userId: { in: probeIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: probeIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  return out;
}
