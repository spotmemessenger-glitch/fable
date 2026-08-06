/**
 * The domain darkness registry (Phase 6B, X8) — LIVE composition: every
 * assistant domain is implemented-dark, so live answers are ALWAYS
 * domain-not-active. The assistant is never a bypass route into the dark
 * Discovery/Exchange/Events/Moments modules (fence-tested in 6E). Fixture
 * activation exists ONLY in assistant.fixtures.ts, which refuses to construct
 * outside a test environment.
 */

import { ASSISTANT_DOMAINS } from './assistant.types';
import type { AssistantDomain, DomainAvailability, DomainDarknessRegistry } from './assistant.types';
import type { AssistantDomainPort } from './assistant.ports';

/** All five layers of the Discovery programme are dark this phase. */
export const LIVE_DOMAIN_DARKNESS: DomainDarknessRegistry = Object.freeze({
  people: 'implemented-dark',
  places: 'implemented-dark',
  events: 'implemented-dark',
  exchange: 'implemented-dark',
  username: 'implemented-dark',
});

export class LiveDomainDarknessAdapter implements AssistantDomainPort {
  registry(): DomainDarknessRegistry {
    return LIVE_DOMAIN_DARKNESS;
  }

  availability(domain: AssistantDomain): DomainAvailability {
    // Totality: unknown strings can't reach here through the typed router,
    // but a defensive default answers 'unsupported', never 'activated'.
    return ASSISTANT_DOMAINS.includes(domain) ? LIVE_DOMAIN_DARKNESS[domain] : 'unsupported';
  }
}
