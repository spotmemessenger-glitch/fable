#!/usr/bin/env node
/**
 * Import-boundary fence for @spotme/contracts.
 *
 * The package's whole value is that it depends on NOTHING: no browser globals,
 * no NestJS, no Prisma, no runtime dependency on spotme/apps/web, no generated API
 * clients, no runtime dependencies at all. A contracts package that quietly
 * grows a dependency stops being a contract and starts being an implementation.
 * This script fails the build the day that happens.
 *
 *   node scripts/check-boundaries.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];
const check = (name, pass, detail = '') => {
  checks.push([name, pass]);
  if (!pass) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** Strip block and line comments so prose ("An ISO-8601 window.") cannot trip
 *  code-level checks. Deliberately simple — good enough for a types package. */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const files = walk(join(ROOT, 'src')).map((f) => {
  const body = readFileSync(f, 'utf8');
  return { path: relative(ROOT, f), body, code: stripComments(body) };
});

// 1. Browser globals — a contracts package must be environment-neutral.
//    Checked against CODE (comments stripped), so documentation prose passes.
const BROWSER_GLOBALS = /\b(window|document|navigator|localStorage|sessionStorage|indexedDB|fetch)\s*[.(]/;
const browserHits = files.filter((f) => BROWSER_GLOBALS.test(f.code));
check('no browser globals in code', browserHits.length === 0, browserHits.map((f) => f.path).join(', '));

// Parse FULL import statements (multi-line included) from comment-stripped code.
const IMPORT_STMT = /import\s+(type\s+)?[\s\S]*?from\s+(['"])([^'"]+)\2/g;
const imports = files.flatMap((f) =>
  [...f.code.matchAll(IMPORT_STMT)].map((m) => ({
    path: f.path,
    typeOnly: Boolean(m[1]),
    specifier: m[3],
  })));

// 2. Framework/ORM imports — no NestJS, no Prisma, no generated clients.
const FORBIDDEN_SPECIFIER = /^(@nestjs|@prisma)|prisma\/client|openapi|swagger/i;
const importHits = imports.filter((i) => FORBIDDEN_SPECIFIER.test(i.specifier));
check('no NestJS / Prisma / generated-client imports', importHits.length === 0,
  importHits.map((i) => `${i.path} → ${i.specifier}`).join(', '));

// 3. No reaching into other Spot Me surfaces — contracts flow OUT, never in.
const CROSS_SURFACE = /(spotme\/web|\.\.\/\.\.\/web|\.\.\/\.\.\/backend|spotme-core)/;
const crossHits = imports.filter((i) => CROSS_SURFACE.test(i.specifier));
check('no imports from spotme/apps/web, spotme/backend, or spotme-core', crossHits.length === 0,
  crossHits.map((i) => `${i.path} → ${i.specifier}`).join(', '));

// 4. All imports are internal and type-only (types cannot smuggle runtime).
const badImports = imports.filter((i) => !i.typeOnly || !i.specifier.startsWith('./'));
check('every import is `import type` from a sibling module', badImports.length === 0,
  badImports.map((i) => `${i.path} → ${i.specifier}${i.typeOnly ? '' : ' (not type-only)'}`).join(' | '));

// 5. Zero runtime dependencies in the manifest.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
check('package.json declares zero runtime dependencies',
  !pkg.dependencies || Object.keys(pkg.dependencies).length === 0,
  JSON.stringify(pkg.dependencies ?? {}));

// 6. Not vacuous — the fence is checking real files.
check('fence is not vacuous (source files exist)', files.length >= 3, `${files.length} files`);

console.log('\n@spotme/contracts — import boundary fence');
for (const [name, pass] of checks) console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`  ${checks.filter(([, p]) => p).length}/${checks.length} passed\n`);
process.exit(failures.length === 0 ? 0 : 1);
