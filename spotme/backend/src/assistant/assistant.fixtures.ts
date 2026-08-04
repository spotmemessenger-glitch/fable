/**
 * EXPLICIT FIXTURE MODE (Phase 6B, X8) — TEST-ONLY by construction: every
 * class here throws at construction outside a test environment, so fixture
 * activation can never be wired into a live composition "by accident". The
 * fixtures adapt SYNTHETIC data only (X9: health/safety fixtures synthetic;
 * no real users, providers, or places) and go through the same mint boundary
 * as any live adapter would — fixtures get no integrity shortcuts.
 */

import { AssistantError } from './assistant.errors';
import { mintEvidenceRecord } from './assistant.evidence';
import { ASSISTANT_DOMAINS } from './assistant.types';
import type {
  AssistantDomain, DomainAvailability, DomainDarknessRegistry, EvidenceRecord,
} from './assistant.types';
import type {
  AssistantDomainPort, DomainEvidencePort, EvidenceBundle, EvidenceStatement,
  ReviewEvidenceBundle, ReviewEvidenceRecord, ReviewSourcePort,
} from './assistant.ports';
import type { AssistantIntent } from './assistant.intent';

function assertTestEnvironment(what: string): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new AssistantError('fixture-mode-forbidden', what);
  }
}

/** Fixture darkness registry — activation is EXPLICIT per domain. */
export class FixtureDomainDarknessAdapter implements AssistantDomainPort {
  private readonly reg: DomainDarknessRegistry;

  constructor(activated: readonly AssistantDomain[]) {
    assertTestEnvironment('fixture-registry');
    const entries = ASSISTANT_DOMAINS.map((d) =>
      [d, activated.includes(d) ? 'activated' : 'implemented-dark'] as const);
    this.reg = Object.freeze(Object.fromEntries(entries)) as DomainDarknessRegistry;
  }

  registry(): DomainDarknessRegistry { return this.reg; }
  availability(domain: AssistantDomain): DomainAvailability { return this.reg[domain]; }
}

/* ---------------- synthetic evidence ---------------- */

const T0 = 1_700_000_000_000;

function fixtureRecord(over: Record<string, unknown>): EvidenceRecord {
  return mintEvidenceRecord({
    sourceType: 'fixture', licenseClass: 'fixture',
    retrievedAtUTC: T0, sourceUpdatedAtUTC: null, freshness: 'current',
    permittedUse: 'display-with-attribution', attributionLabel: 'Fixture Source',
    ...over,
  });
}

/** Places: one name record (current), one hours record CURRENT, and one hours
 *  record STALE — so tests can prove the X4 gate drops the stale statement. */
export class FixturePlaceEvidence implements DomainEvidencePort {
  constructor() { assertTestEnvironment('fixture-places'); }

  async gather(_intent: AssistantIntent, _text: string): Promise<EvidenceBundle> {
    const name = fixtureRecord({
      id: 'ev:place:cafe-azul:name', sourceId: 'fixture:places-a', category: 'place-name',
      contentRef: 'ref:cafe-azul:name', integrityDigest: 'sha256:0001',
    });
    const nameAlt = fixtureRecord({
      id: 'ev:place:cafe-azul:name-b', sourceId: 'fixture:places-b', category: 'place-name',
      contentRef: 'ref:cafe-azul:name-b', integrityDigest: 'sha256:0002',
    });
    const hoursCurrent = fixtureRecord({
      id: 'ev:place:cafe-azul:hours', sourceId: 'fixture:places-a', category: 'place-hours',
      contentRef: 'ref:cafe-azul:hours', integrityDigest: 'sha256:0003',
      sourceUpdatedAtUTC: T0 - 3_600_000,
    });
    const hoursStale = fixtureRecord({
      id: 'ev:place:old-mill:hours', sourceId: 'fixture:places-a', category: 'place-hours',
      contentRef: 'ref:old-mill:hours', integrityDigest: 'sha256:0004',
      freshness: 'stale', sourceUpdatedAtUTC: T0 - 90 * 24 * 3_600_000,
    });

    const statements: EvidenceStatement[] = [
      { id: 's1', category: 'place-name', templateKey: 'place-exists',
        params: { name: 'Cafe Azul', area: 'the plaza' }, citationIds: [name.id, nameAlt.id] },
      { id: 's2', category: 'place-hours', templateKey: 'place-hours',
        params: { name: 'Cafe Azul', hours: '09:00-17:00' }, citationIds: [hoursCurrent.id] },
      // The STALE hours statement — the composer must refuse it (X4).
      { id: 's3', category: 'place-hours', templateKey: 'place-hours',
        params: { name: 'Old Mill', hours: '10:00-18:00' }, citationIds: [hoursStale.id] },
    ];
    return { records: [name, nameAlt, hoursCurrent, hoursStale], statements };
  }
}

/** An empty-evidence domain — for proving insufficient-evidence honesty. */
export class FixtureEmptyEvidence implements DomainEvidencePort {
  constructor() { assertTestEnvironment('fixture-empty'); }
  async gather(): Promise<EvidenceBundle> {
    return { records: [], statements: [] };
  }
}

/** Username: a single synthetic handle record. */
export class FixtureUsernameEvidence implements DomainEvidencePort {
  constructor() { assertTestEnvironment('fixture-username'); }

  async gather(intent: AssistantIntent): Promise<EvidenceBundle> {
    if (intent.handle !== 'ash_a') return { records: [], statements: [] };
    const record = fixtureRecord({
      id: 'ev:username:ash-a', sourceId: 'fixture:usernames', category: 'username',
      contentRef: 'ref:username:ash-a', integrityDigest: 'sha256:0005',
    });
    return {
      records: [record],
      statements: [{ id: 'u1', category: 'username', templateKey: 'username-found',
        params: { handle: 'ash_a' }, citationIds: [record.id] }],
    };
  }
}

/** Licensed-only review fixture (X5) — synthetic reviews, two sources. */
export class FixtureReviewSource implements ReviewSourcePort {
  constructor() { assertTestEnvironment('fixture-reviews'); }

  async fetchReviewEvidence(subjectRef: string): Promise<ReviewEvidenceBundle> {
    if (subjectRef !== 'place:cafe-azul') return { records: [], statements: [] };
    const a = fixtureRecord({
      id: 'ev:review:azul:a', sourceId: 'fixture:reviews-a', category: 'place-review',
      licenseClass: 'licensed-provider', contentRef: 'ref:review:azul:a',
      integrityDigest: 'sha256:0006', attributionLabel: 'Fixture Reviews A',
    }) as ReviewEvidenceRecord;
    const b = fixtureRecord({
      id: 'ev:review:azul:b', sourceId: 'fixture:reviews-b', category: 'place-review',
      licenseClass: 'consented-community', contentRef: 'ref:review:azul:b',
      integrityDigest: 'sha256:0007', attributionLabel: 'Fixture Reviews B',
    }) as ReviewEvidenceRecord;
    return {
      records: [a, b],
      statements: [
        { id: 'r1', category: 'place-review', templateKey: 'place-review-theme',
          params: { theme: 'friendly staff' }, citationIds: [a.id, b.id] },
      ],
    };
  }
}
