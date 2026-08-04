/**
 * ADR-031 — dark fence for analytics. The seam is wired at live call sites
 * (that is the point — no-op while dark), but PostHog itself must be
 * unreachable: the flag is false in source, nothing live calls initAnalytics,
 * posthog-js is imported ONLY by the adapter file, and the adapter is
 * imported ONLY by init. scripts/check-analytics-artifact.mjs then proves the
 * built bundle carries no PostHog SDK/host/key.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?)$/.test(entry)) out.push(full);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const srcFiles = walk(join(ROOT, 'src')).map((f) => {
  const body = readFileSync(f, 'utf8');
  return { rel: relative(ROOT, f).replace(/\\/g, '/'), code: stripComments(body) };
});

describe('analytics dark fence', () => {
  it('the module exists and the seam is exercised by live call sites (not vacuous)', () => {
    expect(srcFiles.some((f) => f.rel === 'src/analytics/posthog.ts')).toBe(true);
    const app = srcFiles.find((f) => f.rel === 'src/App.tsx')!;
    expect(app.code).toContain("track({ type: 'screen_view', screen: 'discovery' })");
  });

  it('the compile-time flag is FALSE in source', () => {
    const flags = srcFiles.find((f) => f.rel === 'src/analytics/flags.ts')!;
    expect(flags.code).toMatch(/export\s+const\s+ANALYTICS_MASTER\s*=\s*false/);
  });

  it('NOTHING live calls initAnalytics — activation is a separate owner change', () => {
    const callers = srcFiles.filter(
      (f) => !f.rel.startsWith('src/analytics/') && /initAnalytics|from\s+['"][^'"]*analytics\/init/.test(f.code),
    );
    expect(callers.map((f) => f.rel)).toEqual([]);
  });

  it('posthog-js is imported ONLY by the adapter file', () => {
    const importers = srcFiles.filter((f) => /from\s+['"]posthog-js['"]|import\s*\(\s*['"]posthog-js/.test(f.code));
    expect(importers.map((f) => f.rel)).toEqual(['src/analytics/posthog.ts']);
  });

  it('the adapter is imported ONLY by init (dynamically) — never by a surface', () => {
    const importers = srcFiles.filter(
      (f) => f.rel !== 'src/analytics/posthog.ts' && /['"]\.?\.?\/?analytics\/posthog['"]|\.\/posthog['"]/.test(f.code),
    );
    expect(importers.map((f) => f.rel)).toEqual(['src/analytics/init.ts']);
  });

  it('no PostHog host or key literal anywhere outside the analytics config', () => {
    const offenders = srcFiles.filter(
      (f) => !f.rel.startsWith('src/analytics/') && /posthog|phc_[A-Za-z0-9]/i.test(f.code),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });

  it('call sites never reach for the SDK: surfaces import the seam, not the adapter', () => {
    const surfaceFiles = srcFiles.filter((f) => !f.rel.startsWith('src/analytics/'));
    for (const f of surfaceFiles) {
      expect(/from\s+['"]posthog-js['"]/.test(f.code) ? f.rel : '').toBe('');
    }
  });
});
