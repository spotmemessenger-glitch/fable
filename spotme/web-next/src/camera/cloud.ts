/**
 * Cloud vision — DARK GATEWAY SEAMS under CLOUD CONSENT (C3, ADR-029 §5).
 *
 * Every method takes an explicit, NON-OPTIONAL single-request
 * `CloudConsentContext` — no global flag, inferred, cached, or optional
 * consent is representable (type law) or accepted (runtime law: a missing
 * or malformed context THROWS even if the types were bypassed; a consent
 * older than the freshness window is refused — "cached consent" cannot
 * work). The DEFAULT adapter answers disabled with ZERO network activity —
 * this module holds no ambient network capability at all; a live adapter
 * routes exclusively through the Phase 1E AI Gateway with owner-held keys
 * (gateway-only scans in C5 fail on any provider client elsewhere).
 *
 * The CAM-2 medical leg is NOT a `CloudVisionOp` member — refused by
 * absence (owner policy), exactly as on the source branch.
 */

import type { CloudConsentContext, CloudVisionOp, CloudVisionResult } from '@spotme/contracts';

/** Single-request consent may not be replayed indefinitely — a context
 *  minted more than this many ms before use is stale, not consent. */
export const CONSENT_FRESHNESS_MS = 5 * 60_000;

export class CloudConsentError extends Error {
  constructor(detail: 'missing' | 'malformed' | 'stale') {
    super(`cloud-consent: ${detail}`);
    this.name = 'CloudConsentError';
  }
}

/** Runtime enforcement behind the type law — belt and braces. */
export function assertConsent(consent: CloudConsentContext, nowUTC: number): void {
  if (!consent) throw new CloudConsentError('missing');
  if (consent.kind !== 'cloud-vision-consent' || consent.scope !== 'single-request' ||
      typeof consent.grantedAtUTC !== 'number' || typeof consent.surface !== 'string' || !consent.surface) {
    throw new CloudConsentError('malformed');
  }
  const age = nowUTC - consent.grantedAtUTC;
  // Future-granted consent is as invalid as stale consent (F-CAM-1).
  if (age < 0 || age > CONSENT_FRESHNESS_MS) throw new CloudConsentError('stale');
}

export interface CloudVisionPort {
  /** consent is NON-OPTIONAL on every method — the boundary law. */
  request(op: CloudVisionOp, contentRef: string, consent: CloudConsentContext): Promise<CloudVisionResult>;
}

/** The default and ONLY live binding this stage: disabled, zero egress. */
export class DisabledCloudVision implements CloudVisionPort {
  /** The clock is REQUIRED (review repair F-CAM-1): a defaulted clock made
   *  staleness unenforceable — any real grantedAtUTC read as "future". */
  constructor(private readonly now: () => number) {}

  async request(_op: CloudVisionOp, _contentRef: string, consent: CloudConsentContext): Promise<CloudVisionResult> {
    // Consent is validated even on the disabled path: a surface that forgot
    // to collect it fails HERE, in tests, not at activation.
    assertConsent(consent, this.now());
    return { state: 'disabled', reason: 'gateway-dark' };
  }
}
