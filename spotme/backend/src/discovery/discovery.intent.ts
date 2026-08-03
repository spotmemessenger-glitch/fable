/**
 * Intent routing (checkpoint 8) — deterministic baseline, IntentPort-shaped.
 *
 * Mirrors the merged AI Gateway's IntentPort seam (Phase 1E): a
 * DiscoveryIntentPort interface with the DETERMINISTIC BASELINE as the only
 * implementation this phase — no LLM calls, no model keys, no network. A
 * model-backed adapter can later be injected at the same seam WITH the
 * baseline as mandatory fallback (P9); routing quality may improve, but the
 * baseline defines correctness.
 *
 * Routed domains: nearby people · @username · place text · category (+ open
 * now, places only — A8) · unavailable future domains. Requests for Exchange /
 * Events / Moments / AI Assistant return a TYPED 'unavailable-domain' intent —
 * a well-formed "not active in this phase" answer, never a silent drop and
 * never a fabricated result (P4).
 */

import { DiscoveryIntent } from './discovery.types';

export interface DiscoveryIntentPort {
  readonly name: string;
  parse(text: string): DiscoveryIntent;
}

/** Category vocabulary — conservative, explicit, extensible via config. */
const CATEGORY_WORDS: Record<string, string> = {
  cafe: 'cafe', coffee: 'cafe', restaurant: 'restaurant', food: 'restaurant',
  vegetarian: 'restaurant', hospital: 'hospital', orthopaedic: 'hospital',
  orthopedic: 'hospital', clinic: 'hospital', pharmacy: 'pharmacy',
  gym: 'gym', park: 'park', atm: 'atm', bank: 'bank', hotel: 'hotel',
};

const FUTURE_DOMAINS: { pattern: RegExp; domain: 'exchange' | 'events' | 'moments' | 'assistant' }[] = [
  { pattern: /\b(exchange|marketplace|sell|buy|offer up)\b/i, domain: 'exchange' },
  { pattern: /\b(event|events|concert|happening)\b/i, domain: 'events' },
  { pattern: /\b(moment|moments|feed)\b/i, domain: 'moments' },
  { pattern: /\b(assistant|ask ai|ai help)\b/i, domain: 'assistant' },
];

export class DeterministicIntentRouter implements DiscoveryIntentPort {
  readonly name = 'deterministic-baseline';

  parse(text: string): DiscoveryIntent {
    const raw = String(text ?? '').trim();
    if (!raw) return { kind: 'people' };

    // @handle — exact, Telegram-style (D10).
    const handleMatch = raw.match(/^@([\p{L}\p{N}_]{2,64})$/u);
    if (handleMatch) return { kind: 'username', handle: handleMatch[1] };

    const lower = raw.toLowerCase();

    // Future domains answer typed-unavailable BEFORE category matching so
    // "events near me" cannot masquerade as a place search.
    for (const { pattern, domain } of FUTURE_DOMAINS) {
      if (pattern.test(lower)) return { kind: 'unavailable-domain', domain };
    }

    if (/\bpeople\b|\bnearby people\b|\bwho'?s (around|near)\b/.test(lower)) {
      return { kind: 'people' };
    }

    const openNow = /\bopen now\b|\bopen\b/.test(lower);
    for (const [word, category] of Object.entries(CATEGORY_WORDS)) {
      if (lower.includes(word)) {
        // A8: openNow attaches only to PLACE-capable intents.
        return { kind: 'category', category, ...(openNow ? { openNow: true } : {}) };
      }
    }

    return { kind: 'place', text: raw };
  }
}
