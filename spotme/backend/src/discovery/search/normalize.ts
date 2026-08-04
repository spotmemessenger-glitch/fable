/**
 * Language-safe normalization for handles and search queries (checkpoint 6).
 *
 * NFKC-fold + casefold + zero-width strip + whitespace collapse: the same
 * function normalizes what is INDEXED and what is QUERIED, so lookalike
 * spoofing via width/compatibility forms and invisible characters cannot make
 * two visually identical handles distinct (D10 uniqueness is enforced by the
 * identity model; this keeps the SEARCH view consistent with it — A9).
 */

const ZERO_WIDTH = /[​-‍⁠﻿]/g;

export function normalizeSearchText(input: string): string {
  return String(input)
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Handle normalization: search text rules, plus handles carry no spaces. */
export function normalizeHandle(input: string): string {
  return normalizeSearchText(input).replace(/\s+/g, '');
}
