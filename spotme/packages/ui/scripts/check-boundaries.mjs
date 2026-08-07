#!/usr/bin/env node
/**
 * Isolation fence for the @spotme/ui client surfaces.
 *
 * The beachhead's whole safety story is what it does NOT do: it never imports
 * the legacy app, never talks to a backend, never authenticates, never routes.
 * A strangler surface that quietly grows a dependency on the thing it is meant
 * to strangle — or starts making network calls before its own review — defeats
 * the pattern. This script fails the build the day that happens.
 *
 *   node scripts/check-boundaries.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push([name, pass]);
  if (!pass) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(entry)) out.push(full);
  }
  return out;
}

const DOMAINS = ['discovery', 'exchange', 'events', 'moments', 'assistant',
  'contacts', 'notifications', 'stories', 'chat'];
const roots = DOMAINS.map((d) => join(ROOT, d)).filter((d) => existsSync(d));
if (roots.length === 0) {
  console.error('FENCE VACUOUS: no domain surfaces found under packages/ui. Fix the resolver.');
  process.exit(1);
}
const files = roots.flatMap((r) => walk(r)).map((f) => {
  const body = readFileSync(f, 'utf8');
  return { path: relative(ROOT, f), body, code: stripComments(body) };
});

// 1. No imports from the legacy app (or anything under spotme/apps/web) or the
//    backend. Intra-package sibling reuse (e.g. exchange → ../discovery) is
//    allowed by rule 5; escaping the package toward the app/backend is not.
const LEGACY = /from\s+['"][^'"]*(\.\.\/web\/|spotme\/web\/|vendor\/spotme-core|spotme-core|\/backend\/|spotme\/backend)/;
const legacyHits = files.filter((f) => LEGACY.test(f.code));
check('no imports from legacy spotme/apps/web or spotme-core', legacyHits.length === 0,
  legacyHits.map((f) => f.path).join(', '));

// 2. No backend calls / network — fetch, XHR, WebSocket, socket.io, axios.
const NETWORK = /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|from\s+['"](socket\.io|axios|@?trystero)/;
const netHits = files.filter((f) => NETWORK.test(f.code));
check('no backend calls or network primitives', netHits.length === 0,
  netHits.map((f) => f.path).join(', '));

// 3. No routing integration — no router libs, no hash/history wiring.
const ROUTING = /from\s+['"][^'"]*react-router|\bhistory\.pushState\b|\blocation\.hash\b/;
const routeHits = files.filter((f) => ROUTING.test(f.code));
check('no routing integration', routeHits.length === 0, routeHits.map((f) => f.path).join(', '));

// 4. No authentication — no tokens, credentials, or storage of them.
const AUTH = /\b(localStorage|sessionStorage|document\.cookie|jwt|bearer|refreshToken|accessToken)\b/i;
const authHits = files.filter((f) => AUTH.test(f.code));
check('no authentication or credential storage', authHits.length === 0,
  authHits.map((f) => f.path).join(', '));

// 5. Only the shared contracts package (type-only) and react/* may be imported.
const IMPORT_STMT = /import\s+(type\s+)?[\s\S]*?from\s+(['"])([^'"]+)\2/g;
const imports = files.flatMap((f) =>
  [...f.code.matchAll(IMPORT_STMT)].map((m) => ({ path: f.path, typeOnly: Boolean(m[1]), spec: m[3] })));
const allowed = (i) =>
  i.spec.startsWith('react') || i.spec.startsWith('./') ||
  // Intra-package sibling reuse (exchange ↔ discovery). Escapes toward
  // web/backend are still blocked by rule 1 (LEGACY).
  i.spec.startsWith('../') ||
  (i.spec === '@spotme/contracts' && i.typeOnly);
const badImports = imports.filter((i) => !allowed(i));
check('imports limited to react/*, siblings, and type-only @spotme/contracts',
  badImports.length === 0, badImports.map((i) => `${i.path} → ${i.spec}`).join(' | '));

// 6. Not vacuous.
check('fence is not vacuous (source files exist)', files.length >= 2, `${files.length} files`);

console.log('\n@spotme/ui — isolation fence');
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`  ${checks.filter(([, p]) => p).length}/${checks.length} passed\n`);
process.exit(failures.length === 0 ? 0 : 1);
