#!/usr/bin/env node
/**
 * Analytics artifact fence (ADR-031) — runs AFTER `vite build` in the test
 * chain. While analytics ships dark (flag false, no key, initAnalytics never
 * called live), the production bundle must contain NO PostHog: not the SDK,
 * not an ingestion host, not a project key. The seam itself (track/NOOP) may
 * be present — it is inert; the third party must not be.
 *
 *   node scripts/check-analytics-artifact.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const failures = [];

if (!existsSync(DIST)) {
  console.error('analytics artifact fence: dist/ missing — run vite build first (fence must not pass vacuously)');
  process.exit(1);
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|css|html)$/.test(entry)) out.push(full);
  }
  return out;
}

const FORBIDDEN = [
  [/posthog/i, 'PostHog SDK/host present in artifact while analytics ships dark'],
  [/phc_[A-Za-z0-9]{8,}/, 'PostHog project key literal in artifact'],
  [/i\.posthog\.com|us\.i\.posthog\.com|eu\.i\.posthog\.com/i, 'PostHog ingestion host in artifact'],
];

for (const f of walk(DIST)) {
  const rel = relative(ROOT, f);
  const body = readFileSync(f, 'utf8');
  for (const [re, msg] of FORBIDDEN) {
    if (re.test(body)) failures.push(`${rel}: ${msg}`);
  }
}

if (failures.length) {
  console.error('analytics artifact fence FAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('analytics artifact fence: PASS (no PostHog SDK, host, or key in dist)');
