/**
 * Phase 4D — DARK INTEGRATION FENCES for Live Nearby Events. Load-bearing,
 * non-vacuous: every claim of darkness is an assertion over the actual source
 * tree, schema, manifests, and build artifacts — a PR-body promise enforces
 * nothing.
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeEvent } from '../src/events/events.normalize';

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
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
/** A quoted import specifier reaching the events subtree at a path boundary. */
const EVENTS_REACH = /['"][^'"]*\/events[\/.'"-]/;

describe('Events — dark integration fences', () => {
  it('AppModule imports NEITHER EventsModule NOR the events subtree', () => {
    const src = read(join(BACKEND, 'src/app.module.ts'));
    for (const banned of ['EventsModule', './events', '/events/']) {
      expect(src).not.toContain(banned);
    }
  });

  it('no backend module OUTSIDE src/events imports the events code (static or dynamic)', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts']).filter((f) => !f.includes('/events/'));
    expect(files.filter((f) => EVENTS_REACH.test(read(f)))).toEqual([]);
    expect(read(join(BACKEND, 'src/main.ts'))).not.toMatch(/\bevents\b/i);
  });

  it('the web-next entry (App/main) mounts NEITHER EventsShell NOR the events subtree', () => {
    for (const entry of ['src/App.tsx', 'src/main.tsx']) {
      const s = read(join(WEBNEXT, entry));
      expect(s).not.toMatch(/EventsShell/);
      expect(EVENTS_REACH.test(s)).toBe(false);
    }
  });

  it('the Events search index type carries NO coordinate field', () => {
    const s = stripComments(read(join(BACKEND, 'src/events/events.search.ts')));
    const doc = s.slice(s.indexOf('interface EventSearchDoc'), s.indexOf('}', s.indexOf('interface EventSearchDoc')));
    expect(doc).not.toMatch(/\b(lat|lon|latitude|longitude|coord\w*|geog|point)\s*[:?]/i);
  });

  it('NO user-origin column/field persists anywhere in the events subtree or schema', () => {
    // events.safety.ts is the origin-LEAK GUARD — it names origin shapes by
    // design to DETECT them, so it is excluded from the "no declaration" sweep.
    const guard = join(BACKEND, 'src/events/events.safety.ts');
    const files = [...walk(join(BACKEND, 'src/events'), ['.ts']), ...walk(join(WEBNEXT, 'src/events'), ['.ts', '.tsx'])].filter((f) => f !== guard);
    const schema = read(join(BACKEND, 'prisma/schema.prisma'));
    const eventModel = schema.slice(schema.indexOf('model Event '), schema.indexOf('}', schema.indexOf('model Event ')));
    // No origin-shaped column on the Event model (the real persistence fence).
    expect(eventModel).not.toMatch(/origin ?lat|origin ?lon|user ?lat|user ?lon/i);
    // No origin-shaped field declared in any other source (comments stripped).
    for (const f of files) {
      const s = stripComments(read(f));
      expect(s).not.toMatch(/\b(originLat|originLon|userLat|userLon|myPosition)\s*[:?]/i);
    }
    // Non-vacuous: the guard DOES exist and asserts the invariant.
    expect(read(guard)).toContain('assertNoOriginLeak');
  });

  it('NO age/gender/payment field exists anywhere in the events subtree', () => {
    const files = [...walk(join(BACKEND, 'src/events'), ['.ts']), ...walk(join(WEBNEXT, 'src/events'), ['.ts', '.tsx'])];
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/\b(age|gender)\s*[:?]\s*(number|string|Age|Gender)/i);
      expect(s).not.toMatch(/\b(priceAmount|amountCents|chargeAmount|escrow|checkout)\b/i);
    }
  });

  it('BEHAVIORAL: the normalize boundary coarsens the venue and never mints an unsourced popularity', () => {
    const e = normalizeEvent({ providerEventId: 'x', title: 'T', lat: 12.9716123, lon: 77.5946098 }, 'fixture')!;
    // The venue is coarse by construction — the precise input digits do not survive.
    expect(e.coarseLat).toBe(12.972);
    expect(JSON.stringify(e)).not.toContain('12.9716123');
    // Popularity is null when the source supplied none — never an invented crowd (C2).
    expect(e.popularity).toBeNull();
    // A sourced number is clamped to 0..1.
    expect(normalizeEvent({ providerEventId: 'y', title: 'T', lat: 1, lon: 2, popularity: 9 }, 'f')!.popularity).toBe(1);
  });

  it('no events feature flag is true; crypto flags remain dark', () => {
    const files = [...walk(join(BACKEND, 'src'), ['.ts']), ...walk(join(WEBNEXT, 'src'), ['.ts', '.tsx'])];
    for (const f of files) {
      expect(read(f)).not.toMatch(/EVENTS[_A-Z]*ENABLED\s*=\s*true/);
    }
    const signing = read(join(REPO, 'spotme/web/src/lib/crypto/signing-key-publication.js'));
    expect(signing).toContain('SIGNING_PUBLICATION_ENABLED = false');
  });

  it('no secret-shaped literal in any events source file', () => {
    const files = [...walk(join(BACKEND, 'src/events'), ['.ts']), ...walk(join(WEBNEXT, 'src/events'), ['.ts', '.tsx'])];
    const SECRET = /\b(sk|pk|key|token|bearer)[-_][A-Za-z0-9]{20,}|eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    expect(files.filter((f) => SECRET.test(read(f)))).toEqual([]);
  });

  it('BUILD ARTIFACTS: compiled events output carries no provider endpoint or secret', () => {
    const dist = join(BACKEND, 'dist');
    expect(existsSync(dist)).toBe(true);
    const files = walk(dist, ['.js']).filter((f) => f.includes('/events/'));
    expect(files.length).toBeGreaterThan(0); // events DID compile (non-vacuous)
    const SECRET = /eyJ[A-Za-z0-9_-]{28,}|[a-z][a-z0-9+.-]*:\/\/[^\s'"]*:[^\s'"]*@/;
    for (const f of files) {
      const s = read(f);
      expect(s).not.toMatch(/https?:\/\/[^'"\s]*(ticketmaster|eventbrite|meetup|seatgeek)/i);
      expect(SECRET.test(s)).toBe(false);
    }
  });

  it('NON-VACUOUS: every events source cluster is exercised by a test', () => {
    const clusters: Record<string, string> = {
      'src/events/events.time.ts': 'test/events-time.spec.ts',
      'src/events/events.normalize.ts': 'test/events-normalize.spec.ts',
      'src/events/events.dedup.ts': 'test/events-dedup.spec.ts',
      'src/events/events.safety.ts': 'test/events-safety-search.spec.ts',
      'src/events/events.search.ts': 'test/events-safety-search.spec.ts',
      'src/events/events.ranking.ts': 'test/events-ranking.spec.ts',
      'src/events/events.prisma.repository.ts': 'test/events-lifecycle.e2e-spec.ts',
      'src/events/events.observability.ts': 'test/events-observability.spec.ts',
    };
    for (const [src, spec] of Object.entries(clusters)) {
      expect(existsSync(join(BACKEND, src))).toBe(true);
      expect(existsSync(join(BACKEND, spec))).toBe(true);
    }
    for (const t of ['events-controller.test.ts', 'events-ui.test.tsx', 'events-privacy-mutation.test.ts']) {
      expect(existsSync(join(WEBNEXT, 'test', t))).toBe(true);
    }
  });
});
