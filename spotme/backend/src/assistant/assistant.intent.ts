/**
 * Deterministic assistant intent routing (Phase 6B) — IntentPort-shaped, the
 * same seam discipline as the merged Phase 1E AI Gateway IntentPort and the
 * Phase 2D discovery router: the DETERMINISTIC BASELINE is the only
 * implementation this phase (no LLM, no keys, no network). A model-backed
 * adapter could later be injected at this seam WITH the baseline as mandatory
 * fallback — owner-gated.
 */

import type { AssistantDomain } from './assistant.types';

export interface AssistantIntent {
  readonly domain: AssistantDomain;
  /** Present only for username lookups — the extracted handle. */
  readonly handle?: string;
}

export interface AssistantIntentPort {
  readonly name: string;
  parse(text: string): AssistantIntent;
}

const DOMAIN_PATTERNS: readonly { pattern: RegExp; domain: AssistantDomain }[] = [
  { pattern: /\b(events?|concerts?|gigs?|festivals?|happening|shows?)\b/i, domain: 'events' },
  { pattern: /\b(exchange|marketplace|sell|buy|swap|borrow|offer|need)\b/i, domain: 'exchange' },
  { pattern: /\b(people|friends?|who'?s (around|near|nearby)|anyone (around|near|nearby))\b/i, domain: 'people' },
];

export class DeterministicAssistantIntentRouter implements AssistantIntentPort {
  readonly name = 'deterministic-baseline';

  parse(text: string): AssistantIntent {
    const raw = String(text ?? '').trim();

    // @handle — exact, Telegram-style (D10 discipline).
    const handleMatch = raw.match(/^@([\p{L}\p{N}_]{2,64})$/u);
    if (handleMatch) return { domain: 'username', handle: handleMatch[1] };

    for (const { pattern, domain } of DOMAIN_PATTERNS) {
      if (pattern.test(raw)) return { domain };
    }

    // Places is the default assistant domain — the map is the surface.
    return { domain: 'places' };
  }
}
