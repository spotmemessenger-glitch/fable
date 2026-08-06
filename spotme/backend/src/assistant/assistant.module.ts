/**
 * The Assistant module (Phase 6B), PREPARED BUT NOT WIRED.
 *
 * NOT imported by AppModule — importing it is the single line that would give
 * the running application a /v1/assistant route, and that line is an
 * owner-gated activation change. Composition is X7 ports ONLY; the live
 * bindings are the darkness registry (every domain implemented-dark → every
 * live answer is domain-not-active) and UNAVAILABLE evidence adapters — no
 * network client, no provider keys, no AI SDK, no model, no endpoint exists
 * anywhere in this subtree (X10; the 6E fence asserts all of it).
 */

import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';

import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { DeterministicAssistantIntentRouter } from './assistant.intent';
import { DeterministicSummaryComposer } from './assistant.compose';
import { LiveDomainDarknessAdapter } from './assistant.registry';
import {
  ASSISTANT_DOMAIN_PORT, ASSISTANT_INTENT_PORT, ASSISTANT_SUMMARY_PORT,
  EVENT_EVIDENCE_PORT, EXCHANGE_EVIDENCE_PORT, PEOPLE_EVIDENCE_PORT,
  PLACE_EVIDENCE_PORT, REVIEW_SOURCE_PORT, ROUTE_EVIDENCE_PORT,
  USERNAME_EVIDENCE_PORT, UnavailableEvidenceAdapter, UnavailableReviewSource,
  UnavailableRouteEvidence,
} from './assistant.ports';

@Module({
  imports: [JwtModule.register({})],
  controllers: [AssistantController],
  providers: [
    AssistantService,
    { provide: ASSISTANT_DOMAIN_PORT, useClass: LiveDomainDarknessAdapter },
    { provide: ASSISTANT_INTENT_PORT, useClass: DeterministicAssistantIntentRouter },
    { provide: ASSISTANT_SUMMARY_PORT, useClass: DeterministicSummaryComposer },
    { provide: PEOPLE_EVIDENCE_PORT, useClass: UnavailableEvidenceAdapter },
    { provide: PLACE_EVIDENCE_PORT, useClass: UnavailableEvidenceAdapter },
    { provide: EVENT_EVIDENCE_PORT, useClass: UnavailableEvidenceAdapter },
    { provide: EXCHANGE_EVIDENCE_PORT, useClass: UnavailableEvidenceAdapter },
    { provide: USERNAME_EVIDENCE_PORT, useClass: UnavailableEvidenceAdapter },
    { provide: REVIEW_SOURCE_PORT, useClass: UnavailableReviewSource },
    { provide: ROUTE_EVIDENCE_PORT, useClass: UnavailableRouteEvidence },
  ],
  exports: [AssistantService],
})
export class AssistantModule {}
