/**
 * Sentry error tracking — no-op unless configured.
 *
 * Initializes only when `SENTRY_DSN` is set AND `@sentry/node` is installed
 * (an OPTIONAL dependency, loaded lazily). Without the DSN it never touches
 * Sentry; with the DSN but no package it logs once and stays disabled rather
 * than crashing the boot. The DSN is never logged.
 */
import { optionalImport } from './optional-import';

export type SentryStatus = 'disabled' | 'initialized' | 'unavailable';

interface SentryLike {
  init(opts: { dsn: string; tracesSampleRate: number; environment?: string }): void;
}

export async function initSentry(): Promise<SentryStatus> {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return 'disabled'; // no-op without config

  const mod = await optionalImport<SentryLike>('@sentry/node');
  if (!mod || typeof mod.init !== 'function') return 'unavailable';

  mod.init({
    dsn,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    environment: process.env.NODE_ENV,
  });
  return 'initialized';
}
