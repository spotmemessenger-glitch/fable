/**
 * Wave 1A R7 — kill-switch fences (real Postgres).
 *
 * Proves the contract the Activation Programme depends on:
 *  - FAIL DARK: missing row → disabled; DB error → disabled.
 *  - Affirmative enable only: enabled=true answers, enabled=false does not.
 *  - ONE ROW FLIP propagates within one cache window — no restart of anything.
 *  - The HTTP gate answers 404 (the unmounted-module state), never 403.
 *  - Every REAL domain key (discovery, exchange, events, moments, assistant)
 *    defaults dark on a migrated database.
 */

import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  DOMAIN_FLAGS,
  FLAG_CACHE_TTL_MS,
  RuntimeFlagService,
} from '../src/flags/runtime-flag.service';
import { DomainGate } from '../src/flags/domain-gate.guard';

const prisma = new PrismaClient();
const KEY = 'wave1a-test-flag';

const svc = () => new RuntimeFlagService(prisma as unknown as PrismaService);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  await prisma.$connect();
});

afterEach(async () => {
  await prisma.runtimeFlag.deleteMany({ where: { key: { startsWith: 'wave1a-test' } } });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('RuntimeFlagService (R7 kill-switch)', () => {
  it('FAIL DARK: a missing row is disabled', async () => {
    expect(await svc().isEnabled(KEY)).toBe(false);
  });

  it('FAIL DARK: a database error is disabled, not an exception', async () => {
    const broken = new RuntimeFlagService({
      runtimeFlag: {
        findUnique: () => Promise.reject(new Error('db unreachable')),
      },
    } as unknown as PrismaService);
    expect(await broken.isEnabled(KEY)).toBe(false);
  });

  it('only an affirmative enabled=true answers', async () => {
    await prisma.runtimeFlag.create({ data: { key: KEY, enabled: false } });
    expect(await svc().isEnabled(KEY)).toBe(false);
    await prisma.runtimeFlag.update({ where: { key: KEY }, data: { enabled: true } });
    expect(await svc().isEnabled(KEY)).toBe(true); // fresh service, no stale cache
  });

  it('a one-row flip propagates within one cache window, no restart', async () => {
    const s = svc();
    await prisma.runtimeFlag.create({ data: { key: KEY, enabled: true } });
    expect(await s.isEnabled(KEY)).toBe(true);

    // The rollback flip: ONE UPDATE, same running service instance.
    const flippedAt = Date.now();
    await prisma.runtimeFlag.update({ where: { key: KEY }, data: { enabled: false } });
    // Immediately after, the cache may still answer true — that is the design.
    // Within one TTL it MUST answer false.
    let darkAt: number | null = null;
    const deadline = flippedAt + FLAG_CACHE_TTL_MS + 2_000;
    while (Date.now() < deadline) {
      if (!(await s.isEnabled(KEY))) {
        darkAt = Date.now();
        break;
      }
      await sleep(100);
    }
    expect(darkAt).not.toBeNull();
    const propagationMs = (darkAt as number) - flippedAt;
    expect(propagationMs).toBeLessThan(60_000); // the R7 bar
    expect(propagationMs).toBeLessThanOrEqual(FLAG_CACHE_TTL_MS + 2_000); // the real design bound
  }, 15_000);

  it('the HTTP gate answers 404 — the unmounted-module state — when dark', async () => {
    const GateClass = DomainGate('wave1a-test-gate');
    const guard = new GateClass(svc());
    await expect((guard as { canActivate: () => Promise<boolean> }).canActivate()).rejects.toThrow(
      NotFoundException,
    );
  });

  it('every REAL domain flag defaults dark on a migrated database', async () => {
    const s = svc();
    for (const domain of DOMAIN_FLAGS) {
      expect(await s.isEnabled(domain)).toBe(false);
    }
    // And no row for them exists at all — nothing was ever flipped.
    const rows = await prisma.runtimeFlag.findMany({ where: { key: { in: [...DOMAIN_FLAGS] } } });
    expect(rows).toHaveLength(0);
  });
});
