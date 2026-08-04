/**
 * The assistant orchestrator (Phase 6B) — composed ONLY of the X7 ports.
 * Pipeline per query: validate (QueryHandle) → classify sensitive (closed
 * category, X9) → deterministic intent → X8 darkness registry → evidence
 * gather → deterministic template composition → typed answer. There is no
 * path from which prose can be returned, and no path on which query text is
 * stored, logged, hashed, or attached to an error (X1/X9).
 */

import { Inject, Injectable } from '@nestjs/common';

import { AssistantError } from './assistant.errors';
import { QueryHandle, mintCorrelationId } from './assistant.privacy';
import { classifySensitiveQuery, sensitiveNoticeFor } from './assistant.sensitive';
import {
  ASSISTANT_DOMAIN_PORT, ASSISTANT_INTENT_PORT, ASSISTANT_SUMMARY_PORT,
  EVENT_EVIDENCE_PORT, EXCHANGE_EVIDENCE_PORT, PEOPLE_EVIDENCE_PORT,
  PLACE_EVIDENCE_PORT, USERNAME_EVIDENCE_PORT,
} from './assistant.ports';
import type { AssistantDomainPort, AssistantSummaryPort, DomainEvidencePort } from './assistant.ports';
import type { AssistantIntentPort } from './assistant.intent';
import type { AssistantAnswer, AssistantDomain, SensitiveQueryCategory } from './assistant.types';

export interface AssistantResponse {
  readonly correlationId: string;
  readonly answer: AssistantAnswer;
  readonly sensitiveCategory: SensitiveQueryCategory;
  /** [PROPOSED] copy — present only for sensitive categories. */
  readonly sensitiveNotice: string | null;
}

@Injectable()
export class AssistantService {
  private readonly evidencePorts: Record<AssistantDomain, DomainEvidencePort>;

  constructor(
    @Inject(ASSISTANT_DOMAIN_PORT) private readonly domains: AssistantDomainPort,
    @Inject(ASSISTANT_INTENT_PORT) private readonly intent: AssistantIntentPort,
    @Inject(ASSISTANT_SUMMARY_PORT) private readonly summary: AssistantSummaryPort,
    @Inject(PEOPLE_EVIDENCE_PORT) people: DomainEvidencePort,
    @Inject(PLACE_EVIDENCE_PORT) places: DomainEvidencePort,
    @Inject(EVENT_EVIDENCE_PORT) events: DomainEvidencePort,
    @Inject(EXCHANGE_EVIDENCE_PORT) exchange: DomainEvidencePort,
    @Inject(USERNAME_EVIDENCE_PORT) username: DomainEvidencePort,
  ) {
    this.evidencePorts = { people, places, events, exchange, username };
  }

  async answer(rawText: unknown): Promise<AssistantResponse> {
    const correlationId = mintCorrelationId();
    const handle = new QueryHandle(rawText); // throws invalid-query, text-free

    try {
      const text = handle.read();
      const sensitiveCategory = classifySensitiveQuery(text);
      const intent = this.intent.parse(text);

      // X8: a non-activated domain answers domain-not-active — the assistant
      // NEVER reaches into a dark module.
      const availability = this.domains.availability(intent.domain);
      if (availability !== 'activated') {
        return this.respond(correlationId, sensitiveCategory,
          availability === 'unavailable'
            ? { kind: 'unavailable', reason: 'provider-unconfigured' }
            : { kind: 'domain-not-active', domain: intent.domain });
      }

      const bundle = await this.evidencePorts[intent.domain].gather(intent, text);
      const composed = this.summary.compose(bundle);
      if (composed === null) {
        return this.respond(correlationId, sensitiveCategory, {
          kind: 'insufficient-evidence',
          domain: intent.domain,
          reason: bundle.records.length ? 'all-evidence-stale' : 'no-evidence',
        });
      }
      return this.respond(correlationId, sensitiveCategory, {
        kind: 'results', domain: intent.domain, summary: composed,
      });
    } catch (err) {
      if (err instanceof AssistantError && err.code === 'provider-unconfigured') {
        return this.respond(correlationId, 'none',
          { kind: 'unavailable', reason: 'provider-unconfigured' });
      }
      if (err instanceof AssistantError) throw err; // closed-code, text-free
      // Unknown failures collapse to a typed unavailable answer — the raw
      // error (which could echo inputs) is NOT rethrown or logged here.
      return this.respond(correlationId, 'none', { kind: 'unavailable', reason: 'error' });
    } finally {
      handle.dispose(); // bounded in-memory lifetime (X9)
    }
  }

  private respond(
    correlationId: string,
    sensitiveCategory: SensitiveQueryCategory,
    answer: AssistantAnswer,
  ): AssistantResponse {
    return {
      correlationId,
      answer,
      sensitiveCategory,
      sensitiveNotice: sensitiveNoticeFor(sensitiveCategory),
    };
  }
}
