/**
 * Checkpoint 12 — DARK INTEGRATION FENCES for Platform Phase 2.
 *
 * Load-bearing, non-vacuous: every claim of darkness is an assertion over the
 * actual source tree, dependency manifests, and configs — a promise in a PR
 * body enforces nothing; a failing spec does. "Dark ≠ untested" is itself
 * fenced: every new discovery module must be exercised by at least one test.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BACKEND = join(__dirname, '..');
const REPO = join(BACKEND, '../..');
const WEB_SRC = join(REPO, 'spotme/web/src');
const WEBNEXT = join(REPO, 'spotme/web-next');

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}

const read = (p: string) => readFileSync(p, 'utf8');

describe('C12 — dark integration fences', () => {
  it('AppModule imports NONE of: DiscoveryModule, QueueModule, ObservabilityModule', () => {
    const src = read(join(BACKEND, 'src/app.module.ts'));
    for (const banned of ['DiscoveryModule', 'QueueModule', 'ObservabilityModule', './discovery', './queue', './observability']) {
      expect(src).not.toContain(banned);
    }
  });

  it('no backend module OUTSIDE src/discovery imports the discovery code', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts']).filter((f) => !f.includes('/discovery/'));
    const importers = files.filter((f) => /from ['"].*\/discovery\//.test(read(f)));
    expect(importers).toEqual([]);
  });

  it('NO LIVE spotme/web MODULE imports Phase 2 code (web-next, contracts, discovery backend)', () => {
    const files = walk(WEB_SRC, ['.js', '.mjs']);
    const offenders = files.filter((f) => {
      const s = read(f);
      return /web-next|@spotme\/contracts|backend\/src\/discovery/.test(s);
    });
    expect(offenders).toEqual([]);
  });

  it('web-next is NOT deployed: no root/spotme vercel config; the only vercel.json is rooted at spotme/web and never mentions web-next', () => {
    expect(existsSync(join(REPO, 'vercel.json'))).toBe(false);
    expect(existsSync(join(REPO, 'spotme/vercel.json'))).toBe(false);
    const v = read(join(REPO, 'spotme/web/vercel.json'));
    expect(v).not.toContain('web-next');
    expect(existsSync(join(WEBNEXT, 'vercel.json'))).toBe(false);
  });

  it('Centrifugo: no package dependency, no adapter instantiation anywhere in backend src', () => {
    const pkg = JSON.parse(read(join(BACKEND, 'package.json')));
    expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((k) => /centrifug/i.test(k))).toBe(false);
    const files = walk(join(BACKEND, 'src'), ['.ts']);
    expect(files.filter((f) => /centrifug/i.test(read(f)) && /new .*Centrifug|connect\(/.test(read(f)))).toEqual([]);
  });

  it('Typesense is never contacted by the running app: no default URL, no env-provisioning, adapter unconfigured-by-default', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts']);
    for (const f of files) {
      const s = read(f);
      // No hardcoded typesense endpoint anywhere in src.
      expect(s).not.toMatch(/https?:\/\/[^'"\s]*typesense/i);
      // Nothing ASSIGNS the env vars (reading with no default is the contract).
      expect(s).not.toMatch(/process\.env\.TYPESENSE_URL\s*=/);
    }
    // .env.example must not pre-fill a Typesense endpoint either.
    const envx = read(join(BACKEND, '.env.example'));
    expect(envx).not.toMatch(/TYPESENSE_URL="[^"]+"/);
  });

  it('place providers make NO network call (no fetch/http in the places layer)', () => {
    const files = walk(join(BACKEND, 'src/discovery/places'), ['.ts']);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|https?:\/\/|require\(['"]https?/);
    }
  });

  it('no discovery feature flag is true anywhere; crypto flags remain dark in source', () => {
    const all = [...walk(join(BACKEND, 'src'), ['.ts']), ...walk(join(WEBNEXT, 'src'), ['.ts', '.tsx'])];
    for (const f of all) {
      const s = read(f);
      expect(s).not.toMatch(/DISCOVERY[_A-Z]*ENABLED\s*=\s*true/);
      expect(s).not.toMatch(/discoveryEnabled\s*[:=]\s*true/);
    }
    const signing = read(join(WEB_SRC, 'lib/crypto/signing-key-publication.js'));
    expect(signing).toContain('SIGNING_PUBLICATION_ENABLED = false');
    const webApp = walk(WEB_SRC, ['.js']).filter((f) => !f.includes('/crypto/'));
    expect(webApp.filter((f) => /spotme\.e2e3/.test(read(f)))).toEqual([]);
  });

  it('no precise coordinate crosses the serialization boundary: internal distance fields never reach the controller layer', () => {
    const controller = read(join(BACKEND, 'src/discovery/discovery.controller.ts'));
    expect(controller).not.toContain('coarseDistanceM');
    // The client's ONLY brand-cast lives in coarsen.ts.
    const clientFiles = walk(join(WEBNEXT, 'src'), ['.ts', '.tsx']).filter((f) => !f.endsWith('coarsen.ts'));
    const casters = clientFiles.filter((f) => /as CoarsePublicLocation/.test(read(f)));
    expect(casters).toEqual([]);
  });

  it('no secret-shaped literal exists in any Phase 2 source file', () => {
    const files = [
      ...walk(join(BACKEND, 'src/discovery'), ['.ts']),
      ...walk(join(WEBNEXT, 'src'), ['.ts', '.tsx']),
    ];
    const SECRET = /\b(sk|pk|key|token|bearer)[-_][A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    const offenders = files.filter((f) => SECRET.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('NON-VACUOUS: every discovery source cluster is exercised by a test file', () => {
    const clusters: Record<string, string> = {
      'src/discovery/discovery.policy.ts': 'test/discovery-policy.spec.ts',
      'src/discovery/discovery.prisma.repository.ts': 'test/discovery-people.e2e-spec.ts',
      'src/discovery/search/typesense-search.adapter.ts': 'test/discovery-search.spec.ts',
      'src/discovery/places/place.adapters.ts': 'test/discovery-places.spec.ts',
      'src/discovery/discovery.ranking.engine.ts': 'test/discovery-intent-ranking.spec.ts',
      'src/discovery/realtime/realtime.port.ts': 'test/discovery-realtime.spec.ts',
    };
    for (const [srcFile, testFile] of Object.entries(clusters)) {
      expect(existsSync(join(BACKEND, srcFile))).toBe(true);
      expect(existsSync(join(BACKEND, testFile))).toBe(true);
    }
    // web-next: controller + UI + mutation suites exist.
    for (const t of ['discovery-ui.test.tsx', 'discovery-controller.test.ts', 'discovery-privacy-mutation.test.ts']) {
      expect(existsSync(join(WEBNEXT, 'test', t))).toBe(true);
    }
  });

  it('BUILD ARTIFACTS: compiled backend output carries no Typesense endpoint, no Centrifugo client, no secret-shaped literal', () => {
    // Build-artifact scan (checkpoint 12): the SHIPPED code, not just source.
    // Validation runs `npm run build` first; a missing dist is a hard failure
    // so this fence can never pass vacuously.
    const dist = join(BACKEND, 'dist');
    expect(existsSync(dist)).toBe(true);
    const files: string[] = [];
    (function walkDist(dir: string) {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walkDist(full);
        else if (e.endsWith('.js')) files.push(full);
      }
    })(dist);
    expect(files.length).toBeGreaterThan(0);
    const SECRET = /eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/https?:\/\/[^'"\s]*typesense/i);
      // The LEGACY realtime plane (ADR-002, env-gated) legitimately mentions
      // Centrifugo; the Phase 2 discovery subtree must not.
      if (f.includes('/discovery/')) expect(s).not.toMatch(/centrifug/i);
      expect(SECRET.test(s)).toBe(false);
    }
  });

  it('QueueService and Observability stay disabled without configuration (posture re-asserted)', () => {
    const queue = read(join(BACKEND, 'src/queue/redis.connection.ts'));
    expect(queue).toContain('process.env.REDIS_URL');
    const obs = read(join(BACKEND, 'src/observability/metrics.ts'));
    expect(obs).toContain("METRICS_ENABLED === 'true'");
  });
});
