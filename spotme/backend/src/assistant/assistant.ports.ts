/**
 * The X7 ports (Phase 6B) — the ONLY composition surface of AssistantModule:
 * AssistantDomainPort (the darkness registry, X8) + the five per-domain
 * evidence ports + ReviewSourcePort + RouteEvidencePort + the intent/summary
 * seams. The assistant NEVER imports discovery/exchange/events/moments
 * repositories, controllers, or internals — fixture implementations may adapt
 * domain FIXTURES only (fence-tested in 6E).
 *
 * Live bindings this phase: darkness registry with every domain
 * implemented-dark, and UNAVAILABLE evidence adapters (no network, no keys,
 * no scraping code anywhere).
 */

import { AssistantError } from './assistant.errors';
import type {
  AssistantDomain, CitedSummary, DomainAvailability, DomainDarknessRegistry,
  EvidenceCategory, EvidenceRecord, RouteAdvice, RouteOrigin,
} from './assistant.types';
import type { AssistantIntent } from './assistant.intent';

/* ---------------- Evidence bundles ---------------- */

/**
 * A deterministic statement: WHAT an adapter asserts, referencing a closed
 * TEMPLATE by key (the composer renders the text — adapters never write
 * prose) and citing evidence records by id. Params are plain strings,
 * sanitized at composition.
 */
export interface EvidenceStatement {
  readonly id: string;
  readonly category: EvidenceCategory;
  readonly templateKey: string;
  readonly params: Readonly<Record<string, string>>;
  readonly citationIds: readonly string[];
}

export interface EvidenceBundle {
  readonly records: readonly EvidenceRecord[];
  readonly statements: readonly EvidenceStatement[];
}

/* ---------------- Domain darkness (X8) ---------------- */

export const ASSISTANT_DOMAIN_PORT = Symbol('ASSISTANT_DOMAIN_PORT');
export interface AssistantDomainPort {
  registry(): DomainDarknessRegistry;
  availability(domain: AssistantDomain): DomainAvailability;
}

/* ---------------- Per-domain evidence ports ---------------- */

export interface DomainEvidencePort {
  /** Gather evidence for an intent. Reads the query text transiently via the
   *  caller; MUST NOT store, log, or hash it (X9). */
  gather(intent: AssistantIntent, text: string): Promise<EvidenceBundle>;
}

export const PEOPLE_EVIDENCE_PORT = Symbol('PEOPLE_EVIDENCE_PORT');
export const PLACE_EVIDENCE_PORT = Symbol('PLACE_EVIDENCE_PORT');
export const EVENT_EVIDENCE_PORT = Symbol('EVENT_EVIDENCE_PORT');
export const EXCHANGE_EVIDENCE_PORT = Symbol('EXCHANGE_EVIDENCE_PORT');
export const USERNAME_EVIDENCE_PORT = Symbol('USERNAME_EVIDENCE_PORT');

/* ---------------- Review source (X5 — licensed-only by type) ---------------- */

/** Review evidence is place-review category by construction. */
export type ReviewEvidenceRecord = EvidenceRecord & { readonly category: 'place-review' };

export interface ReviewEvidenceBundle {
  readonly records: readonly ReviewEvidenceRecord[];
  readonly statements: readonly EvidenceStatement[];
}

export const REVIEW_SOURCE_PORT = Symbol('REVIEW_SOURCE_PORT');
export interface ReviewSourcePort {
  fetchReviewEvidence(subjectRef: string): Promise<ReviewEvidenceBundle>;
}

/* ---------------- Route evidence (X6) ---------------- */

export const ROUTE_EVIDENCE_PORT = Symbol('ROUTE_EVIDENCE_PORT');
export interface RouteEvidencePort {
  /** Only a RouteOrigin (branded-coarse or place-ref) can arrive here — a
   *  precise device fix has no path in (X6). */
  advise(origin: RouteOrigin, destinationRef: string): Promise<RouteAdvice>;
}

/* ---------------- Summary seam ---------------- */

export const ASSISTANT_SUMMARY_PORT = Symbol('ASSISTANT_SUMMARY_PORT');
export interface AssistantSummaryPort {
  readonly name: string;
  /** Deterministic template composition — null when no valid claim survives
   *  the X3/X4 gates (the service answers insufficient-evidence). */
  compose(bundle: EvidenceBundle): CitedSummary | null;
}

export const ASSISTANT_INTENT_PORT = Symbol('ASSISTANT_INTENT_PORT');

/* ---------------- Live (dark) adapters ---------------- */

/** The unavailable evidence adapter — the ONLY live binding this phase. */
export class UnavailableEvidenceAdapter implements DomainEvidencePort {
  async gather(): Promise<EvidenceBundle> {
    throw new AssistantError('provider-unconfigured');
  }
}

export class UnavailableReviewSource implements ReviewSourcePort {
  async fetchReviewEvidence(): Promise<ReviewEvidenceBundle> {
    throw new AssistantError('provider-unconfigured');
  }
}

export class UnavailableRouteEvidence implements RouteEvidencePort {
  async advise(): Promise<RouteAdvice> {
    return { kind: 'unavailable', reason: 'provider-unconfigured' };
  }
}
