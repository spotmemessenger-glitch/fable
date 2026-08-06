/**
 * Query privacy (Phase 6B, X9) — the structural enforcement layer:
 *
 *  - QueryHandle: the ONLY carrier of raw query text inside the assistant.
 *    Bounded in-memory lifetime (dispose()), and it CANNOT serialize — its
 *    toJSON/toString/inspect all yield a fixed placeholder, so accidental
 *    JSON.stringify into a log, queue, or response can never leak the text.
 *  - Correlation ids are RANDOM and request-scoped — never derived from the
 *    query, so they are not a reversible (or any) hash of it.
 *  - Telemetry context is built by a CLOSED-FIELD constructor that has no
 *    parameter through which text could arrive.
 */

import { randomUUID } from 'node:crypto';

import { AssistantError } from './assistant.errors';
import type { AssistantDomain, SensitiveQueryCategory } from './assistant.types';

const PLACEHOLDER = '[assistant-query]';
const MAX_QUERY_LENGTH = 512;

export class QueryHandle {
  #text: string | null;

  constructor(raw: unknown) {
    if (typeof raw !== 'string') throw new AssistantError('invalid-query', 'type');
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw new AssistantError('invalid-query', 'empty');
    if (trimmed.length > MAX_QUERY_LENGTH) throw new AssistantError('invalid-query', 'too-long');
    // Strip control characters at the boundary; the text is otherwise opaque.
    this.#text = trimmed.replace(/[\u0000-\u001f\u007f]/g, '');
  }

  /** Read the text for transient in-request use. Throws after dispose(). */
  read(): string {
    if (this.#text === null) throw new AssistantError('invalid-query', 'disposed');
    return this.#text;
  }

  /** End of the bounded lifetime — the reference is dropped eagerly. */
  dispose(): void {
    this.#text = null;
  }

  get disposed(): boolean {
    return this.#text === null;
  }

  /* Serialization CANNOT reach the text. */
  toJSON(): string { return PLACEHOLDER; }
  toString(): string { return PLACEHOLDER; }
  [Symbol.for('nodejs.util.inspect.custom')](): string { return PLACEHOLDER; }
}

/** Request-scoped correlation id — random, never text-derived (X9). */
export function mintCorrelationId(): string {
  return `asst-${randomUUID()}`;
}

/** The ONLY shape assistant telemetry may carry (closed fields, no text). */
export interface AssistantTelemetryContext {
  readonly correlationId: string;
  readonly domain: AssistantDomain | null;
  readonly answerKind: string;
  readonly sensitiveCategory: SensitiveQueryCategory;
  readonly durationMs: number;
}

export function telemetryContext(
  correlationId: string,
  domain: AssistantDomain | null,
  answerKind: string,
  sensitiveCategory: SensitiveQueryCategory,
  durationMs: number,
): AssistantTelemetryContext {
  return Object.freeze({
    correlationId,
    domain,
    answerKind,
    sensitiveCategory,
    durationMs: Number.isFinite(durationMs) && durationMs >= 0 ? Math.round(durationMs) : 0,
  });
}
