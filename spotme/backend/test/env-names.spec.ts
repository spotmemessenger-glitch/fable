/**
 * ENV-NAME FENCE — `.env.example` and the code must agree, in both directions.
 *
 * WHY THIS EXISTS. `.env.example` documented `FCM_SERVICE_ACCOUNT_JSON` while
 * `push.service.ts` read `FIREBASE_SERVICE_ACCOUNT`. Each name appeared in
 * exactly one file and they never met, so provisioning push from the example
 * file set a variable with no consumer and produced a dead FCM leg with no
 * warning — `initFirebase()` returns before its try/catch when the value is
 * absent. Nothing could catch that, because nothing compared the two lists.
 *
 * Both directions are failures, and for different reasons:
 *
 *   documented but never read  → someone will set it and expect an effect.
 *                                That is how the FCM bug shipped.
 *   read but never documented  → someone will deploy without it and get a
 *                                silently degraded service. Worse when the
 *                                name is a signing secret.
 *
 * ESCAPE HATCHES ARE DELIBERATELY EXPENSIVE. A name may sit out either check
 * only by being listed below WITH A REASON, and a stale entry is itself a
 * failure — if an allow-listed name starts (or stops) being read, the fence
 * trips and the reason has to be rewritten or removed. An allow-list that
 * silently rots is just a longer way of not having a fence.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND = join(__dirname, '..');
const ENV_EXAMPLE = join(BACKEND, '.env.example');
const SRC = join(BACKEND, 'src');

/**
 * Documented in `.env.example` but never read via `process.env` in `src/`.
 * Every entry names its real consumer, or says plainly that it has none.
 */
const DOCUMENTED_NOT_READ: Record<string, string> = {
  DATABASE_URL:
    'read by Prisma itself from schema.prisma env("DATABASE_URL"), never through process.env',
  R2_ACCOUNT_ID: 'consumed by .github/workflows/r2-smoke.yml, not by the server',
  R2_ACCESS_KEY_ID: 'consumed by .github/workflows/r2-smoke.yml, not by the server',
  R2_SECRET_ACCESS_KEY: 'consumed by .github/workflows/r2-smoke.yml, not by the server',
  R2_BUCKET: 'consumed by .github/workflows/r2-smoke.yml, not by the server',
  APNS_KEY_ID: 'RESERVED — APNs is not implemented; no consumer exists yet',
  APNS_TEAM_ID: 'RESERVED — APNs is not implemented; no consumer exists yet',
  AGE_VERIFY_PROVIDER: 'RESERVED — the age-verification vendor seam is unbuilt',
  AGE_VERIFY_API_KEY: 'RESERVED — the age-verification vendor seam is unbuilt',
  OTP_FROM_EMAIL:
    'RESERVED — OTP email delivery is unwired; auth.controller.ts names it in a TODO only',
  RESEND_API_KEY:
    'RESERVED — OTP email delivery is unwired; auth.controller.ts names it in a TODO only',
  JWT_REFRESH_SECRET:
    'OBSOLETE — refresh tokens are opaque random strings, hashed and stored (auth.service refresh() matches on tokenHash); nothing JWT-signs them',
  JWT_REFRESH_TTL:
    'OBSOLETE — refresh-token lifetime comes from the stored row expiresAt, not this variable',
};

/**
 * Read in `src/` but deliberately absent from `.env.example`: values the
 * platform injects, which an operator neither sets nor should copy.
 */
const READ_NOT_DOCUMENTED: Record<string, string> = {
  RAILWAY_ENVIRONMENT_ID: 'injected by Railway at runtime; not operator-set',
  RAILWAY_ENVIRONMENT_NAME: 'injected by Railway at runtime; not operator-set',
  RAILWAY_PROJECT_ID: 'injected by Railway at runtime; not operator-set',
  RAILWAY_SERVICE_NAME: 'injected by Railway at runtime; not operator-set',
};

/* ------------------------------------------------------------------ */

