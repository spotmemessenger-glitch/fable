/**
 * Wave 1A R7 — the activation kill-switch.
 *
 * One `RuntimeFlag` row per dark domain. The contract, in order of what matters:
 *
 * FAIL DARK. A missing row is DISABLED. A database error is DISABLED. An
 * unreadable value is DISABLED. The only way a gated surface answers is a row
 * that affirmatively says `enabled = true` — so the switch can only ever fail
 * into the safe state, never out of it.
 *
 * ONE CONFIG CHANGE, NO RESTART. Flipping a domain is a single-row UPDATE (or
 * INSERT). No migration, no redeploy, no process restart. The short read-through
 * cache below is the ONLY propagation delay, so rollback-to-dark completes in
 * seconds — measured against the R7 bar of sixty.
 *
 * BOUNDED READS. Flag reads race a short timeout so a wedged database turns
 * into "disabled" (dark), never into a hung request path.
 *
 * The same service gates HTTP (via DomainGateGuard) and background work: a job
 * processor asks `isEnabled(domain)` before doing domain work, so flipping a
 * domain off also stops its jobs within one cache window.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/** How long a read is trusted before the next DB read. Rollback propagation ≤ this. */
export const FLAG_CACHE_TTL_MS = 5_000;
/** A flag read that outlives this returns the safe answer (disabled). */
const FLAG_READ_TIMEOUT_MS = 1_500;

/** The dark domains Wave 1C may activate; the ONLY keys the gate recognises. */
export const DOMAIN_FLAGS = ['discovery', 'exchange', 'events', 'moments', 'assistant'] as const;
export type DomainFlag = (typeof DOMAIN_FLAGS)[number];

interface CacheEntry {
  value: boolean;
  readAt: number;
}

@Injectable()
export class RuntimeFlagService {
  private readonly log = new Logger(RuntimeFlagService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Is this flag affirmatively enabled? Missing row, DB error, timeout, or any
   * ambiguity → false. Cached for {@link FLAG_CACHE_TTL_MS}.
   */
  async isEnabled(key: string): Promise<boolean> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.readAt < FLAG_CACHE_TTL_MS) return hit.value;

    let value = false;
    try {
      const row = await Promise.race([
        this.prisma.runtimeFlag.findUnique({ where: { key }, select: { enabled: true } }),
        new Promise<never>((_r, rej) =>
          setTimeout(() => rej(new Error('flag read timeout')), FLAG_READ_TIMEOUT_MS).unref(),
        ),
      ]);
      value = row?.enabled === true;
    } catch (e) {
      // Fail dark, loudly: the flip that *disables* must still win even when
      // the read path is broken, and an operator should see why it happened.
      this.log.warn(`flag read failed for "${key}" — treating as DISABLED: ${(e as Error).message}`);
      value = false;
    }
    this.cache.set(key, { value, readAt: Date.now() });
    return value;
  }

  /** Drop the cache (tests / an admin flip that must propagate immediately). */
  clearCache(): void {
    this.cache.clear();
  }
}
