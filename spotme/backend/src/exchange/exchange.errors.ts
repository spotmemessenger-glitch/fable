/**
 * Exchange errors — typed, uniform, enumeration-resistant. Never describes
 * another user's state; only the caller's own malformed/over-limit/unauthorized
 * request. Mirrors the discovery error discipline.
 */

export type ExchangeErrorCode =
  | 'INVALID_CONTRACTS_VERSION'
  | 'MALFORMED_INTENT'
  | 'PRECISE_LOCATION_REFUSED'
  | 'UNSUPPORTED_FIELD'
  | 'RADIUS_OUT_OF_BOUNDS'
  | 'INVALID_CURSOR'
  | 'CURSOR_TOO_DEEP'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'VERSION_CONFLICT'
  | 'ILLEGAL_TRANSITION'
  | 'IDEMPOTENCY_CONFLICT';

export class ExchangeError extends Error {
  constructor(
    readonly code: ExchangeErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'ExchangeError';
  }
  toWire() {
    return { code: this.code, message: this.message, retryable: this.retryable, nextStep: this.nextStep };
  }
}

export const preciseLocationRefused = () =>
  new ExchangeError(
    'PRECISE_LOCATION_REFUSED',
    'location must be the coarse public contract; a precise device fix was refused',
    false,
    'coarsen the location on-device and resend only {lat, lon, cell?}',
  );
