/**
 * COMPILE-TIME NEGATIVE TESTS for the Phase 3 Exchange contracts.
 *
 * Each `@ts-expect-error` asserts the marked assignment DOES NOT compile. If a
 * refactor makes a raw coordinate, an age/gender field, a sponsored signal, a
 * payment field, or an ineligible match assignable, the expected error vanishes
 * and `tsc` fails with "unused @ts-expect-error" — the fence trips in CI.
 */

import type {
  CoarsePublicLocation,
  ExchangeIntent,
  ExchangeMatchExplanation,
  ExchangeMatchSignal,
  ExchangeSearchQuery,
  ExchangeCursor,
  ExchangeContactCapability,
} from '../src/index.ts';

const coarse = { lat: 12.972, lon: 77.595 } as unknown as CoarsePublicLocation;
const rawFix = { lat: 12.9716, lon: 77.5946 };

/* A raw {lat,lon} is NOT assignable where the branded coarse type is required. */
export const q1: ExchangeSearchQuery = {
  contractsVersion: 1,
  origin: coarse,
  radius: { km: 5, maxKm: 25 },
  cursor: null,
};
export const qBad: ExchangeSearchQuery = {
  contractsVersion: 1,
  // @ts-expect-error raw device fix cannot be an Exchange origin (privacy brand)
  origin: rawFix,
  radius: { km: 5, maxKm: 25 },
  cursor: null,
};

/* A3: no age/gender field exists in the filter shape. */
export const qFilterBad: ExchangeSearchQuery = {
  contractsVersion: 1,
  origin: coarse,
  radius: { km: 5, maxKm: 25 },
  // @ts-expect-error age is not a supported Exchange filter (A3)
  filters: { age: 30 },
  cursor: null,
};
export const qFilterBad2: ExchangeSearchQuery = {
  contractsVersion: 1,
  origin: coarse,
  radius: { km: 5, maxKm: 25 },
  // @ts-expect-error gender is not a supported Exchange filter (A3)
  filters: { gender: 'x' },
  cursor: null,
};

/* The match explanation's safety gate is a TYPE property: an ineligible match
 * (safetyEligible: false) is unrepresentable. */
export const explBad: ExchangeMatchExplanation = {
  components: [],
  total: 0,
  omittedSignals: [],
  // @ts-expect-error an ineligible match cannot be expressed — safety is a hard gate
  safetyEligible: false,
};

/* The closed signal registry: 'sponsored'/'popularity' are not signals. */
// @ts-expect-error sponsored is not a registered Exchange match signal
export const sigBad: ExchangeMatchSignal = 'sponsored';
// @ts-expect-error popularity is not a registered Exchange match signal
export const sigBad2: ExchangeMatchSignal = 'popularity';

/* An opaque cursor cannot be built from a plain string. */
// @ts-expect-error ExchangeCursor is branded — a plain string is not assignable
export const curBad: ExchangeCursor = 'page-2';

/* Contact capability cannot silently drop the explicit-consent requirement. */
export const contactBad: ExchangeContactCapability = {
  canRequestContact: true,
  state: 'none',
  // @ts-expect-error consent requirement is a fixed literal true — cannot be false
  requiresExplicitConsent: false,
};

/* An intent cannot carry a payment field (no payment contract exists). */
export function assertNoPayment(i: ExchangeIntent): void {
  // @ts-expect-error there is no price/payment amount on an intent (informational only)
  void i.priceAmount;
}
