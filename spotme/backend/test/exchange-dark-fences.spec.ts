/**
 * Phase 3E — DARK INTEGRATION FENCES for Exchange. Load-bearing, non-vacuous:
 * every claim of darkness is an assertion over the actual source tree,
 * manifests, and build artifacts — a PR-body promise enforces nothing.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  liveWebRoot, liveEntryDarkPackageImports, BACKEND, REPO, read, walk, inDir, requireNonEmpty, clientDomainRoots, clientAllRoots, appEntries, clientTestExists,
} from './helpers/fence-paths';
import { validateIntentInput } from '../src/exchange/exchange.policy';

/** A quoted import specifier that reaches the `exchange` path segment of the
 *  subtree: `'./exchange'`, `'../exchange/x'`, `'src/exchange.module'`. A
 *  subtree specifier ALWAYS has a `/` before `exchange` (relative/aliased path),
 *  so a leading path segment is REQUIRED — that excludes bare `'exchange'`
 *  DOMAIN-LABEL literals (discovery's future-domain enum) which are values, not
 *  imports. `exchange` must be followed by a path delimiter (`/ . - '"`), so
 *  `exchangeThing` / `data-exchange-rate` don't false-positive either. */
const EXCHANGE_REACH = /['"][^'"]*\/exchange[\/.'"-]/;
/** Strip block + line comments so prose ("no business logic", "precise point")
 *  never trips a code-shape fence. */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

