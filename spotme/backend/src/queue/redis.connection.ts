import IORedis, { type Redis, type RedisOptions } from 'ioredis';

/**
 * Redis-protocol connection for queues (and, later, cache + the Centrifugo
 * broker). The runtime is Dragonfly Cloud in production and Valkey in dev/CI;
 * both speak the Redis protocol, so the ONLY difference is the connection
 * string — supplied exclusively via `REDIS_URL` (env). The URL/key is never
 * hardcoded, logged, or echoed.
 *
 * When `REDIS_URL` is absent every dependent path degrades to DISABLED rather
 * than throwing — the app runs without a queue, it does not fail to boot.
 */

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on.
 * `connectTimeout` is explicit so an unreachable runtime fails in bounded time
 * instead of hanging a boot or a test run on the OS default.
 */
export const BULLMQ_CONNECTION_OPTIONS: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  connectTimeout: 10_000,
};

/** True when a Redis-protocol runtime is configured. */
export function isRedisConfigured(url = process.env.REDIS_URL): boolean {
  return typeof url === 'string' && url.length > 0;
}

/**
 * Create a Redis connection from `REDIS_URL`, or `null` when it is absent.
 * Callers treat `null` as "disabled". Never pass a literal URL here — let it
 * default to the environment so no connection string is ever written in code.
 */
export function createRedisConnection(
  url = process.env.REDIS_URL,
  extra: RedisOptions = {},
): Redis | null {
  if (!isRedisConfigured(url)) return null;
  return new IORedis(url as string, { ...BULLMQ_CONNECTION_OPTIONS, ...extra });
}
