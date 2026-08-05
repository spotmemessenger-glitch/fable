/**
 * Wave 1B — the 18+ age policy (owner decision D6: 18+ at launch,
 * account-level; no minor holds an account).
 *
 * WHAT IS STORED — AND WHY ONLY THIS. The declaration is a self-declared
 * birth YEAR-MONTH (`YYYY-MM`), never a full date of birth:
 *
 *  - An attestation checkbox alone verifies nothing server-side: there is no
 *    age math to run, no birthday edge to enforce, and "I am 18" from a client
 *    is exactly the tampered payload B4 requires us to reject. The server must
 *    compute eligibility itself, which needs a birth date of SOME precision.
 *  - A full DOB is more than the computation needs. Day precision only matters
 *    inside the single boundary month, and it is exactly the extra piece that
 *    turns "demographic" into "identifier" (birthdays are security-question
 *    fodder and a linkage key across datasets).
 *  - Year-month is the minimum that lets the server decide. The boundary month
 *    is resolved CONSERVATIVELY (below), which also erases every timezone and
 *    leap-day edge: with no day stored there is no Feb-29 to mishandle, and a
 *    whole month of margin dwarfs any UTC-offset ambiguity.
 *
 * THE CONSERVATIVE MONTH RULE. A declarant is eligible only when their
 * 18th-birthday MONTH is entirely in the past (UTC): someone born 2008-08 is
 * refused throughout 2026-08 — even if their real birthday was the 1st — and
 * accepted from 2026-09-01 UTC. We err up to one month toward refusal, never
 * toward admitting a 17-year-old. "Turns 18 today" is therefore refused BY
 * DESIGN, deterministically, in every timezone.
 *
 * Once eligible, always eligible: age only increases, so `ageVerified` is
 * monotonic and never needs re-checking against the clock.
 */

/** Bump when the policy TEXT shown at declaration changes (B2 stores it). */
export const AGE_POLICY_VERSION = '18plus-v1';

/** The declaration format: a calendar year-month, zero-padded. */
export const BIRTH_YEAR_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const ADULT_YEARS = 18;
/** No credible declarant is older than this; below 1900 is a typo, not a person. */
const MAX_AGE_YEARS = 120;

/** The clear, non-punitive refusal copy (same everywhere it is used). */
export const AGE_REFUSAL_MESSAGE = 'Spot Me is for people 18 and over. We are not able to offer you an account yet.';

/** Structural validity only — not eligibility. */
export function isValidBirthYearMonth(ym: unknown, now: Date = new Date()): ym is string {
  if (typeof ym !== 'string' || !BIRTH_YEAR_MONTH_RE.test(ym)) return false;
  const year = Number(ym.slice(0, 4));
  const nowYear = now.getUTCFullYear();
  if (year < nowYear - MAX_AGE_YEARS) return false; // implausibly old
  // A birth month in the future is structurally invalid, not merely under-age.
  const month = Number(ym.slice(5, 7));
  if (year > nowYear || (year === nowYear && month > now.getUTCMonth() + 1)) return false;
  return true;
}

/**
 * The eligibility decision. True only when the declarant's 18th-birthday month
 * has FULLY passed in UTC — the conservative rule documented above.
 */
export function isAdultYearMonth(ym: string, now: Date = new Date()): boolean {
  if (!isValidBirthYearMonth(ym, now)) return false;
  const birthYear = Number(ym.slice(0, 4));
  const birthMonth = Number(ym.slice(5, 7)); // 1-12
  const adultYear = birthYear + ADULT_YEARS;
  const nowYear = now.getUTCFullYear();
  const nowMonth = now.getUTCMonth() + 1; // 1-12
  // Eligible strictly AFTER the month they turn 18 — never during it.
  return nowYear > adultYear || (nowYear === adultYear && nowMonth > birthMonth);
}
