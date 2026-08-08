/**
 * Shared path resolution for the five dark-fence suites.
 *
 * Two problems this exists to solve, both of which made the fences weaker than
 * they looked.
 *
 * 1. THE FENCES WERE PINNED TO `spotme/web-next`. Every suite hardcoded that
 *    path and walked it. ADR-035 dissolves web-next into `packages/{ui,core}`
 *    and moves `spotme/web` to `apps/web`, which would have left the fences
 *    walking directories that no longer exist -- and a walk over a missing
 *    directory yields `[]`, so every `expect(offenders).toEqual([])` would
 *    have passed VACUOUSLY. The thing keeping Phase 2-6 dark would have gone
 *    green precisely because it had stopped looking. Resolution is now dynamic
 *    and `requireNonEmpty` makes an empty result a FAILURE, not a pass.
 *
 * 2. THEY COULD NOT RUN ON WINDOWS. Filters were written `f.includes('/events/')`
 *    against paths like `...\src\events\...`, so a domain's own files were
 *    never excluded from "no module OUTSIDE this domain reaches in" and then
 *    matched it trivially. Ten assertions failed on this machine for reasons
 *    that had nothing to do with darkness. A fence that is permanently red is
 *    a fence people learn to scroll past, and it cannot be tamper-checked --
 *    you cannot show a test fails when violated if it fails when it isn't.
 *    Everything here compares on POSIX-normalised paths.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const BACKEND = join(__dirname, '../..');
export const REPO = join(BACKEND, '../..');

/** POSIX-normalised, for every comparison in these suites. */
export const posix = (p: string) => p.replace(/\\/g, '/');

/** Separator-agnostic "is inside a directory named `seg`". */
export const inDir = (file: string, seg: string) => posix(file).includes(`/${seg}/`);

export const read = (p: string) => readFileSync(p, 'utf8');

export function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}

/**
 * A fence that finds nothing to check has not passed -- it has stopped
 * working. Every scan that should have subjects runs through this.
 */
export function requireNonEmpty<T>(items: T[], what: string): T[] {
  if (items.length === 0) {
    throw new Error(
      `FENCE VACUOUS: found nothing to check for "${what}". The layout moved ` +
        `or a path is wrong. Fix the resolver -- do not let this pass.`,
    );
  }
  return items;
}

/** First candidate that exists, or null. */
const firstExisting = (...cands: string[]) => cands.find((c) => existsSync(c)) ?? null;

/**
 * The LIVE web app root: `apps/web` after the ADR-035 move, `spotme/web`
 * before it. Throws if neither -- the live app always exists.
 */
export function liveWebRoot(): string {
  const r = firstExisting(join(REPO, 'spotme/apps/web'), join(REPO, 'spotme/web'));
  if (!r) throw new Error('FENCE BROKEN: no live web root (apps/web | spotme/web)');
  return r;
}

/** Live web source roots that ship to users: `src` plus the serverless `api`. */
export function liveWebScanRoots(): string[] {
  const w = liveWebRoot();
  return [join(w, 'src'), join(w, 'api')].filter((d) => existsSync(d));
}

/**
 * Client-side roots for one dark domain, wherever they live: `web-next/src/<d>`
 * today, `packages/ui/<d>` + `packages/core/<d>` after dissolution.
 *
 * Returns [] when the domain has no client surface at all, which is a legitimate
 * state -- callers that require subjects wrap this in `requireNonEmpty`.
 */
export function clientDomainRoots(domain: string): string[] {
  return [
    join(REPO, 'spotme/web-next/src', domain),
    join(REPO, 'spotme/packages/ui', domain),
    join(REPO, 'spotme/packages/core', domain),
  ].filter((d) => existsSync(d));
}

/** Every client-side root, across all surfaces. */
export const CLIENT_DOMAINS = ['discovery', 'exchange', 'events', 'moments', 'assistant'];