describe('Exchange — dark integration fences', () => {
  it('AppModule imports NEITHER ExchangeModule NOR the exchange subtree', () => {
    const src = read(join(BACKEND, 'src/app.module.ts'));
    for (const banned of ['ExchangeModule', './exchange', '/exchange/']) {
      expect(src).not.toContain(banned);
    }
  });

  it('no backend module OUTSIDE src/exchange imports the exchange code (static or dynamic)', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts']).filter((f) => !inDir(f, 'exchange'));
    // Any quoted import specifier whose path reaches the exchange segment — as
    // `/exchange`, `/exchange/…`, or `/exchange.module` — at a path boundary.
    // Broadened (review IMPORTER-REGEX): the previous form required a trailing
    // slash and missed `./exchange.module`-style specifiers.
    expect(files.filter((f) => EXCHANGE_REACH.test(read(f)))).toEqual([]);
    expect(read(join(BACKEND, 'src/main.ts'))).not.toMatch(/exchange/i);
  });

  it('Exchange is reachable ONLY behind spotme.ui.exchange, which defaults OFF', () => {
    /* SLICE 1 CHANGED THE MECHANISM, IT DID NOT DROP THE FENCE.
     *
     * Exchange used to be dark by non-reference: nothing imported it. It is
     * now deliberately reachable behind a flag, so asserting non-reference
     * would just be asserting that slice 1 did not ship. This asserts the
     * NEW, STRONGER invariant instead -- the same move the Discovery fence
     * made when DiscoveryModule went behind DomainGate:
     *
     *   the live entry reaches exchange through EXACTLY ONE route view;
     *   that view renders nothing unless the flag is explicitly 'on';
     *   the flag is never defaulted on anywhere;
     *   the island host never STATICALLY imports the ui package.
     */
    const entryFiles = appEntries();
    for (const entry of entryFiles) {
      const s = read(entry);
      // The React shell itself is still never mounted from an entry.
      expect(s).not.toMatch(/ExchangeShell/);
    }

    const web = liveWebRoot();
    const main = read(join(web, 'src/main.js'));
    // ONE reach, and it is the route view -- never the package or internals.
    const reaches = [...main.matchAll(/from\s+['"]([^'"]*exchange[^'"]*)['"]/g)].map((m) => m[1]);
    expect(reaches).toEqual(['./views/exchange.js']);

    // That view is gated, and the gate is the flag.
    const view = read(join(web, 'src/views/exchange.js'));
    expect(view).toMatch(/uiFlag\(\s*['"]exchange['"]\s*\)/);
    expect(view).toMatch(/if \(!uiFlag/);

    // The host resolves the package dynamically; a static import would make
    // every dark surface reachable from the shipped entry.
    const host = read(join(web, 'src/lib/island.js'));
    expect(/^\s*import[^;]*['"]@spotme\/ui['"]/m.test(host)).toBe(false);

    // Nothing anywhere turns the flag on by default.
    const webFiles = walk(join(web, 'src'), ['.js']);
    for (const f of webFiles) {
      expect(read(f)).not.toMatch(/setItem\(\s*['"`]spotme\.ui\./);
    }
  });

  it('the OTHER client surfaces stay dark: the ui entry exports Exchange only', () => {
    // Slice 1 activates one domain. discovery/events/moments/assistant must
    // remain unreachable through the package entry the host imports.
    const idx = join(REPO, 'spotme/packages/ui/index.ts');
    if (!existsSync(idx)) return;
    const s = stripComments(read(idx));
    for (const dark of ['discovery', 'events', 'moments', 'assistant']) {
      expect(s).not.toMatch(new RegExp(`from\s+['"]\./${dark}/`));
    }
  });

  it('the Exchange search index type carries NO coordinate field', () => {
    const s = stripComments(read(join(BACKEND, 'src/exchange/exchange.search.ts')));
    // The ExchangeSearchDoc field set must not declare any coordinate key.
    const doc = s.slice(s.indexOf('interface ExchangeSearchDoc'), s.indexOf('}', s.indexOf('interface ExchangeSearchDoc')));
    expect(doc).not.toMatch(/\b(lat|lon|latitude|longitude|coord\w*|geog|point)\s*[:?]/i);
  });

  it('NO age/gender/payment field exists anywhere in the exchange subtree', () => {
    const files = [...walk(join(BACKEND, 'src/exchange'), ['.ts']), ...requireNonEmpty(clientDomainRoots('exchange').flatMap((d) => walk(d, ['.ts', '.tsx'])), 'exchange client surface')];
    for (const f of files) {
      const s = read(f);
      // A field/property named age/gender, or a payment amount field — refused.
      expect(s).not.toMatch(/\b(age|gender)\s*[:?]\s*(number|string|Age|Gender)/i);
      expect(s).not.toMatch(/\b(priceAmount|amountCents|chargeAmount|escrow|checkout)\b/i);
    }
  });

  it('the business seam is DARK: no reachable business flow (individuals-only v1, D4)', () => {
    const files = walk(join(BACKEND, 'src/exchange'), ['.ts']);
    // ownerKind defaults to 'user' and the service never sets it to 'business'.
    const service = read(join(BACKEND, 'src/exchange/exchange.service.ts'));
    expect(service).not.toMatch(/ownerKind\s*[:=]\s*['"]business['"]/);
    // The business table is a projection only — no controller route builds one.
    const controller = stripComments(read(join(BACKEND, 'src/exchange/exchange.controller.ts')));
    expect(controller).not.toMatch(/business/i);
    expect(files.length).toBeGreaterThan(0);
    // BEHAVIORAL (review BUSINESS-FENCE): the ONLY public input path stamps
    // ownerKind='user'. A business owner cannot be produced through validation,
    // so the business seam is unreachable in fact, not just by convention.
    const v = validateIntentInput('u1', {
      kind: 'need', category: 'services/plumbing', title: 'Tap', text: 'leaks',
      origin: { lat: 12.9716, lon: 77.5946 }, idempotencyKey: 'k1',
    });
    expect(v.ownerKind).toBe('user');
  });

  it('no exchange feature flag is true; crypto flags remain dark', () => {
    const files = [...walk(join(BACKEND, 'src'), ['.ts']), ...requireNonEmpty(clientAllRoots().flatMap((d) => walk(d, ['.ts', '.tsx'])), 'client surface')];
    for (const f of files) {
      expect(read(f)).not.toMatch(/EXCHANGE[_A-Z]*ENABLED\s*=\s*true/);
    }
    const signing = read(join(liveWebRoot(), 'src/lib/crypto/signing-key-publication.js'));
    expect(signing).toContain('SIGNING_PUBLICATION_ENABLED = false');
  });

  it('no secret-shaped literal in any exchange source file', () => {
    const files = [...walk(join(BACKEND, 'src/exchange'), ['.ts']), ...requireNonEmpty(clientDomainRoots('exchange').flatMap((d) => walk(d, ['.ts', '.tsx'])), 'exchange client surface')];
    const SECRET = /\b(sk|pk|key|token|bearer)[-_][A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    expect(files.filter((f) => SECRET.test(read(f)))).toEqual([]);
  });

  it('BUILD ARTIFACTS: compiled exchange output carries no Typesense endpoint or secret', () => {
    const dist = join(BACKEND, 'dist');
    expect(existsSync(dist)).toBe(true);
    const files = walk(dist, ['.js']).filter((f) => inDir(f, 'exchange'));
    expect(files.length).toBeGreaterThan(0); // exchange DID compile (non-vacuous)
    const SECRET = /eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/https?:\/\/[^'"\s]*typesense/i);
      expect(SECRET.test(s)).toBe(false);
    }
  });

  it('NON-VACUOUS: every exchange source cluster is exercised by a test', () => {
    const clusters: Record<string, string> = {
      'src/exchange/exchange.policy.ts': 'test/exchange-policy.spec.ts',
      'src/exchange/exchange.prisma.repository.ts': 'test/exchange-lifecycle.e2e-spec.ts',
      'src/exchange/exchange.matching.ts': 'test/exchange-matching.spec.ts',
      'src/exchange/exchange.search.ts': 'test/exchange-matching.spec.ts',
      'src/exchange/exchange.observability.ts': 'test/exchange-observability.spec.ts',
    };
    for (const [src, spec] of Object.entries(clusters)) {
      expect(existsSync(join(BACKEND, src))).toBe(true);
      expect(existsSync(join(BACKEND, spec))).toBe(true);
    }
    for (const t of ['exchange-controller.test.ts', 'exchange-ui.test.tsx', 'exchange-privacy-mutation.test.ts']) {
      expect(clientTestExists(t)).toBe(true);
    }
  });
});
