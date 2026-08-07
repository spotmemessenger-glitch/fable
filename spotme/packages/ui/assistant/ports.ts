/**
 * AI Interactive Map client ports (Phase 6D). Fixture adapters only — no
 * network, no AI SDK, no model. The view layer consumes the Phase 6A
 * contracts directly: an answer is the discriminated union with NO prose
 * variant, so this surface cannot render un-cited text even by accident.
 *
 * VoiceInputPort is the DISABLED SEAM for the merged Phase 1E AI Gateway
 * VoicePort: an interface + one disabled adapter. The mic renders an HONEST
 * disabled state; there is no flag and no activation path here.
 */

import type {
  AssistantAnswer, CoarsePublicLocation, ReviewIntelligence, RouteAdvice,
  SensitiveQueryCategory,
} from '@spotme/contracts';

export interface AssistantResponseView {
  readonly correlationId: string;
  readonly answer: AssistantAnswer;
  readonly sensitiveCategory: SensitiveQueryCategory;
  /** [PROPOSED] copy from the closed backend registry — never composed here. */
  readonly sensitiveNotice: string | null;
}

export interface AssistantQueryInput {
  readonly text: string;
  /** The branded coarse projection or nothing — a device fix cannot type here. */
  readonly origin: CoarsePublicLocation | null;
}

export interface AssistantApiPort {
  query(input: AssistantQueryInput): Promise<AssistantResponseView>;
  reviewIntelligence(subjectRef: string): Promise<ReviewIntelligence | null>;
  routeAdvice(destinationRef: string, origin: CoarsePublicLocation | null): Promise<RouteAdvice>;
}

/** The disabled VoicePort seam (Phase 1E) — a name, not an engine. */
export interface VoiceInputPort {
  readonly state: 'disabled';
  /** Human explanation for the honest disabled UI. */
  readonly reason: string;
}

export class DisabledVoiceInput implements VoiceInputPort {
  readonly state = 'disabled' as const;
  readonly reason = 'Voice input is not available yet.';
}