/**
 * Every client-side DOMAIN root. Deliberately the domain directories, not the
 * package root: after dissolution `packages/ui` also contains `test/`, and
 * scanning tests made the privacy fences fire on their own assertions (a test
 * that proves coordinates never escape necessarily mentions coordinates).
 */
export function clientAllRoots(): string[] {
  return CLIENT_DOMAINS.flatMap((d) => clientDomainRoots(d));
}

/**
 * Entry points that must not MOUNT a dark surface.
 *
 * Pre-move this is web-next's harness (`App.tsx`/`main.tsx`). Post-move those
 * are deleted (ADR-035 §(c)) and the entry that matters is the LIVE app's --
 * which is a strictly stronger fence, because it is the file that actually
 * ships. Throws if none resolve rather than returning [] and passing.
 */
export function appEntries(): string[] {
  const client = [
    join(REPO, 'spotme/web-next/src/App.tsx'),
    join(REPO, 'spotme/web-next/src/main.tsx'),
    join(REPO, 'spotme/packages/ui/src/App.tsx'),
    join(REPO, 'spotme/packages/ui/index.ts'),
  ].filter((p) => existsSync(p));
  if (client.length === 0) {
    // Post-dissolution there may be no React harness entry at all. The entry
    // that matters then is the LIVE app's -- but it is checked by
    // `liveEntryImportsDarkPackage`, NOT here, because the two ask different
    // questions and conflating them produces a false positive:
    // `apps/web/src/main.js` legitimately imports `./views/moments.js`, the
    // LEGACY Moments view shipped in PR #126. "MomentsShell is not mounted"
    // and "the word moments appears nowhere" are not the same claim.
    return [];
  }
  return client;
}

/**
 * THE REAL INVARIANT, replacing "no static reference to the dark surface".
 * That proxy blocked its own feature three times (a comment reword, an
 * apostrophe in prose, and finally an assembled specifier that dodged the
 * fence AND the bundler — leaving every surface unmountable in a browser).
 *
 * What must actually hold: every React client surface is reachable ONLY
 * through the island host's flag gate, and the gate defaults OFF.
 *
 *   1. Exactly one module under apps/web/src references '@spotme/ui': the
 *      island host (lib/island.js) — and only via dynamic import(), never
 *      a static `from`, so the surface stays out of the entry chunk.
 *   2. Inside the host, the `if (!uiFlag(slice)) return false` guard
 *      appears BEFORE the dynamic import — flag off means no request.
 *   3. uiFlag defaults OFF: only the literal localStorage value 'on'
 *      enables, and any storage throw reads as off.
 *
 * Returns human-readable violations; the suites assert it is empty.
 */
