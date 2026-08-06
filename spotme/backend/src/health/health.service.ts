/**
 * Wave 0 — liveness and readiness.
 *
 * `liveness()` proves the process is up: no I/O, always cheap.
 *
 * `readiness()` runs BOUNDED, timeout-safe checks of the Wave-0 dependencies and
 * returns a minimal up/down verdict. It deliberately exposes NO config values,
 * infrastructure identifiers, dependency URLs, stack traces, or credential
 * presence — only whether each dependency answered. A stuck dependency can
 * never hang the probe: every check races a short timeout.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { createRedisConnection, isRedisConfigured } from '../queue/redis.connection';

const CHECK_TIMEOUT_MS = 1500;

export type CheckState = 'up' | 'down' | 'disabled';
export interface Readiness {
  status: 'ready' | 'not_ready';
  checks: { db: CheckState; redis: CheckState };
}

@Injectable()
export class HealthService implements OnModuleDestroy {
  private readonly log = new Logger(HealthService.name);
  private redis: Redis | null = null;
  private redisTried = false;

  constructor(private readonly prisma: PrismaService) {}

  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(): Promise<Readiness> {
    const [db, redis] = await Promise.all([this.checkDb(), this.checkRedis()]);
    const ready = db === 'up' && redis !== 'down';
    return { status: ready ? 'ready' : 'not_ready', checks: { db, redis } };
  }

  private async checkDb(): Promise<CheckState> {
    try {
      await withTimeout(this.prisma.$queryRaw`SELECT 1`, CHECK_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }

  private async checkRedis(): Promise<CheckState> {
    if (!isRedisConfigured()) return 'disabled';
    try {
      if (!this.redisTried) {
        this.redisTried = true;
        this.redis = createRedisConnection(undefined, { lazyConnect: true, maxRetriesPerRequest: 1 });
      }
      if (!this.redis) return 'disabled';
      const pong = await withTimeout(this.redis.ping(), CHECK_TIMEOUT_MS);
      return pong === 'PONG' ? 'up' : 'down';
    } catch {
      return 'down';
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis?.quit();
    } catch {
      /* closing a broken connection is best-effort */
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_res, rej) => setTimeout(() => rej(new Error('timeout')), ms).unref()),
  ]);
}