/** Names assigned in `.env.example`, ignoring comments and blank lines. */
function documentedNames(): string[] {
  return [
    ...new Set(
      readFileSync(ENV_EXAMPLE, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .map((line) => /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1])
        .filter((n): n is string => Boolean(n)),
    ),
  ].sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Names read through `process.env` anywhere in `src/`.
 *
 * Comments are deliberately NOT stripped. The obvious implementation — strip
 * `/*...*\/` then `//...` — silently loses real reads: a `/*` inside a string
 * literal pairs with a later `*\/` and swallows everything between, which is
 * exactly how `WEB_API_DIR` (main.ts:39) disappeared from this scan while
 * being genuinely read. A fence that under-reports reads is worse than no
 * fence, because the missing name passes the "everything read is documented"
 * check while being undocumented in production.
 *
 * Over-reporting is the safe direction and costs nothing: `process.env.X`
 * almost never appears in prose, and if someone comments out a read, the name
 * is still one an operator may reasonably set — so documenting it is correct.
 */
function readNames(): string[] {
  const found = new Set<string>();
  // process.env.NAME  |  process.env['NAME']  |  process.env["NAME"]
  const RE = /process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\]/g;
  for (const file of walk(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(RE)) {
      found.add((m[1] ?? m[2]) as string);
    }
  }
  return [...found].sort();
}

describe('env-name fence — .env.example and src/ agree', () => {
  const documented = documentedNames();
  const read = readNames();

  it('is not vacuous: both lists are substantial', () => {
    expect(documented.length).toBeGreaterThan(10);
    expect(read.length).toBeGreaterThan(10);
  });

  it('every DOCUMENTED name is read somewhere in src/ (no variable with no consumer)', () => {
    const orphans = documented.filter((n) => !read.includes(n) && !(n in DOCUMENTED_NOT_READ));
    expect(orphans).toEqual([]);
  });

  it('every name READ in src/ is documented in .env.example (no undocumented config)', () => {
    const undocumented = read.filter((n) => !documented.includes(n) && !(n in READ_NOT_DOCUMENTED));
    expect(undocumented).toEqual([]);
  });

  it('the DOCUMENTED_NOT_READ allow-list is not stale', () => {
    // Entry now actually read → the reason is wrong, delete the entry.
    const nowRead = Object.keys(DOCUMENTED_NOT_READ).filter((n) => read.includes(n));
    expect(nowRead).toEqual([]);
    // Entry no longer documented → the exemption is dead weight, delete it.
    const notDocumented = Object.keys(DOCUMENTED_NOT_READ).filter((n) => !documented.includes(n));
    expect(notDocumented).toEqual([]);
  });

  it('the READ_NOT_DOCUMENTED allow-list is not stale', () => {
    const nowDocumented = Object.keys(READ_NOT_DOCUMENTED).filter((n) => documented.includes(n));
    expect(nowDocumented).toEqual([]);
    const notRead = Object.keys(READ_NOT_DOCUMENTED).filter((n) => !read.includes(n));
    expect(notRead).toEqual([]);
  });

  it('every exemption carries a non-trivial reason', () => {
    for (const [name, reason] of [
      ...Object.entries(DOCUMENTED_NOT_READ),
      ...Object.entries(READ_NOT_DOCUMENTED),
    ]) {
      expect(`${name}: ${reason}`.length).toBeGreaterThan(name.length + 20);
    }
  });

  it('.env.example carries no value that looks like a real credential', () => {
    /* Shape-matched, not length-matched: a placeholder connection string is
     * long and harmless, so `postgresql://user:password@host/...` must pass
     * while a pasted secret must not. The embedded-credentials pattern below
     * deliberately excludes the literal `password`. */
    const CREDENTIAL_SHAPES: Array<[RegExp, string]> = [
      [/eyJ[A-Za-z0-9_-]{20,}/, 'JWT'],
      [/AIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
      [/sk_(live|test)_[0-9A-Za-z]{16,}/, 'vendor secret key'],
      [/phc_[0-9A-Za-z]{20,}/, 'PostHog project key'],
      [/0x4[A-Za-z0-9_-]{20,}/, 'Turnstile key'],
      [/^[A-Za-z0-9+/]{40,}={0,2}$/, 'base64 blob'],
      [/^[0-9a-f]{32,}$/i, 'hex secret'],
      [/:\/\/[^\s:@/]+:(?!password\b)[^\s:@/]+@/, 'URL with embedded credentials'],
    ];
    const offenders: string[] = [];
    for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split('\n')) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!m) continue;
      const value = m[2].replace(/^["']|["'].*$/g, '').trim();
      if (!value) continue;
      for (const [re, label] of CREDENTIAL_SHAPES) {
        if (re.test(value)) offenders.push(`${m[1]} (${label})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
