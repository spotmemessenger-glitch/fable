/**
 * Wave 1C, C7 — in-network LIVE Stage-A validation. TEMPORARY (reverted after).
 *
 * Runs INSIDE the deployed image (it needs the private DB + a loopback HTTP
 * call). It stands up three probe accounts, allowlists ONE, and validates the
 * exact Stage-A behaviour against the running server, then CLEANS UP so
 * production ends with zero allowlist rows (fully dark). Aggregate results only.
 *
 * A probe stands in for the owner's account on the identical code path; the
 * real owner account is one `DomainAllowlist` row away (see the report).
 */

import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

const AGE_ADULT = `${new Date().getUTCFullYear() - 30}-01`;
const AGE_MINOR = `${new Date().getUTCFullYear() - 15}-01`;

export async function runStageAValidation(port: number): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient();
  const base = `http://127.0.0.1:${port}/api`;
  const RUN = `stga${Date.now().toString(36)}`.toLowerCase();
  const ids: string[] = [];
  const out: Record<string, unknown> = {};
  const guest = async (hex: string, tag: string, extra: Record<string, unknown>) => {
    const id = `${hex}${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
    ids.push(id);
    const r = await fetch(`${base}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, username: `${RUN}${tag}`.slice(0, 16), secret: `sec-${tag}-12345678`, ...extra }) });
    const j = (await r.json()) as { accessToken?: string; userId?: string };
    return { id: j.userId ?? id, token: j.accessToken };
  };
  const disc = (path: string, token?: string, init: RequestInit = {}) =>
    fetch(`${base}/v2/discovery${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });

  try {
    // Three probes: the "owner" (allowlisted adult), a non-allowlisted adult, an unverified account.
    const owner = await guest('a', 'own', { birthYearMonth: AGE_ADULT });
    const other = await guest('b', 'oth', { birthYearMonth: AGE_ADULT });
    // unverified: pre-create then reauth without a declaration.
    const unvId = `c${RUN}0000000000000`.replace(/[^a-f0-9]/gi, 'f').slice(0, 16);
    ids.push(unvId);
    await prisma.user.create({ data: { id: unvId, username: `${RUN}unv`.slice(0, 16), claimSecretHash: createHash('sha256').update('sec-unv-12345678').digest('hex') } });
    const unvR = await fetch(`${base}/auth/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: unvId, username: `${RUN}unv`.slice(0, 16), secret: 'sec-unv-12345678' }) });
    const unv = { id: unvId, token: ((await unvR.json()) as { accessToken?: string }).accessToken };

    // Pre-allowlist state: everyone 404 (production posture, flag absent).
    out.beforeAllowlist_owner = (await disc('/visibility', owner.token)).status;

    // ENABLE Stage A for the "owner" probe ONLY — one auditable row.
    await prisma.domainAllowlist.create({ data: { domain: 'discovery', userId: owner.id, note: `stage-A live probe ${RUN}` } });
    // Wait out the gate's 5s allowlist cache.
    await new Promise((r) => setTimeout(r, 5500));

    // VALIDATE from the running server:
    out.owner_visibility_GET = (await disc('/visibility', owner.token)).status;          // expect 200
    out.owner_visibility_PUT = (await disc('/visibility', owner.token, { method: 'PUT', body: JSON.stringify({ enabled: true, origin: { lat: 12.9766, lon: 77.5913 } }) })).status; // write
    out.owner_ghost_PUT = (await disc('/visibility', owner.token, { method: 'PUT', body: JSON.stringify({ enabled: false }) })).status; // ghost off
    out.owner_query = (await disc('/query', owner.token, { method: 'POST', body: JSON.stringify({ contractsVersion: 1, intent: { kind: 'people' }, scope: 'people', origin: { lat: 12.9766, lon: 77.5913 }, radius: { km: 2 } }) })).status;
    // username search rides the existing, always-live users/lookup path:
    out.owner_search = (await fetch(`${base}/users/lookup?username=${owner.id.slice(0, 6)}`, { headers: { Authorization: `Bearer ${owner.token}` } })).status;
    out.nonallowlisted_404 = (await disc('/visibility', other.token)).status;            // expect 404
    out.unverified_403 = (await disc('/visibility', unv.token)).status;                  // expect 403
    out.allowlist_rows = (await prisma.domainAllowlist.findMany({ where: { domain: 'discovery' } })).map((r) => ({ note: r.note, at: r.addedAt.toISOString() }));
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    // CLEAN UP: remove the allowlist row + all probe rows → production dark, zero rows.
    await prisma.domainAllowlist.deleteMany({ where: { domain: 'discovery' } }).catch(() => undefined);
    await prisma.discoveryVisibility.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.refreshToken.deleteMany({ where: { userId: { in: ids } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
    out.cleanup_allowlistRowsRemaining = await prisma.domainAllowlist.count({ where: { domain: 'discovery' } }).catch(() => -1);
    await prisma.$disconnect().catch(() => undefined);
  }
  return out;
}
