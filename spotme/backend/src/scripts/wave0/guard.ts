/**
 * Wave 0 — Activation Programme, infra connect & validate.
 *
 * THE DESIGNATED-TARGET GATE. This harness performs real (authorised)
 * mutations against staging infrastructure, so it refuses to run anywhere but
 * the one place the owner designated: Railway project `spotme-backend`,
 * environment `production` (the designated STAGING target — no user traffic
 * reaches it; the live app runs on the legacy deployment), service `api`.
 *
 * The gate keys off Railway's own non-secret identifiers (project/environment
 * IDs, service name). These are identifiers, not credentials — safe to embed
 * and to print. If any of them is absent or does not match, the harness throws
 * before touching anything.
 *
 * CREDENTIAL DISCIPLINE. Nothing in this harness ever prints a connection URL,
 * host, user, password, token, or presigned URL. Every result is aggregate
 * metadata: versions, booleans, counts, durations. `redactUrlMeta` is the only
 * sanctioned way to describe an endpoint, and it emits scheme/port/flags only.
 */

/** The one place this harness is allowed to run. Non-secret identifiers. */
export const DESIGNATED_TARGET = Object.freeze({
  projectId: 'b25e2c6e-5a0f-420c-841b-202249b78cd0',
  environmentId: 'dd56fc53-aba8-4a73-b2b4-131e1ec1079c',
  environmentName: 'production',
  serviceName: 'api',
});

export class NotDesignatedTargetError extends Error {}

/** Non-secret description of where the harness believes it is running. */
export interface TargetDescriptor {
  projectId: string | null;
  environmentId: string | null;
  environmentName: string | null;
  serviceName: string | null;
}

function readTarget(): TargetDescriptor {
  return {
    projectId: process.env.RAILWAY_PROJECT_ID ?? null,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? null,
    environmentName: process.env.RAILWAY_ENVIRONMENT_NAME ?? null,
    serviceName: process.env.RAILWAY_SERVICE_NAME ?? null,
  };
}

/**
 * Throw unless the current environment is the exact designated target. Returns
 * the (non-secret) descriptor on success so the caller can record it.
 */
export function assertDesignatedTarget(): TargetDescriptor {
  const t = readTarget();
  const mismatch: string[] = [];
  if (t.projectId !== DESIGNATED_TARGET.projectId) mismatch.push('RAILWAY_PROJECT_ID');
  if (t.environmentId !== DESIGNATED_TARGET.environmentId) mismatch.push('RAILWAY_ENVIRONMENT_ID');
  if (t.serviceName !== DESIGNATED_TARGET.serviceName) mismatch.push('RAILWAY_SERVICE_NAME');
  if (mismatch.length > 0) {
    throw new NotDesignatedTargetError(
      'Wave 0 harness refuses to run: this is not the designated target ' +
        `(spotme-backend / ${DESIGNATED_TARGET.environmentName} / ${DESIGNATED_TARGET.serviceName}). ` +
        `Non-matching identifiers: ${mismatch.join(', ')}.`,
    );
  }
  return t;
}

/** Describe a URL by NON-SECRET metadata only — never the host, user, or secret. */
export function redactUrlMeta(name: string): Record<string, unknown> {
  const raw = process.env[name];
  if (!raw) return { name, set: false };
  try {
    const u = new URL(raw);
    return {
      name,
      set: true,
      scheme: u.protocol.replace(':', ''),
      internal: /\.railway\.internal$|\.internal$/.test(u.hostname),
      port: u.port || '(default)',
      hostLen: u.hostname.length,
    };
  } catch {
    return { name, set: true, parse: 'non-URL' };
  }
}

/** Run an async step, capturing wall-clock ms and any error message (no values). */
export async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; value?: T; error?: string }> {
  const start = process.hrtime.bigint();
  try {
    const value = await fn();
    return { ms: msSince(start), value };
  } catch (e) {
    return { ms: msSince(start), error: (e as Error)?.message ?? String(e) };
  }
}

function msSince(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

/** p50/p95 over a sample of durations (ms), rounded to 2dp. */
export function percentiles(samples: number[]): { p50: number; p95: number; n: number } {
  if (samples.length === 0) return { p50: 0, p95: 0, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return { p50: round2(at(50)), p95: round2(at(95)), n: samples.length };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type LegStatus = 'PASS' | 'FAIL' | 'BLOCKED' | 'SKIPPED';

export interface LegResult {
  leg: string;
  status: LegStatus;
  detail: Record<string, unknown>;
  notes: string[];
}
