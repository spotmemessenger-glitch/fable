/**
 * Wave 1C, C7 — Stage-A OWNER GRANT (explicit owner "go"). TEMPORARY (reverted).
 *
 * Runs INSIDE the deployed image (needs the private DB + a loopback HTTP call).
 * It:
 *   1. locates the owner's account SERVER-SIDE (by their signup email) — never
 *      asks for, prints, or logs the userId;
 *   2. reports the pre-op Discovery allowlist COUNT, and if any UNEXPECTED rows
 *      exist (anything other than the owner's own 'stage-a owner' grant) it
 *      STOPS without deleting — for the owner's decision;
 *   3. inserts EXACTLY ONE `DomainAllowlist` row for the owner (idempotent
 *      upsert), note 'stage-a owner';
 *   4. verifies: owner → 200, a non-allowlisted adult → 404, an allowlisted-but-
 *      unverified account → 403, RuntimeFlag zero rows, exactly ONE allowlist
 *      row after the operation;
 *   5. cleans up every probe row it created — the owner's grant is the only
 *      thing left behind.
 *
 * Aggregate results only. No userId, no full email, ever leaves this function.
 */

import { PrismaClient } from '@prisma/client';
import { sign } from 'jsonwebtoken';
import { createHash } from 'node:crypto';

// The owner's account is located by the email their real signup recorded.
const OWNER_EMAIL = 'movietrends47@gmail.com';
const DOMAIN = 'discovery';
const NOTE = 'stage-a owner';

function maskEmail(e: string | null | undefined): string {
  if (!e) return '(none)';
  const [u, d] = e.split('@');
  if (!d) return '***';
  return `${u.slice(0, 1)}***${u.slice(-1)}@${d}`;
}

