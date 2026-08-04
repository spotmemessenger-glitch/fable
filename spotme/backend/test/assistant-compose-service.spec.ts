/**
 * Phase 6B — deterministic composition + service orchestration. The composer
 * renders text ONLY from the closed template registry, refuses uncited/
 * mismatched/stale statements, and returns null (never prose) when nothing
 * survives. The service answers domain-not-active for every domain under the
 * LIVE registry (X8), composes cited results only under EXPLICIT fixture
 * activation, and fixture classes refuse to construct outside a test env.
 */

import { DeterministicSummaryComposer } from '../src/assistant/assistant.compose';
import { DeterministicAssistantIntentRouter } from '../src/assistant/assistant.intent';
import { AssistantError } from '../src/assistant/assistant.errors';
import { LiveDomainDarknessAdapter, LIVE_DOMAIN_DARKNESS } from '../src/assistant/assistant.registry';
import { AssistantService } from '../src/assistant/assistant.service';
import { UnavailableEvidenceAdapter } from '../src/assistant/assistant.ports';
import {
  FixtureDomainDarknessAdapter, FixtureEmptyEvidence, FixturePlaceEvidence,
  FixtureReviewSource, FixtureUsernameEvidence,
} from '../src/assistant/assistant.fixtures';
import { ASSISTANT_DOMAINS } from '../src/assistant/assistant.types';
import type { DomainEvidencePort } from '../src/assistant/assistant.ports';

const composer = new DeterministicSummaryComposer();
const intentRouter = new DeterministicAssistantIntentRouter();

function service(over: {
  registry?: FixtureDomainDarknessAdapter | LiveDomainDarknessAdapter;
  places?: DomainEvidencePort;
  username?: DomainEvidencePort;
} = {}): AssistantService {
  const unavailable = new UnavailableEvidenceAdapter();
  return new AssistantService(
    over.registry ?? new LiveDomainDarknessAdapter(),
    intentRouter,
    composer,
    unavailable,
    over.places ?? unavailable,
    unavailable,
    unavailable,
    over.username ?? unavailable,
  );
}

describe('deterministic summary composition', () => {
  it('composes cited claims from fixture evidence; the stale-hours statement is DROPPED (X4)', async () => {
    const bundle = await new FixturePlaceEvidence().gather({ domain: 'places' }, 'cafes');
    const summary = composer.compose(bundle)!;
    expect(summary).not.toBeNull();

    const texts = summary.claims.map((c) => c.text);
    expect(texts).toContain('Cafe Azul is a listed place in the plaza.');
    expect(texts).toContain('Cafe Azul lists hours 09:00-17:00.');
    // The stale Old Mill hours never became a claim.
    expect(texts.join(' ')).not.toContain('Old Mill');

    // Every claim cited; every citation resolves in-envelope; the stale
    // record did not ride along as an uncited source.
    const sourceIds = new Set(summary.sources.map((s) => s.id));
    for (const claim of summary.claims) {
      expect(claim.citationIds.length).toBeGreaterThanOrEqual(1);
      for (const cid of claim.citationIds) expect(sourceIds.has(cid)).toBe(true);
    }
    expect(sourceIds.has('ev:place:old-mill:hours')).toBe(false);
  });

  it('two-source name claim gets HIGH confidence from diversity; single-source hours stays medium', async () => {
    const bundle = await new FixturePlaceEvidence().gather({ domain: 'places' }, 'cafes');
    const summary = composer.compose(bundle)!;
    const name = summary.claims.find((c) => c.category === 'place-name')!;
    const hours = summary.claims.find((c) => c.category === 'place-hours')!;
    expect(name.confidence.level).toBe('high');
    expect(name.confidence.basis.sourceDiversity).toBe(2);
    expect(hours.confidence.level).toBe('medium');
  });

  it('returns null — not prose — when no statement survives', () => {
    expect(composer.compose({ records: [], statements: [] })).toBeNull();
  });

  it('THROWS on an unknown template key — there is no free-form text path', async () => {
    const bundle = await new FixturePlaceEvidence().gather({ domain: 'places' }, 'x');
    const rogue = {
      records: bundle.records,
      statements: [{ id: 'r', category: 'place-name' as const, templateKey: 'freeform-prose',
        params: { text: 'anything I like' }, citationIds: [bundle.records[0].id] }],
    };
    expect(() => composer.compose(rogue)).toThrow(AssistantError);
  });

  it('sanitizes params: markup and control characters cannot enter claim text', async () => {
    const bundle = await new FixturePlaceEvidence().gather({ domain: 'places' }, 'x');
    const sneaky = {
      records: bundle.records,
      statements: [{ id: 's', category: 'place-name' as const, templateKey: 'place-exists',
        params: { name: '<script>alert(1)</script>Cafe', area: 'town' },
        citationIds: [bundle.records[0].id] }],
    };
    const summary = composer.compose(sneaky)!;
    expect(summary.claims[0].text).not.toContain('<');
    expect(summary.claims[0].text).not.toContain('>');
  });
});

