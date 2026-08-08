/**
 * Checkpoint 12 — DARK INTEGRATION FENCES for Platform Phase 2.
 *
 * Load-bearing, non-vacuous: every claim of darkness is an assertion over the
 * actual source tree, dependency manifests, and configs — a promise in a PR
 * body enforces nothing; a failing spec does. "Dark ≠ untested" is itself
 * fenced: every new discovery module must be exercised by at least one test.
 */

import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import {
  BACKEND, read, walk, inDir, requireNonEmpty, liveWebRoot, liveWebScanRoots, clientAllRoots, trackedDeployConfigs, liveVercelConfig, clientTestExists,
} from './helpers/fence-paths';

describe('C12 — dark integration fences', () => {
  // WAVE 1C, C3: the darkness MECHANISM changed. Discovery is now MOUNTED —
  // its darkness is enforced at RUNTIME by DomainGate('discovery',
  // { requireAdult: true }) over a RuntimeFlag that has zero rows in
  // production — not by non-import. These fences assert the new, stronger
  // invariant: the module mounts ONLY behind the gate, Queue/Observability
  // keep their own posture, and a mounted route is still 404 with no flag row
  // (proven at runtime in test/discovery-gate-runtime.spec.ts).
  it('AppModule still imports NEITHER QueueModule NOR ObservabilityModule; Discovery is mounted ONLY as DiscoveryModule', () => {
    const src = read(join(BACKEND, 'src/app.module.ts'));
    for (const banned of ['QueueModule', 'ObservabilityModule', './queue', './observability']) {
      expect(src).not.toContain(banned);
    }
    // Discovery is imported — but exactly once, as the module (not a deep
    // reach into internals), and the controller behind it carries the gate.
    expect(src).toContain('DiscoveryModule');
    const ctrl = read(join(BACKEND, 'src/discovery/discovery.controller.ts'));
    expect(ctrl).toMatch(/DomainGate\(\s*['"]discovery['"]\s*,\s*\{\s*requireAdult:\s*true/);
  });

  it('the ONLY route into the discovery subtree is DiscoveryModule → DomainGate; no other module reaches in (8.1)', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts'])
      .filter((f) => !inDir(f, 'discovery'))
      .filter((f) => !f.endsWith('app.module.ts')); // the one authorized mount
    // No OTHER file may reach into the discovery subtree (static or dynamic).
    const REACH = /(from|import|require)\s*\(?['"][^'"]*\/discovery(\/|['"])|['"][^'"]*\/discovery\/[^'"]*['"]/;
    expect(files.filter((f) => REACH.test(read(f)))).toEqual([]);
    // app.module reaches it ONLY via the module barrel, never internals.
    const app = read(join(BACKEND, 'src/app.module.ts'));
    expect(app).toContain("from './discovery/discovery.module'");
    expect(app).not.toMatch(/from '\.\/discovery\/(?!discovery\.module)/);
    // The boot path (main.ts) still must not reference discovery at all.
    expect(read(join(BACKEND, 'src/main.ts'))).not.toMatch(/discovery/i);
  });

  it('NO LIVE spotme/web MODULE (src OR api) imports Phase 2 code (8.2)', () => {
    // the live app api/ holds the Vercel serverless functions bridged into the
    // running backend — the most deploy-reachable web-tier code. Fence it too.
    const roots = liveWebScanRoots();
    const files = roots.flatMap((d) => walk(d, ['.js', '.mjs']));
    const offenders = files.filter((f) => /web-next|@spotme\/contracts|backend\/src\/discovery/.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it('no dark client surface is deployable: no COMMITTED vercel/now config reaches one (8.3)', () => {
    // TRACKED files only. This previously used existsSync, which fired on a
    // gitignored .vercel/project.json left by any local `vercel build` -- a
    // false red on a developer machine and absent in CI. Only a committed
    // config can reach a deployment, so only a committed config is a breach.
    expect(trackedDeployConfigs()).toEqual([]);
    // The one real config lives with the live app -- spotme/web today,
    // apps/web after ADR-035 -- and never targets a dark client surface in any
    // field Vercel actually deploys from.
    const v = read(liveVercelConfig());
    for (const dark of ['web-next', 'packages/ui', 'packages/core']) {
      expect(v).not.toContain(dark);
      for (const field of ['functions', 'builds', 'outputDirectory', 'rootDirectory']) {
        if (v.includes(field)) {
          const idx = v.indexOf(field);
          expect(v.slice(idx, idx + 200)).not.toContain(dark);
        }
      }
    }
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
    // .env.example must not pre-fill a Typesense endpoint — quoted OR unquoted
    // (the old quoted-only regex let `TYPESENSE_URL=http://…` through, F11.4).
    //
    // The character classes are [ \t], not \s: `\s` matches newlines, so
    // `\s*\S` after the `=` reached across the line break and matched the
    // FIRST NON-BLANK CHARACTER ANYWHERE LATER IN THE FILE. That made a bare,
    // genuinely-empty `TYPESENSE_URL=` fail — while the name was documented
    // for operators and the value left unset, which is exactly the state this
    // fence wants. The tightening it was written for (F11.4) is unchanged and
    // re-proved below: a value on the line still trips it.
    const envx = read(join(BACKEND, '.env.example'));
    expect(envx).not.toMatch(/^[ \t]*TYPESENSE_URL[ \t]*=[ \t]*\S/m);

    // The fence still bites — an endpoint on that line is caught, quoted or not.
    const TRIP = /^[ \t]*TYPESENSE_URL[ \t]*=[ \t]*\S/m;
    expect('TYPESENSE_URL=http://typesense:8108').toMatch(TRIP);
    expect('TYPESENSE_URL="http://typesense:8108"').toMatch(TRIP);
    expect('TYPESENSE_URL=\nTYPESENSE_API_KEY=""').not.toMatch(TRIP);
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
    const all = [...walk(join(BACKEND, 'src'), ['.ts']), ...requireNonEmpty(clientAllRoots().flatMap((d) => walk(d, ['.ts', '.tsx'])), 'client surface')];
    for (const f of all) {
      const s = read(f);
      expect(s).not.toMatch(/DISCOVERY[_A-Z]*ENABLED\s*=\s*true/);
      expect(s).not.toMatch(/discoveryEnabled\s*[:=]\s*true/);
    }
    const signing = read(join(liveWebRoot(), 'src/lib/crypto/signing-key-publication.js'));
    expect(signing).toContain('SIGNING_PUBLICATION_ENABLED = false');
    const webApp = walk(join(liveWebRoot(), 'src'), ['.js']).filter((f) => !inDir(f, 'crypto'));
    expect(webApp.filter((f) => /spotme\.e2e3/.test(read(f)))).toEqual([]);
  });

  it('no precise coordinate crosses the serialization boundary: the SERVICE projection never emits internal distance (F11.3)', () => {
    // The real protection is in the service projection, not the pass-through
    // controller — assert BOTH, and that the projected public shape carries
    // distanceBand, never coarseDistanceM.
    expect(read(join(BACKEND, 'src/discovery/discovery.controller.ts'))).not.toContain('coarseDistanceM');
    const service = read(join(BACKEND, 'src/discovery/discovery.service.ts'));
    const project = service.slice(service.indexOf('private project'));
    expect(project).toContain('distanceBand');
    expect(project).not.toContain('coarseDistanceM:'); // never assigned into the public shape
    // The client's ONLY brand-cast lives in coarsen.ts.
    const clientFiles = requireNonEmpty(clientAllRoots().flatMap((d) => walk(d, ['.ts', '.tsx'])), 'client surface').filter((f) => !f.endsWith('coarsen.ts'));
    const casters = clientFiles.filter((f) => /as CoarsePublicLocation/.test(read(f)));
    expect(casters).toEqual([]);
  });

  it('no secret-shaped literal exists in any Phase 2 source file', () => {
    const files = [
      ...walk(join(BACKEND, 'src/discovery'), ['.ts']),
      ...requireNonEmpty(clientAllRoots().flatMap((d) => walk(d, ['.ts', '.tsx'])), 'client surface'),
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
      'src/discovery/discovery.observability.ts': 'test/discovery-observability.spec.ts',
    };
    for (const [srcFile, testFile] of Object.entries(clusters)) {
      expect(existsSync(join(BACKEND, srcFile))).toBe(true);
      expect(existsSync(join(BACKEND, testFile))).toBe(true);
    }
    // web-next: controller + UI + mutation suites exist.
    for (const t of ['discovery-ui.test.tsx', 'discovery-controller.test.ts', 'discovery-privacy-mutation.test.ts']) {
      expect(clientTestExists(t)).toBe(true);
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
      if (inDir(f, 'discovery')) expect(s).not.toMatch(/centrifug/i);
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
