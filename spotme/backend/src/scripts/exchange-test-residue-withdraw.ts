/**
 * ONE-SHOT CLEANUP (2026-08-08): withdraw the orphaned TEST intents left by
 * this session's browser sweeps. Their owner accounts are soft-deleted, so no
 * owner token can ever withdraw them, and browse would otherwise show them to
 * real users for up to 30 days.
 *
 * TIGHTLY SCOPED, doubly: the title must match one of the sweep's exact
 * prefixes AND the owner row must already be soft-deleted (deletedAt set) or
 * absent. A real user's intent can satisfy neither. Idempotent: withdrawn
 * rows don't match the status filter on a re-run.
 *
 * Wired into main.ts by commit A of an A/B pair; commit B reverts. No boot
 * hook survives in the tree (the M2-proof lesson).
 */
import { PrismaService } from '../prisma/prisma.service';

export async function runExchangeTestResidueWithdraw(prisma: PrismaService): Promise<unknown> {
  const rows = await prisma.$queryRaw<Array<{ id: string; title: string }>>`
    SELECT i."id", i."title" FROM "ExchangeIntent" i
    LEFT JOIN "User" u ON u."id" = i."ownerId"
    WHERE i."status" IN ('active', 'matched', 'paused', 'draft')
      AND (i."title" LIKE 'Sweep intent%' OR i."title" LIKE 'Live prox:%' OR i."title" LIKE 'Prox proof:%' OR i."title" LIKE 'E2E proof:%')
      AND (u."id" IS NULL OR u."deletedAt" IS NOT NULL)
  `;
  for (const r of rows) {
    await prisma.exchangeIntent.update({ where: { id: r.id }, data: { status: 'withdrawn', versionSeq: { increment: 1 } } });
  }
  return { withdrawn: rows.map((r) => r.title) };
}