export function flagGateViolations(): string[] {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const violations: string[] = [];
  const srcRoot = join(liveWebRoot(), 'src');
  const HOST = posix(join(srcRoot, 'lib/island.js'));
  const importers = walk(srcRoot, ['.js', '.jsx', '.ts', '.tsx'])
    .filter((f) => /['"]@spotme\/ui['"]/.test(strip(read(f))));
  for (const f of importers) {
    if (posix(f) !== HOST) violations.push(`unexpected @spotme/ui reference outside the island host: ${posix(f)}`);
  }
  if (!importers.some((f) => posix(f) === HOST)) {
    violations.push('the island host no longer references @spotme/ui — fence would be vacuous');
    return violations;
  }
  const host = strip(read(join(srcRoot, 'lib/island.js')));
  if (/from\s+['"]@spotme\/ui['"]/.test(host)) violations.push('island host imports @spotme/ui STATICALLY — the surface would ship in the entry chunk');
  const guardAt = host.indexOf('if (!uiFlag(slice)) return false');
  const importAt = host.search(/import\(\s*['"]@spotme\/ui['"]\s*\)/);
  if (guardAt === -1) violations.push('the flag guard `if (!uiFlag(slice)) return false` is missing from the island host');
  if (importAt === -1) violations.push('the dynamic import("@spotme/ui") is missing from the island host');
  if (guardAt !== -1 && importAt !== -1 && guardAt > importAt) violations.push('the flag guard does not precede the dynamic import');
  const flat = host.replace(/\s+/g, ' ');
  if (!flat.includes("=== 'on'")) violations.push("uiFlag no longer requires the literal 'on' — default-off is not guaranteed");
  if (!/catch\s*\{\s*return false\s*\}/.test(flat)) violations.push('uiFlag no longer treats a storage throw as OFF');
  return violations;
}

/**
 * Does the LIVE app entry pull in a dark CLIENT PACKAGE surface?
 *
 * Matches on package specifier, never on a domain word — the legacy views are
 * a different implementation and several of them legitimately ship.
 */
export function liveEntryDarkPackageImports(): string[] {
  const entries = [join(liveWebRoot(), 'src/main.js'), join(liveWebRoot(), 'src/app.js')]
    .filter((p) => existsSync(p));
  if (entries.length === 0) throw new Error('FENCE BROKEN: no live app entry resolved');
  const DARK_PKG = /from\s+['"](@spotme\/(ui|core)|[^'"]*(web-next|packages\/(ui|core)))[^'"]*['"]/;
  return entries.filter((p) => DARK_PKG.test(read(p)));
}

/**
 * Deploy configs that could bring a dark surface online.
 *
 * TRACKED files only. The previous version used `existsSync`, which fired on a
 * gitignored `.vercel/project.json` left behind by a local `vercel build` --
 * a false positive on any developer machine that had ever run one, and absent
 * in CI. What the fence actually cares about is a config that could reach a
 * deployment, and that means one committed to the repository.
 */
export function trackedDeployConfigs(): string[] {
  const candidates = [
    'vercel.json',
    'spotme/vercel.json',
    'now.json',
    'spotme/now.json',
    '.vercel/project.json',
    'spotme/.vercel/project.json',
    'spotme/web-next/vercel.json',
    'spotme/packages/ui/vercel.json',
    'apps/web-next/vercel.json',
  ];
  let tracked: Set<string>;
  try {
    const out = execFileSync('git', ['ls-files', '--', ...candidates], {
      cwd: REPO,
      encoding: 'utf8',
    });
    tracked = new Set(out.split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    // No git (a tarball checkout): fall back to existence, which is stricter.
    return candidates.filter((p) => existsSync(join(REPO, p)));
  }
  return candidates.filter((p) => tracked.has(p));
}

/**
 * Does a client-side test of this name exist, wherever client tests live?
 * `web-next/test/` today; `packages/{ui,core}/test/` after dissolution.
 * Used by the "dark != untested" fences.
 */
export function clientTestExists(name: string): boolean {
  return [
    join(REPO, 'spotme/web-next/test', name),
    join(REPO, 'spotme/packages/ui/test', name),
    join(REPO, 'spotme/packages/core/test', name),
  ].some((p) => existsSync(p));
}

/** Client package manifests, wherever the client packages currently live. */
export function clientManifests(): string[] {
  return [
    join(REPO, 'spotme/web-next/package.json'),
    join(REPO, 'spotme/packages/ui/package.json'),
    join(REPO, 'spotme/packages/core/package.json'),
  ].filter((p) => existsSync(p));
}

/**
 * Built client artifacts, when a build has been run. Returns [] when nothing
 * has been built -- callers must treat that as "skip", never as "clean",
 * and say so out loud.
 */
export function builtArtifactDirs(): string[] {
  return [
    join(REPO, 'spotme/web-next/dist/assets'),
    join(REPO, 'spotme/packages/ui/dist'),
    join(liveWebRoot(), 'dist/assets'),
  ].filter((d) => existsSync(d));
}

/** The one real deploy config, wherever the web app currently lives. */
export function liveVercelConfig(): string {
  const p = join(liveWebRoot(), 'vercel.json');
  if (!existsSync(p)) throw new Error('FENCE BROKEN: live vercel.json not found');
  return p;
}
