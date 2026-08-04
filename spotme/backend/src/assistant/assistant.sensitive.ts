/**
 * Sensitive-query classification (Phase 6B, X9) — deterministic, conservative,
 * and CLOSED: classification yields a category from the closed set; the query
 * TEXT is never stored, logged, or hashed anywhere on this path.
 *
 * The user-facing copy below is [PROPOSED] — owner ratification is retained.
 * X9 rules are structural and fixed regardless: no diagnosis, no treatment
 * recommendation, no emergency-suitability claim without licensed evidence,
 * and NO invented hotline or phone number — the copy contains no digits at
 * all, and the test battery asserts that. Local emergency information
 * requires a separately authorized verified source (none exists this phase).
 */

import type { SensitiveQueryCategory } from './assistant.types';

const RULES: readonly { pattern: RegExp; category: Exclude<SensitiveQueryCategory, 'none'> }[] = [
  // Crisis FIRST: a crisis mention wins over a co-occurring health word.
  { pattern: /\b(suicide|suicidal|self[- ]harm|kill (myself|themselves)|overdose|crisis line|hurt myself)\b/i, category: 'crisis' },
  { pattern: /\b(symptom|diagnos\w*|treatment|disease|illness|medication|prescription|therapy|clinic|std|hiv|cancer|depress\w*|anxiety)\b/i, category: 'health' },
  { pattern: /\b(lawyer|attorney|legal advice|lawsuit|sue|arrest\w*|court case|custody|deportation|visa problem)\b/i, category: 'legal' },
  { pattern: /\b(debt|bankrupt\w*|loan shark|payday loan|financial advice|invest\w* advice|gambling problem)\b/i, category: 'financial' },
];

/** Classify to a CLOSED category. The input is read transiently; only the
 *  category leaves this function (X9). */
export function classifySensitiveQuery(text: string): SensitiveQueryCategory {
  const raw = String(text ?? '');
  for (const { pattern, category } of RULES) {
    if (pattern.test(raw)) return category;
  }
  return 'none';
}

/**
 * [PROPOSED] user-facing notices per category — generic professional-help
 * language only. Deliberately: no phone numbers, no organization names, no
 * emergency-suitability claims, no diagnosis or treatment language.
 */
export const SENSITIVE_NOTICE_COPY: Readonly<Record<Exclude<SensitiveQueryCategory, 'none'>, string>> = Object.freeze({
  crisis:
    'If you are in immediate danger, please contact your local emergency services. ' +
    'Speaking with a qualified professional or someone you trust can help. ' +
    'This assistant cannot assess emergencies.',
  health:
    'This assistant cannot provide medical advice, diagnosis, or treatment. ' +
    'For health concerns, please consult a qualified healthcare professional.',
  legal:
    'This assistant cannot provide legal advice. ' +
    'For legal matters, please consult a qualified legal professional.',
  financial:
    'This assistant cannot provide financial advice. ' +
    'For financial matters, please consult a qualified financial professional.',
});

/** The notice for a category — null for 'none'. */
export function sensitiveNoticeFor(category: SensitiveQueryCategory): string | null {
  return category === 'none' ? null : SENSITIVE_NOTICE_COPY[category];
}
