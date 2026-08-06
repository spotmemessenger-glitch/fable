/**
 * Live Nearby Events errors — typed, uniform, enumeration-resistant. Never
 * describes another source's internal state; only the caller's own malformed or
 * out-of-bounds request. Mirrors the discovery/exchange error discipline.
 */

export type EventsErrorCode =
  | 'INVALID_CONTRACTS_VERSION'
  | 'MALFORMED_EVENT'
  | 'PRECISE_LOCATION_REFUSED'
  | 'UNSUPPORTED_FIELD'
  | 'INVALID_TIME_WINDOW'
  | 'INVALID_CURSOR'
  | 'CURSOR_TOO_DEEP'
  | 'NOT_FOUND';

export class EventsError extends Error {
  constructor(
    readonly code: EventsErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly nextStep: string,
  ) {
    super(message);
    this.name = 'EventsError';
  }
  toWire() {
    return { code: this.code, message: this.message, retryable: this.retryable, nextStep: this.nextStep };
  }
}

export const preciseLocationRefused = () =>
  new EventsError(
    'PRECISE_LOCATION_REFUSED',
    'a venue must be the coarse public contract; a precise device fix was refused',
    false,
    'coarsen the venue on the server boundary; never accept a raw precise fix',
  );

export const unsupportedField = (field: string) =>
  new EventsError(
    'UNSUPPORTED_FIELD',
    `unsupported field '${field}' — events carry no age/gender/payment shape (A3)`,
    false,
    `remove '${field}' from the request`,
  );

export const invalidTimeWindow = () =>
  new EventsError(
    'INVALID_TIME_WINDOW',
    'end is before start — an inverted event window is rejected',
    false,
    'supply end >= start, or omit end',
  );

export const invalidCursor = () =>
  new EventsError('INVALID_CURSOR', 'the cursor is malformed or has an invalid signature', false, 'restart from the first page (no cursor)');

export const notFound = () =>
  new EventsError('NOT_FOUND', 'no such event', false, 'the event may have expired or never existed');
