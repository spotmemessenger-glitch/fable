/**
 * Phase 6E — the X10 DARK FENCE BATTERY for the AI Interactive Map assistant.
 * Load-bearing, non-vacuous: every claim of darkness/honesty is an assertion
 * over the actual source tree, dependency manifests, build artifacts, or a
 * behavioral re-proof at fence level. The enumerated X10 fences:
 *
 *  no prose answer path · no uncited claim · no unresolved/cross-request
 *  citation · no stale evidence under current-state language · no unsupported
 *  facet · no generated rating · no raw provider HTML · no provider
 *  prompt/instruction field · no raw-query persistence or reconstructable
 *  hash · no direct domain-internal imports · no dark-domain bypass · no
 *  precise origin in route paths · NO AI SDK / model name / endpoint / env
 *  var · NO network-capable HTTP client in the assistant subtree.
 */

import { join } from 'node:path';
import {
  liveEntryDarkPackageImports, flagGateViolations, BACKEND, REPO, read, walk, inDir, requireNonEmpty, clientDomainRoots, appEntries, builtArtifactDirs,
} from './helpers/fence-paths';

import { DeterministicSummaryComposer } from '../src/assistant/assistant.compose';
import { DeterministicAssistantIntentRouter } from '../src/assistant/assistant.intent';
import { AssistantError } from '../src/assistant/assistant.errors';
import { mintEvidenceRecord, validateEnvelope } from '../src/assistant/assistant.evidence';
import { ReviewIntelligenceEngine } from '../src/assistant/assistant.review';
import { validateRouteOrigin } from '../src/assistant/assistant.route';
import { LiveDomainDarknessAdapter } from '../src/assistant/assistant.registry';
import { AssistantService } from '../src/assistant/assistant.service';
import { UnavailableEvidenceAdapter } from '../src/assistant/assistant.ports';
import { ASSISTANT_DOMAINS } from '../src/assistant/assistant.types';

const CONTRACTS = join(REPO, 'spotme/packages/contracts');

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** Every assistant source file across the three surfaces. */
function assistantSources(): string[] {
  return [
    ...walk(join(BACKEND, 'src/assistant'), ['.ts']),
    ...clientDomainRoots('assistant').flatMap((d) => walk(d, ['.ts', '.tsx', '.css'])),
    join(CONTRACTS, 'src/assistant.ts'),
  ];
}

const ASSISTANT_REACH = /['"][^'"]*\/assistant[\/.'"-]/;