export async function runOwnerGrant(port: number): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient();
  const base = `http://127.0.0.1:${port}/api`;
  const secret = process.env.JWT_ACCESS_SECRET as string;
  const out: Record<string, unknown> = {};
  const probeIds: string[] = [];
  const mint = (sub: string) => sign({ sub, role: 'USER' }, secret, { expiresIn: '10m' });
  const disc = (token: string, path = '/visibility', init: RequestInit = {}) =>
    fetch(`${base}/v2/discovery${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  try {
    // ---- 0. Privacy-safe aggregate diagnostic (counts only, never PII). ----
    const nowYear = new Date().getUTCFullYear();
    const [total, adults, withBYM, frozen, guests, withEmail, mostRecent] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null } }),
      prisma.user.count({ where: { deletedAt: null, ageVerified: true, accountStatus: 'active' } }),
      prisma.user.count({ where: { deletedAt: null, birthYearMonth: { not: null } } }),
      prisma.user.count({ where: { deletedAt: null, accountStatus: 'frozen_minor' } }),
      prisma.user.count({ where: { deletedAt: null, email: null } }),
      prisma.user.count({ where: { deletedAt: null, email: { not: null } } }),
      prisma.user.findFirst({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
    ]);
    out.diag = {
      total_accounts: total,
      adult_active: adults,
      with_birthYearMonth: withBYM,
      frozen_minor: frozen,
      guest_no_email: guests,
      with_email: withEmail,
      most_recent_signup_utc: mostRecent?.createdAt?.toISOString() ?? '(none)',
      now_year: nowYear,
    };

    // ---- 1. LOCATE THE OWNER (server-side, by signup email). ----
    // email is @unique, so this is 0 or 1 rows.
    let owner = await prisma.user.findFirst({
      where: { email: OWNER_EMAIL, deletedAt: null },
      select: { id: true, email: true, ageVerified: true, accountStatus: true },
    });
    let locatedBy = 'email';
    if (!owner) {
      // Fallback: the single adult, active, non-deleted account. In staging this
      // is the owner's account (there is no other real cohort). Only auto-select
      // when there is EXACTLY ONE — any ambiguity STOPS below.
      const adults = await prisma.user.findMany({
        where: { ageVerified: true, accountStatus: 'active', deletedAt: null },
        select: { id: true, email: true, ageVerified: true, accountStatus: true },
      });
      out.adult_active_account_count = adults.length;
      if (adults.length === 1) {
        owner = adults[0];
        locatedBy = 'sole-adult-account';
      } else {
        out.status = 'STOP_OWNER_NOT_UNIQUELY_IDENTIFIED';
        out.detail =
          adults.length === 0
            ? 'No account found by the owner email, and no adult+active account exists. Complete signup + 18+ declaration first.'
            : `Found ${adults.length} adult+active accounts and none match the owner email; cannot disambiguate safely without a selector.`;
        return out;
      }
    }
    out.owner_located_by = locatedBy;
    out.owner_email_masked = maskEmail(owner.email);
    // The owner's own account must itself satisfy the age gate, or the grant
    // would verify to 403 rather than 200.
    if (owner.ageVerified !== true || owner.accountStatus !== 'active') {
      out.status = 'STOP_OWNER_ACCOUNT_NOT_ADULT_ACTIVE';
      out.owner_ageVerified = owner.ageVerified === true;
      out.owner_accountStatus = owner.accountStatus;
      return out;
    }
    const ownerId = owner.id;

    // ---- 2. PRE-OP allowlist state (count + notes, never userIds). ----
    const preRows = await prisma.domainAllowlist.findMany({
      where: { domain: DOMAIN },
      select: { userId: true, note: true },
    });
    out.pre_allowlist_count = preRows.length;
    out.pre_allowlist_notes = preRows.map((r) => r.note ?? '(no note)');
    // Any row that is NOT the owner's own 'stage-a owner' grant is unexpected:
    // report notes and STOP for the owner's decision (never delete).
    const foreign = preRows.filter((r) => !(r.userId === ownerId && r.note === NOTE));
    if (foreign.length > 0) {
      out.status = 'STOP_PREEXISTING_ALLOWLIST_ROWS';
      out.detail = 'Pre-existing allowlist rows present; not deleting. Notes listed above. Awaiting owner decision.';
      return out;
    }
    out.already_granted = preRows.some((r) => r.userId === ownerId && r.note === NOTE);

    // ---- 3. INSERT exactly one row (idempotent upsert). ----
    await prisma.domainAllowlist.upsert({
      where: { domain_userId: { domain: DOMAIN, userId: ownerId } },
      update: { note: NOTE },
      create: { domain: DOMAIN, userId: ownerId, note: NOTE },
    });
    // Wait out the gate's 5s allowlist cache (fresh process, but belt-and-braces).
    await sleep(5500);

    // ---- 4. VERIFY. ----
    // (a) owner → 200 on the Discovery routes (ephemeral internal token).
    out.owner_visibility_GET = (await disc(mint(ownerId))).status; // expect 200
    out.owner_query_POST = (
      await disc(mint(ownerId), '/query', {
        method: 'POST',
        body: JSON.stringify({ contractsVersion: 1, intent: { kind: 'people' }, scope: 'people', origin: { lat: 12.9766, lon: 77.5913 }, radius: { km: 2 } }),
      })
    ).status; // expect 2xx

    // (b) a second, NON-allowlisted adult → 404.
    const otherId = `zzgrantoth0000000`.slice(0, 16);
    probeIds.push(otherId);
    await prisma.user.create({
      data: { id: otherId, username: `zzgrantoth${port}`.slice(0, 16), claimSecretHash: createHash('sha256').update('x').digest('hex'), ageVerified: true, accountStatus: 'active', birthYearMonth: `${new Date().getUTCFullYear() - 30}-01` },
    });
    out.nonallowlisted_adult_404 = (await disc(mint(otherId))).status; // expect 404

    // (c) an UNVERIFIED account, allowlisted (so it clears existence) → 403.
    const unvId = `zzgrantunv0000000`.slice(0, 16);
    probeIds.push(unvId);
    await prisma.user.create({
      data: { id: unvId, username: `zzgrantunv${port}`.slice(0, 16), claimSecretHash: createHash('sha256').update('y').digest('hex') },
    });
    await prisma.domainAllowlist.create({ data: { domain: DOMAIN, userId: unvId, note: 'probe-403 (removed)' } });
    await sleep(5500);
    out.allowlisted_unverified_403 = (await disc(mint(unvId))).status; // expect 403
    // Remove the probe's allowlist row so the final count is exactly the owner's.
    await prisma.domainAllowlist.deleteMany({ where: { domain: DOMAIN, userId: unvId } });

    // (d) RuntimeFlag remains zero rows for discovery.
    out.runtimeflag_discovery_rows = await prisma.runtimeFlag.count({ where: { key: DOMAIN } }); // expect 0

    // (e) exactly ONE allowlist row after the operation.
    const finalRows = await prisma.domainAllowlist.findMany({ where: { domain: DOMAIN }, select: { userId: true, note: true } });
    out.final_allowlist_count = finalRows.length; // expect 1
    out.final_allowlist_is_owner_only = finalRows.length === 1 && finalRows[0].userId === ownerId && finalRows[0].note === NOTE;
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    // Clean up EVERY probe row this run created — the owner's grant stays.
    await prisma.domainAllowlist.deleteMany({ where: { domain: DOMAIN, userId: { in: probeIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: probeIds } } }).catch(() => undefined);
    await prisma.$disconnect().catch(() => undefined);
  }
  return out;
}
