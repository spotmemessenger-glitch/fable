/**
 * Phase 6D — assistant UI + accessibility + citation comprehension. Claims
 * render with per-claim citations labeled FROM the normalized records (X3);
 * honest states are visible cards; the mic is an honestly-disabled VoicePort
 * seam; mixed facets show both sides; the straight-line label is verbatim;
 * the sensitive notice renders without any digits.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { AnswerCard, QueryBar, ReviewFacetPanel, RouteCard, SensitiveNotice } from '../src/assistant/components';
import { DisabledVoiceInput } from '../src/assistant/ports';
import type { AssistantAnswer, CitedClaim, EvidenceRecord, EvidenceRecordId, ReviewIntelligence, RouteAdvice } from '@spotme/contracts';

afterEach(cleanup);

const eid = (s: string) => s as EvidenceRecordId;

const rec = (id: string, over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({
  id: eid(id), sourceId: 'fixture:a', sourceType: 'fixture', licenseClass: 'fixture',
  category: 'place-name', retrievedAtUTC: 1, sourceUpdatedAtUTC: null, freshness: 'current',
  contentRef: `ref:${id}`, integrityDigest: 'sha256:x', attributionLabel: 'Fixture Places',
  permittedUse: 'display-with-attribution', ...over,
});

const claim = (over: Partial<CitedClaim> = {}): CitedClaim => ({
  id: 'c1', text: 'Cafe Azul is a listed place.', category: 'place-name',
  citationIds: [eid('ev1')] as never,
  confidence: { level: 'high', basis: { sourceDiversity: 2, freshness: 'current', density: 2 } },
  evidenceStatus: 'supported', ...over,
});

describe('answer card (X1/X3)', () => {
  it('renders claims with citation chips whose labels come from the RECORD, and a Sources section', () => {
    const answer: AssistantAnswer = {
      kind: 'results', domain: 'places',
      summary: { claims: [claim()] as never, sources: [rec('ev1')] as never },
    };
    render(<AnswerCard answer={answer} />);
    expect(screen.getByText('Cafe Azul is a listed place.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Citation 1: Fixture Places' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sources' })).toBeTruthy();
    expect(screen.getByText(/confidence: high \(2 sources\)/)).toBeTruthy();
  });

  it('an unresolved citation renders as an EXPLICIT failure, never silently', () => {
    const answer: AssistantAnswer = {
      kind: 'results', domain: 'places',
      summary: { claims: [claim({ citationIds: [eid('ev-missing')] as never })] as never, sources: [rec('ev1')] as never },
    };
    render(<AnswerCard answer={answer} />);
    expect(screen.getByRole('button', { name: /unresolved citation/ })).toBeTruthy();
  });

  it('stale-cited claims carry the out-of-date disclosure (X4 display-with-disclosure)', () => {
    const answer: AssistantAnswer = {
      kind: 'results', domain: 'places',
      summary: {
        claims: [claim({ category: 'place-review', text: 'Reviewers mention friendly staff.', citationIds: [eid('ev-old')] as never })] as never,
        sources: [rec('ev-old', { category: 'place-review', freshness: 'stale' })] as never,
      },
    };
    render(<AnswerCard answer={answer} />);
    expect(screen.getByText('may be out of date')).toBeTruthy();
  });

  it('renders every honest state as a visible status card', () => {
    const { rerender } = render(
      <AnswerCard answer={{ kind: 'insufficient-evidence', domain: 'places', reason: 'no-evidence' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/Not enough evidence/);
    rerender(<AnswerCard answer={{ kind: 'insufficient-evidence', domain: 'places', reason: 'all-evidence-stale' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/out of date/);
    rerender(<AnswerCard answer={{ kind: 'domain-not-active', domain: 'events' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/not active yet/);
    rerender(<AnswerCard answer={{ kind: 'unavailable', reason: 'provider-unconfigured' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/no source is configured/);
  });
});

describe('query bar + voice seam', () => {
  it('the mic is honestly disabled with the seam reason exposed to AT', () => {
    render(<QueryBar value="" voice={new DisabledVoiceInput()} busy={false} onChange={() => {}} onSubmit={() => {}} />);
    const mic = screen.getByRole('button', { name: /Voice input \(disabled\)/ });
    expect(mic.getAttribute('aria-disabled')).toBe('true');
    expect((mic as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('search')).toBeTruthy();
    expect(screen.getByPlaceholderText('Ask about this area…')).toBeTruthy();
  });
});

describe('sensitive notice', () => {
  it('renders as a note and contains no digits (no invented hotline)', () => {
    const copy = 'For health concerns, please consult a qualified healthcare professional.';
    render(<SensitiveNotice notice={copy} />);
    const note = screen.getByRole('note');
    expect(note.textContent).toBe(copy);
    expect(note.textContent).not.toMatch(/[0-9]/);
  });
});

describe('review facet panel (X5)', () => {
  const review: ReviewIntelligence = {
    subjectRef: 'place:x',
    facets: [
      { field: 'noise-level', state: 'mixed', claims: [
        claim({ id: 'a', category: 'place-review', text: 'Reviewers describe noise-level as quiet on weekdays.', citationIds: [eid('r1')] as never, evidenceStatus: 'mixed' }),
        claim({ id: 'b', category: 'place-review', text: 'Reviewers describe noise-level as loud on weekends.', citationIds: [eid('r2')] as never, evidenceStatus: 'mixed' }),
      ] },
      { field: 'best-time-to-visit', state: 'insufficient-evidence', claims: [] },
    ] as never,
    sources: [rec('r1', { category: 'place-review' }), rec('r2', { category: 'place-review', sourceId: 'fixture:b', attributionLabel: 'Fixture B' })] as never,
  };

  it('a mixed facet announces the conflict and shows BOTH claims; empty facets are honest; NO stars anywhere', () => {
    const { container } = render(<ReviewFacetPanel review={review} />);
    expect(screen.getByText('Conflicting reports — both shown')).toBeTruthy();
    expect(screen.getByText(/quiet on weekdays/)).toBeTruthy();
    expect(screen.getByText(/loud on weekends/)).toBeTruthy();
    expect(screen.getByText('Not enough evidence')).toBeTruthy();
    expect(container.textContent).not.toMatch(/star|rating|score|\d\.\d\s*\/\s*5/i);
  });
});

describe('route card (X6)', () => {
  it('provider legs show attribution and pass-through numbers; absent numbers say so', () => {
    const route: RouteAdvice = {
      kind: 'provider-route', origin: { kind: 'place-ref', placeRefId: 'p' },
      legs: [
        { mode: 'walk', providerDistanceM: 850, providerDurationS: 660, attribution: 'Fixture Routes', citationId: eid('l1') },
        { mode: 'transit', providerDistanceM: null, providerDurationS: null, attribution: 'Fixture Routes', citationId: eid('l2') },
      ] as never,
      sources: [rec('l1', { category: 'route-leg' })] as never,
    };
    render(<RouteCard route={route} />);
    expect(screen.getByText(/walk: 850 m, 11 min/)).toBeTruthy();
    expect(screen.getByText(/transit: distance not provided, time not provided/)).toBeTruthy();
    expect(screen.getAllByText(/via Fixture Routes/).length).toBe(2);
  });

  it('the straight-line card carries the verbatim label and never a time', () => {
    const route: RouteAdvice = {
      kind: 'straight-line', origin: { kind: 'place-ref', placeRefId: 'p' },
      estimate: { label: 'straight-line estimate', distanceM: 1200 },
    };
    const { container } = render(<RouteCard route={route} />);
    expect(screen.getByText(/straight-line estimate: 1\.2 km — not a route/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/min|eta/i);
  });

  it('unavailable directions are an honest status', () => {
    render(<RouteCard route={{ kind: 'unavailable', reason: 'provider-unconfigured' }} />);
    expect(screen.getByRole('status').textContent).toMatch(/no provider is configured/);
  });
});
