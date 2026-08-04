/**
 * Discovery errors — typed, uniform, enumeration-resistant.
 *
 * Anti-enumeration (threat model T-ENUM / C-ANTIENUM): a hidden user, a
 * non-existent user, and an expired presence all produce the SAME observable
 * outcome (absence from results — never a distinct error), so discovery
 * responses cannot be used as an existence oracle. Errors here are for the
 * CALLER's own request being malformed or over-limit, never for describing
 * other users' state.
 */

export type DiscoveryErrorCode =
  | 'INVALID_CONTRACTS_VERSION'
  | 'MALFORMED_QUERY'
  | 'PRECISE_LOCATION_REFUSED'
  | 'RADIUS_OUT_OF_BOUNDS'
  | 'UNSUPPORTED_FILTER'
  | 'INVALID_CURSOR'
  | 'CURSOR_TOO_DEEP'
  | 'RATE_LIMITED'
  | 'VISIBILITY_REFUSED'
  | 'SCOPE_UNAVAILABLE';

export class DiscoveryError extends Error {
  constructor(
    readonly code: DiscoveryErrorCode,
    message: string,
    /** Whether the caller may retry unchanged (rate limits) or must change the request. */
    readonly retryable: boolean,
    /** What the caller should do next — every failure names a next step (UX §12). */
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'DiscoveryError';
  }

  /** Wire form — never leaks internals, always actionable. */
  toWire(): { code: DiscoveryErrorCode; message: string; retryable: boolean; nextStep: string } {
    return { code: this.code, message: this.message, retryable: this.retryable, nextStep: this.nextStep };
  }
}

export const preciseLocationRefused = () =>
  new DiscoveryError(
    'PRECISE_LOCATION_REFUSED',
    'origin must be the coarse public-location contract; a precise device fix was refused',
    false,
    'coarsen the location on-device (publicPositionFor/coarse) and resend only {lat, lon, cell?}',
  );
