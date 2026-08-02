import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationFlags } from '../notifications.config';
import { TransportRegistry } from '../transport/transport-registry';
import { OutboxService } from '../outbox/outbox.service';

/** One transport's reachability line. */
export interface TransportHealth {
  readonly name: string;
  readonly available: boolean;
}

export interface LivenessReport {
  readonly status: 'ok';
  readonly uptimeSeconds: number;
}

export interface ReadinessReport {
  readonly status: 'ok' | 'degraded';
  readonly enabled: boolean;
  /** Postgres reachable (the outbox's backing store). */
  readonly db: boolean;
  /** At least one transport can send right now. */
  readonly transportsReady: boolean;
  readonly transports: readonly TransportHealth[];
  /** Outbox row counts by status (present only when the DB is reachable). */
  readonly outbox?: Record<string, number>;
  /** A stuck-queue signal: rows queued past their attempt time (best effort). */
  readonly notes?: readonly string[];
}

/**
 * Liveness + readiness for the notification platform (design §13). LIVENESS is
 * "the process is up" — cheap, dependency-free. READINESS is "can we actually
 * deliver" — DB reachable AND at least one transport available — the signal a
 * load balancer or an operator uses before trusting the outbox drain.
 *
 * Every probe is failure-tolerant: a probe NEVER throws, it reports `false`, so
 * a health scrape can't take the endpoint down. Content-free by construction —
 * it reports counts and booleans, never a user or a payload.
 */
@Injectable()
export class NotificationHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: TransportRegistry,
    private readonly outbox: OutboxService,
    private readonly flags: NotificationFlags,
  ) {}

  liveness(): LivenessReport {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  async readiness(): Promise<ReadinessReport> {
    const transports: TransportHealth[] = this.registry
      .all()
      .map((t) => ({ name: t.name, available: t.available() }));
    const transportsReady = transports.some((t) => t.available);

    const db = await this.pingDb();
    let outbox: Record<string, number> | undefined;
    const notes: string[] = [];
    if (db) {
      try {
        outbox = await this.outbox.depthByStatus();
      } catch {
        notes.push('outbox-depth-unavailable');
      }
    }

    // Ready when the platform is enabled, the DB is reachable, and something can
    // send. When the platform is OFF, readiness is trivially "ok" (nothing to do).
    const status: 'ok' | 'degraded' =
      !this.flags.enabled || (db && transportsReady) ? 'ok' : 'degraded';

    return {
      status,
      enabled: this.flags.enabled,
      db,
      transportsReady,
      transports,
      outbox,
      notes: notes.length ? notes : undefined,
    };
  }

  private async pingDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}
