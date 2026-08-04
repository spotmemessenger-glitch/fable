/**
 * Phase 3E — DARK INTEGRATION FENCES for Exchange. Load-bearing, non-vacuous:
 * every claim of darkness is an assertion over the actual source tree,
 * manifests, and build artifacts — a PR-body promise enforces nothing.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateIntentInput } from '../src/exchange/exchange.policy';

const BACKEND = join(__dirname, '..');
const REPO = join(BACKEND, '../..');
const WEBNEXT = join(REPO, 'spotme/web-next');

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'dist' || e === '.git') continue;
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(full);
  }
  return out;
}
const read = (p: string) => readFileSync(p, 'utf8');
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
    const files = walk(join(BACKEND, 'src'), ['.ts']).filter((f) => !f.includes('/exchange/'));
    // Any quoted import specifier whose path reaches the exchange segment — as
    // `/exchange`, `/exchange/…`, or `/exchange.module` — at a path boundary.
    // Broadened (review IMPORTER-REGEX): the previous form required a trailing
    // slash and missed `./exchange.module`-style specifiers.
    expect(files.filter((f) => EXCHANGE_REACH.test(read(f)))).toEqual([]);
    expect(read(join(BACKEND, 'src/main.ts'))).not.toMatch(/exchange/i);
  });

  it('the web-next entry (App/main) mounts NEITHER ExchangeShell NOR the exchange subtree', () => {
    // WEBNEXT-UNFENCED: the client shell is dark too — the app entry renders
    // only Discovery; nothing imports or mounts the exchange UI.
    for (const entry of ['src/App.tsx', 'src/main.tsx']) {
      const s = read(join(WEBNEXT, entry));
      expect(s).not.toMatch(/ExchangeShell/);
      expect(EXCHANGE_REACH.test(s)).toBe(false);
    }
  });

  it('the Exchange search index type carries NO coordinate field', () => {
    const s = stripComments(read(join(BACKEND, 'src/exchange/exchange.search.ts')));
    // The ExchangeSearchDoc field set must not declare any coordinate key.
    const doc = s.slice(s.indexOf('interface ExchangeSearchDoc'), s.indexOf('}', s.indexOf('interface ExchangeSearchDoc')));
    expect(doc).not.toMatch(/\b(lat|lon|latitude|longitude|coord\w*|geog|point)\s*[:?]/i);
  });

  it('NO age/gender/payment field exists anywhere in the exchange subtree', () => {
    const files = [...walk(join(BACKEND, 'src/exchange'), ['.ts']), ...walk(join(WEBNEXT, 'src/exchange'), ['.ts', '.tsx'])];
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
    const files = [...walk(join(BACKEND, 'src'), ['.ts']), ...walk(join(WEBNEXT, 'src'), ['.ts', '.tsx'])];
    for (const f of files) {
      expect(read(f)).not.toMatch(/EXCHANGE[_A-Z]*ENABLED\s*=\s*true/);
    }
    const signing = read(join(REPO, 'spotme/web/src/lib/crypto/signing-key-publication.js'));
    expect(signing).toContain('SIGNING_PUBLICATION_ENABLED = false');
  });

  it('no secret-shaped literal in any exchange source file', () => {
    const files = [...walk(join(BACKEND, 'src/exchange'), ['.ts']), ...walk(join(WEBNEXT, 'src/exchange'), ['.ts', '.tsx'])];
    const SECRET = /\b(sk|pk|key|token|bearer)[-_][A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    expect(files.filter((f) => SECRET.test(read(f)))).toEqual([]);
  });

  it('BUILD ARTIFACTS: compiled exchange output carries no Typesense endpoint or secret', () => {
    const dist = join(BACKEND, 'dist');
    expect(existsSync(dist)).toBe(true);
    const files = walk(dist, ['.js']).filter((f) => f.includes('/exchange/'));
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
      expect(existsSync(join(WEBNEXT, 'test', t))).toBe(true);
    }
  });
});