describe('AssistantService under the LIVE registry (X8)', () => {
  it('every domain answers domain-not-active — the assistant is not a bypass into dark modules', async () => {
    const svc = service();
    const byDomain: Record<string, string> = {
      people: "who's nearby", places: 'coffee near me', events: 'concerts tonight',
      exchange: 'swap books', username: '@ash_a',
    };
    for (const domain of ASSISTANT_DOMAINS) {
      const res = await svc.answer(byDomain[domain]);
      expect(res.answer).toEqual({ kind: 'domain-not-active', domain });
    }
    expect(Object.values(LIVE_DOMAIN_DARKNESS).every((v) => v === 'implemented-dark')).toBe(true);
  });
});

describe('AssistantService under EXPLICIT fixture activation (test-only)', () => {
  it('answers cited results for an activated places domain', async () => {
    const svc = service({
      registry: new FixtureDomainDarknessAdapter(['places']),
      places: new FixturePlaceEvidence(),
    });
    const res = await svc.answer('quiet cafe near the plaza');
    expect(res.answer.kind).toBe('results');
    if (res.answer.kind === 'results') {
      expect(res.answer.summary.claims.length).toBeGreaterThan(0);
    }
  });

  it('answers insufficient-evidence (no-evidence) when the gather is empty — honesty, not prose', async () => {
    const svc = service({
      registry: new FixtureDomainDarknessAdapter(['places']),
      places: new FixtureEmptyEvidence(),
    });
    const res = await svc.answer('anything at all here');
    expect(res.answer).toEqual({ kind: 'insufficient-evidence', domain: 'places', reason: 'no-evidence' });
  });

  it('answers unavailable when the evidence adapter is unconfigured', async () => {
    const svc = service({ registry: new FixtureDomainDarknessAdapter(['places']) });
    const res = await svc.answer('coffee');
    expect(res.answer).toEqual({ kind: 'unavailable', reason: 'provider-unconfigured' });
  });

  it('username fixture: found handle yields a cited username claim', async () => {
    const svc = service({
      registry: new FixtureDomainDarknessAdapter(['username']),
      username: new FixtureUsernameEvidence(),
    });
    const res = await svc.answer('@ash_a');
    expect(res.answer.kind).toBe('results');
    if (res.answer.kind === 'results') {
      expect(res.answer.summary.claims[0].text).toBe('@ash_a is a registered username.');
      expect(res.answer.summary.claims[0].category).toBe('username');
    }
  });

  it('fixture classes REFUSE to construct outside a test environment', () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FixtureDomainDarknessAdapter(['places'])).toThrow(AssistantError);
      expect(() => new FixturePlaceEvidence()).toThrow(AssistantError);
      expect(() => new FixtureReviewSource()).toThrow(AssistantError);
    } finally {
      process.env.NODE_ENV = prior;
    }
  });
});

describe('licensed-only review source fixture (X5 seam for 6C)', () => {
  it('returns licensed/consented review records only, from two sources', async () => {
    const bundle = await new FixtureReviewSource().fetchReviewEvidence('place:cafe-azul');
    expect(bundle.records.length).toBe(2);
    for (const r of bundle.records) {
      expect(r.category).toBe('place-review');
      expect(['licensed-provider', 'consented-community']).toContain(r.licenseClass);
    }
  });
});
