/**
 * Nearby Moments errors — typed, uniform, enumeration-resistant. Never
 * describes another user's state; a non-owner and a non-existent id both get
 * the same NOT_FOUND (uniform not-found, standing bar).
 */

export type MomentsErrorCode =
  | 'MALFORMED_MOMENT'
  | 'PRECISE_LOCATION_REFUSED'
  | 'LOCATION_TIER_REFUSED'
  | 'UNSUPPORTED_FIELD'
  | 'UNKNOWN_REACTION'
  | 'INVALID_CURSOR'
  | 'CURSOR_TOO_DEEP'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION';

export class MomentsError extends Error {
  constructor(
    readonly code: MomentsErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'MomentsError';
  }
  toWire() {
    return { code: this.code, message: this.message, retryable: this.retryable, nextStep: this.nextStep };
  }
}

export const preciseLocationRefused = () =>
  new MomentsError('PRECISE_LOCATION_REFUSED', 'location must be the coarse public contract; a precise device fix was refused', false, 'coarsen on-device and resend only {lat, lon, cell?}');
export const locationTierRefused = () =>
  new MomentsError('LOCATION_TIER_REFUSED', 'a location may be attached only to nearby/public posts (M5)', false, 'remove the location or change the visibility tier');
export const unsupportedField = (f: string) =>
  new MomentsError('UNSUPPORTED_FIELD', `unsupported field '${f}' — moments carry no age/gender/payment/counter shape`, false, `remove '${f}'`);
export const unknownReaction = (r: string) =>
  new MomentsError('UNKNOWN_REACTION', `unknown reaction '${r}' — the registry is closed (M4)`, false, 'use one of like|love|laugh|wow|support');
export const notFound = () =>
  new MomentsError('NOT_FOUND', 'not found', false, 'the content may have been removed or never existed');
export const versionConflict = () =>
  new MomentsError('VERSION_CONFLICT', 'the content changed since you loaded it', true, 'reload and retry with the current version');
export const illegalTransition = (from: string, to: string) =>
  new MomentsError('ILLEGAL_TRANSITION', `no transition ${from} -> ${to}`, false, 'the closed transition table defines the legal moves');
