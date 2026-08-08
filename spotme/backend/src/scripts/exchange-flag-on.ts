/**
 * ONE-SHOT ACTIVATION (2026-08-08): upsert the single RuntimeFlag row that
 * enables the `exchange` domain for EVERY authenticated account.
 *
 * Deliberately NOT the DomainAllowlist — that gates per account, and the owner
 * directive is the opposite: open to everyone. One row, domain-wide.
 *
 * Wired into main.ts by a TEMPORARY commit (A) and removed by the immediately
 * following revert commit (B) — the lesson of the M2 proof hook that was never
 * reverted and replayed writes on every boot. This script is idempotent and
 * read-modify-safe (an upsert), but it still must not live in the boot path.
 */

import { PrismaService } from '../prisma/prisma.service';

export async function runExchangeFlagOn(prisma: PrismaService): Promise<unknown> {
  const row = await prisma.runtimeFlag.upsert({
    where: { key: 'exchange' },
    create: { key: 'exchange', enabled: true },
    update: { enabled: true },
  });
  const readBack = await prisma.runtimeFlag.findUnique({ where: { key: 'exchange' } });
  return { upserted: row, readBack };
}
