/**
 * Live Nearby Events — the event-provider port (Phase 4B).
 *
 * Providers sit behind ONE duck-typed port so a malformed adapter is skipped,
 * not crashed on. This phase ships ONLY a deterministic fixture adapter and an
 * unavailable adapter — there is NO production provider and NO credential in the
 * tree. Wiring a real feed is an owner-gated activation step.
 *
 * An adapter must never expose credentials as own-properties (`assertNoSecrets`
 * enforces): a credential-carrying adapter fails LOUD, not silently.
 */

import type { EventProviderCandidate } from './events.types';

export interface EventProviderContext {
  /** Device-local search centre — passed only because a nearby lookup needs a
   *  centre; adapters MUST NOT persist or echo it. */
  origin: { lat: number; lon: number };
  radiusKm: number;
  now: number;
}

export interface EventProvider {
  readonly name: string;
  searchEvents(query: { text?: string; category?: string }, ctx: EventProviderContext): Promise<EventProviderCandidate[]>;
}

export const EVENT_PROVIDERS = Symbol('EVENT_PROVIDERS');

export function isValidEventProvider(p: unknown): p is EventProvider {
  return Boolean(p) && typeof p === 'object'
    && typeof (p as EventProvider).name === 'string' && (p as EventProvider).name.trim().length > 0
    && typeof (p as EventProvider).searchEvents === 'function';
}

/** Throw if an adapter carries a secret-shaped own-property (credential echo). */
export function assertNoSecrets(p: object): void {
  const SECRET = /(secret|token|apikey|api_key|password|bearer|credential|private[_-]?key)/i;
  for (const k of Object.keys(p)) {
    if (SECRET.test(k)) throw new Error(`event provider '${(p as EventProvider).name ?? '?'}' exposes a secret-shaped field: ${k}`);
  }
}

/**
 * The default fleet: EMPTY. With no provider configured the honest answer is
 * `unavailable`, never invented events. Provisioning a provider is activation.
 */
export const DEFAULT_EVENT_PROVIDERS: readonly EventProvider[] = [];

/** A deterministic in-memory fixture provider for tests/local demos ONLY. */
export class FixtureEventProvider implements EventProvider {
  readonly name: string;
  constructor(private readonly candidates: EventProviderCandidate[], name = 'fixture') {
    this.name = name;
  }
  async searchEvents(): Promise<EventProviderCandidate[]> {
    return this.candidates.map((c) => ({ ...c }));
  }
}

/** An adapter that is present but unavailable (typed failure, no network). */
export class UnavailableEventProvider implements EventProvider {
  readonly name = 'unavailable';
  async searchEvents(): Promise<EventProviderCandidate[]> {
    throw new Error('event provider unavailable');
  }
}
