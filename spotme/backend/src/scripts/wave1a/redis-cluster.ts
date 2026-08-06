/**
 * Wave 1A — Redis connection builders + cluster-topology diagnostic for the
 * Dragonfly queue remediation (R2). IN-NETWORK ONLY (REDIS_URL targets external
 * Dragonfly Cloud on a custom TLS port the agent's egress proxy can't reach).
 *
 * This file is DIAGNOSTIC/EVALUATION scaffolding — it does NOT change the
 * production `createRedisConnection`. It exists to gather the evidence R2
 * requires (does a cluster-aware client complete the BullMQ round-trip against
 * this Dragonfly, or is a single-shard endpoint the right answer?) before any
 * production connection change is committed.
 *
 * NEVER logs the URL, host, or credential — only aggregate topology metadata
 * (node counts, whether advertised addresses match the public endpoint).
 */

import IORedis, { type Cluster, type Redis, type RedisOptions } from 'ioredis';
import { BULLMQ_CONNECTION_OPTIONS, createRedisConnection } from '../../queue/redis.connection';

export type ConnMode = 'standalone' | 'cluster';

/** Parse REDIS_URL into its pieces WITHOUT ever exposing the credential. */
function parts(url = process.env.REDIS_URL): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls: boolean;
} | null {
  if (!url) return null;
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port || '6379'),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:',
  };
}

/**
 * Build a cluster-aware ioredis client from REDIS_URL. Dragonfly Cloud presents
 * a SINGLE public endpoint even in cluster mode; `CLUSTER SLOTS` may advertise
 * an internal host. `dnsLookup` pins every discovered node back to the public
 * endpoint so the client never dials an unreachable address — the standard
 * managed-single-endpoint pattern.
 */
export function createClusterConnection(extra: RedisOptions = {}): Cluster | null {
  const p = parts();
  if (!p) return null;
  const redisOptions: RedisOptions = {
    username: p.username,
    password: p.password,
    tls: p.tls ? { servername: p.host } : undefined,
    ...BULLMQ_CONNECTION_OPTIONS,
    ...extra,
  };
  return new IORedis.Cluster([{ host: p.host, port: p.port }], {
    redisOptions,
    // Pin discovered nodes to the reachable public endpoint (host only; the
    // advertised port is kept — Dragonfly single-endpoint returns its own port).
    dnsLookup: (_address, callback) => callback(null, p.host),
    enableReadyCheck: true,
    slotsRefreshTimeout: 10_000,
    clusterRetryStrategy: (times) => (times > 8 ? null : Math.min(times * 200, 2_000)),
  });
}

/** A factory usable by BullMQ (`{ connection: factory() }`) for the given mode. */
export function connectionFactory(mode: ConnMode): () => Redis | Cluster | null {
  return mode === 'cluster'
    ? () => createClusterConnection()
    : () => createRedisConnection();
}

export interface TopologyReport {
  reachable: boolean;
  redisMode: string | null;
  serverVersionLine: string | null;
  /** Number of shards/slot-ranges CLUSTER SLOTS advertised. */
  slotRanges: number | null;
  /** Distinct advertised node endpoints (host:port), redacted to a count + shape. */
  advertisedNodes: number | null;
  /** True when every advertised node host equals the public endpoint host. */
  advertisedMatchesEndpoint: boolean | null;
  notes: string[];
}

/**
 * Diagnostic: connect standalone, read INFO + CLUSTER SLOTS, and report the
 * advertised topology. This is the single most decisive piece of evidence for
 * R2 — it says whether a cluster client can bootstrap from the public endpoint
 * (advertised host == endpoint) or would need a natMap (advertised != endpoint).
 */
export async function probeTopology(): Promise<TopologyReport> {
  const notes: string[] = [];
  const rep: TopologyReport = {
    reachable: false,
    redisMode: null,
    serverVersionLine: null,
    slotRanges: null,
    advertisedNodes: null,
    advertisedMatchesEndpoint: null,
    notes,
  };
  const p = parts();
  if (!p) {
    notes.push('REDIS_URL absent — cannot probe.');
    return rep;
  }
  const conn = createRedisConnection();
  if (!conn) {
    notes.push('createRedisConnection returned null.');
    return rep;
  }
  conn.on('error', () => undefined);
  try {
    await conn.ping();
    rep.reachable = true;
    const info = await conn.info('server').catch(() => '');
    rep.redisMode = /redis_mode:(\S+)/.exec(info)?.[1] ?? null;
    rep.serverVersionLine =
      /redis_version:(\S+)/.exec(info)?.[1] ?? /df_version:(\S+)/.exec(info)?.[1] ?? null;

    // CLUSTER SLOTS → [ [startSlot, endSlot, [host, port, id], ...replicas], ... ]
    const slots = (await conn.cluster('SLOTS').catch(() => null)) as unknown as
      | Array<[number, number, ...Array<[string, number, ...unknown[]]>]>
      | null;
    if (Array.isArray(slots)) {
      rep.slotRanges = slots.length;
      const hosts = new Set<string>();
      for (const range of slots) {
        for (let i = 2; i < range.length; i++) {
          const node = range[i] as [string, number, ...unknown[]];
          if (Array.isArray(node) && typeof node[0] === 'string') hosts.add(node[0]);
        }
      }
      rep.advertisedNodes = hosts.size;
      // Do the advertised hosts match the public endpoint we connected to?
      rep.advertisedMatchesEndpoint =
        hosts.size > 0 && [...hosts].every((h) => h === p.host || h === '' || h === '127.0.0.1');
      notes.push(
        `CLUSTER SLOTS: ${rep.slotRanges} range(s), ${rep.advertisedNodes} distinct advertised host(s); ` +
          `advertised==publicEndpoint=${rep.advertisedMatchesEndpoint}.`,
      );
    } else {
      notes.push('CLUSTER SLOTS returned no array (runtime may not expose cluster topology).');
    }
  } catch (e) {
    notes.push(`topology probe error: ${(e as Error).message}`);
  } finally {
    await conn.quit().catch(() => undefined);
  }
  return rep;
}