describe('assistant — module darkness', () => {
  it('AppModule imports NEITHER AssistantModule NOR the assistant subtree', () => {
    const src = read(join(BACKEND, 'src/app.module.ts'));
    expect(src).not.toContain('AssistantModule');
    expect(src).not.toContain('./assistant');
  });

  it('no backend module OUTSIDE the assistant subtree imports it (static or dynamic)', () => {
    const files = walk(join(BACKEND, 'src'), ['.ts']).filter((f) => !inDir(f, 'assistant'));
    expect(files.filter((f) => ASSISTANT_REACH.test(stripComments(read(f))))).toEqual([]);
    expect(read(join(BACKEND, 'src/main.ts'))).not.toMatch(/\bassistant\b/i);
  });

  it('the web-next entry (App/main) mounts NEITHER AssistantShell NOR the assistant subtree', () => {
    expect(flagGateViolations()).toEqual([]);
    for (const entry of appEntries()) {
      const s = read(entry);
      expect(s).not.toMatch(/AssistantShell/);
      expect(ASSISTANT_REACH.test(s)).toBe(false);
    }
  });

  it('any built client artifact contains no assistant surface', () => {
    // Wherever the client builds to -- web-next/dist today, packages/ui/dist or
    // the live app's dist after ADR-035. Skipping is LOUD: a silent `return`
    // reads identically to a clean scan in the output, which is how an
    // unenforced fence keeps looking enforced.
    const dirs = builtArtifactDirs();
    if (dirs.length === 0) {
      console.warn('[fence] SKIPPED artifact scan: no client build present. Run a build to exercise this.');
      return;
    }
    let scanned = 0;
    for (const dist of dirs) {
      for (const f of walk(dist, ['.js', '.css', '.html'])) {
        const s = read(f);
        scanned += 1;
        expect(s).not.toContain('AssistantShell');
        expect(s).not.toContain('straight-line estimate');
        expect(s).not.toContain('Ask about this area');
      }
    }
    expect(scanned).toBeGreaterThan(0);
  });

  it('fence is not vacuous: the assistant surfaces exist and are non-trivial', () => {
    const files = assistantSources();
    expect(files.length).toBeGreaterThanOrEqual(15);
    expect(files.some((f) => f.endsWith('assistant.module.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('AssistantShell.tsx'))).toBe(true);
  });
});

describe('assistant — X10 source-tree fences', () => {
  it('NO AI SDK, model name, endpoint, or env var anywhere in the assistant subtrees', () => {
    const banned = [
      /openai/i, /anthropic/i, /gpt-\d/i, /\bclaude\b/i, /gemini/i, /mistral/i, /ollama/i,
      /llama/i, /huggingface/i, /langchain/i, /vertex\s*ai/i, /bedrock/i,
      /[A-Z_]{2,}_API_KEY/, /chat\/completions/, /\bcompletions?\s*\(/i,
      /https?:\/\//i,
      // The ONLY env read the subtree may make is the fixture test guard.
      /process\.env\.(?!NODE_ENV\b)/,
    ];
    for (const f of assistantSources()) {
      const s = stripComments(read(f));
      for (const b of banned) {
        expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
      }
    }
  });

  it('NO network-capable HTTP client in the assistant subtrees', () => {
    const banned = [
      /\bfetch\s*\(/, /axios/i, /XMLHttpRequest/, /\bWebSocket\b/, /EventSource/,
      /node:https?/, /require\(['"]https?['"]\)/, /from\s+['"]https?['"]/, /undici/, /got\(/,
    ];
    for (const f of assistantSources()) {
      const s = stripComments(read(f));
      for (const b of banned) {
        expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
      }
    }
  });

  it('NO direct domain-internal imports (X7): the assistant reaches no dark module internals', () => {
    const banned = [
      /from\s+['"][^'"]*\/(discovery|exchange|events|moments|moment-media)\//,
      /from\s+['"][^'"]*\/(discovery|exchange|events|moments|moment-media)['"]/,
      /@prisma/, /\bprisma\b/i, /typeorm/i, /ioredis|bullmq|redis/i,
    ];
    for (const f of walk(join(BACKEND, 'src/assistant'), ['.ts'])) {
      const s = stripComments(read(f));
      for (const b of banned) {
        expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
      }
    }
    // The web-next assistant may import ONLY the discovery coarsen boundary
    // and ports types — never another surface's internals.
    for (const f of requireNonEmpty(clientDomainRoots('assistant').flatMap((d) => walk(d, ['.ts', '.tsx'])), 'assistant client surface')) {
      const s = stripComments(read(f));
      const imports = [...s.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const imp of imports) {
        expect(
          imp.startsWith('./') || imp === '@spotme/contracts' || imp === 'react' ||
          imp === '../discovery/coarsen' || imp === '../discovery/ports'
            ? '' : `${f} imports ${imp}`,
        ).toBe('');
      }
    }
  });

  it('NO raw-query persistence or reconstructable hash: no storage/hash primitive touches the query', () => {
    const banned = [
      /localStorage/, /sessionStorage/, /indexedDB/i, /document\.cookie/,
      /writeFile|appendFile/, /createHash/, /\bmd5\b/i, /\bsha1\b/i, /crypto\.subtle\.digest/,
    ];
    for (const f of assistantSources()) {
      const s = stripComments(read(f));
      for (const b of banned) {
        expect(s.match(b) ? `${f} matches ${b}` : '').toBe('');
      }
    }
  });

  it('NO generated rating: no rating/stars/score key is produced anywhere in the assistant subtrees', () => {
    for (const f of assistantSources()) {
      const s = stripComments(read(f));
      // Keys/fields — allow prose words in tests/docs, so scan sources only
      // for assignment-shaped tokens.
      expect(s.match(/\b(rating|stars|starRating|score)\s*[:=]/) ? `${f} produces a rating` : '').toBe('');
    }
  });

  it('the assistant module remains ports-only: providers bind adapters, intent, composer — nothing else', () => {
    const s = read(join(BACKEND, 'src/assistant/assistant.module.ts'));
    expect(s).toContain('UnavailableEvidenceAdapter');
    expect(s).toContain('LiveDomainDarknessAdapter');
    expect(s).not.toMatch(/Fixture/); // fixture mode never binds in the live module
  });
});

describe('assistant — X10 behavioral re-proofs at fence level', () => {
  const composer = new DeterministicSummaryComposer();

  it('no prose answer path: zero surviving statements yield null, and live answers stay in the closed union', async () => {
    expect(composer.compose({ records: [], statements: [] })).toBeNull();
    const u = new UnavailableEvidenceAdapter();
    const svc = new AssistantService(
      new LiveDomainDarknessAdapter(), new DeterministicAssistantIntentRouter(), composer, u, u, u, u, u);
    for (const domain of ASSISTANT_DOMAINS) {
      const probe = { people: "who's nearby", places: 'cafes', events: 'concerts', exchange: 'swap', username: '@ash_a' }[domain];
      const res = await svc.answer(probe);
      // Dark-domain bypass fence: every live answer is domain-not-active.
      expect(res.answer).toEqual({ kind: 'domain-not-active', domain });
    }
  });

  it('no uncited claim / no unresolved citation / no stale-as-current (validateEnvelope re-proof)', () => {
    const rec = mintEvidenceRecord({
      id: 'ev:1', sourceId: 's', sourceType: 'fixture', licenseClass: 'fixture',
      category: 'place-hours', retrievedAtUTC: 1, sourceUpdatedAtUTC: null, freshness: 'stale',
      contentRef: 'r', integrityDigest: 'sha256:abcd', attributionLabel: 'F', permittedUse: 'display-with-attribution',
    });
    const claim = {
      id: 'c', text: 'Open now.', category: 'place-hours' as const,
      citationIds: ['ev:1'] as unknown as readonly ['ev:1'],
      confidence: { level: 'low' as const, basis: { sourceDiversity: 1, freshness: 'stale' as const, density: 1 } },
      evidenceStatus: 'supported' as const,
    };
    expect(() => validateEnvelope({ claims: [claim] as never, sources: [] as never })).toThrow(AssistantError);
    expect(() => validateEnvelope({ claims: [claim] as never, sources: [rec] as never }))
      .toThrow(/stale-current-state/);
  });

  it('no raw HTML / prompt fields: the mint boundary refuses them by presence', () => {
    for (const key of ['html', 'prompt', 'providerPrompt', 'instructions', 'rawPayload']) {
      expect(() => mintEvidenceRecord({
        id: 'x', sourceId: 's', sourceType: 'fixture', licenseClass: 'fixture', category: 'place-name',
        retrievedAtUTC: 1, sourceUpdatedAtUTC: null, freshness: 'current', contentRef: 'r',
        integrityDigest: 'sha256:abcd', attributionLabel: 'F', permittedUse: 'display-with-attribution',
        [key]: '<script>x</script>',
      })).toThrow(/forbidden-evidence-field/);
    }
  });

  it('no unsupported facet: the review engine throws on a non-registry facet field', () => {
    const engine = new ReviewIntelligenceEngine();
    expect(() => engine.build('s', {
      records: [], statements: [{ id: 'x', category: 'place-review', templateKey: 'place-review-theme',
        params: { facet: 'overall-rating', theme: 'good' }, citationIds: ['ev:none'] }],
    })).toThrow(/unknown-facet/);
  });

  it('no precise origin in route paths: the boundary quantizes to the public grid (F1)', () => {
    const checked = validateRouteOrigin({ kind: 'coarse', origin: { lat: 12.9716123, lon: 77.5946098 } });
    if (checked.kind !== 'coarse') throw new Error('expected coarse');
    expect(checked.origin).toEqual({ lat: 12.972, lon: 77.595 });
    expect(JSON.stringify(checked)).not.toContain('9716123');
  });
});
