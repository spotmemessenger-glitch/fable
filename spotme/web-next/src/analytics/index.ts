/**
 * The analytics seam every call site uses (ADR-031). Default sink: NOOP.
 *
 * PRIVACY LAWS, enforced at RUNTIME here (the contracts enforce them at
 * compile time): only closed-vocabulary events pass — event name, property
 * keys AND property values are all checked against the closed lists. A
 * payload carrying coordinates, cell ids, query text, content, or age/sex
 * values is rejected with AnalyticsPrivacyError before it can reach ANY
 * sink, PostHog or otherwise. The closed lists below are the runtime mirror
 * of `@spotme/contracts` (type-checked against it via `satisfies`; the
 * boundary fence only permits type-only contracts imports).
 */

import type {
  AnalyticsErrorCode,
  AnalyticsEvent,
  AnalyticsEventName,
  AnalyticsFeature,
  AnalyticsPort,
  AnalyticsScreen,
  AnalyticsSignupStep,
  OpaqueAnalyticsUserId,
} from '@spotme/contracts';

/* ------------------- closed vocabulary (runtime mirror) ------------------- */

const EVENT_NAMES = ['screen_view', 'signup_step', 'session_start', 'feature_used', 'error_shown'] as const satisfies readonly AnalyticsEventName[];
const SCREENS = ['discovery', 'events', 'exchange', 'moments', 'assistant', 'chat', 'signup', 'settings'] as const satisfies readonly AnalyticsScreen[];
const SIGNUP_STEPS = ['started', 'otp_requested', 'otp_verified', 'profile_completed'] as const satisfies readonly AnalyticsSignupStep[];
const FEATURES = ['map_marker_select', 'discovery_search', 'discovery_visibility_toggle', 'view_mode_toggle', 'event_save', 'exchange_compose_open', 'moment_compose_open'] as const satisfies readonly AnalyticsFeature[];
const ERROR_CODES = ['offline', 'provider_unavailable', 'permission_required', 'location_unavailable', 'validation', 'unknown'] as const satisfies readonly AnalyticsErrorCode[];

/* Exhaustiveness: if the contracts unions grow, these fail to compile until
 * the runtime mirrors grow too. */
type AssertSame<A extends readonly string[], B extends string> =
  Exclude<B, A[number]> extends never ? true : never;
export const vocabularyComplete:
  AssertSame<[...typeof EVENT_NAMES], AnalyticsEventName> extends never ? never
  : AssertSame<[...typeof SCREENS], AnalyticsScreen> extends never ? never
  : AssertSame<[...typeof SIGNUP_STEPS], AnalyticsSignupStep> extends never ? never
  : AssertSame<[...typeof FEATURES], AnalyticsFeature> extends never ? never
  : AssertSame<[...typeof ERROR_CODES], AnalyticsErrorCode> extends never ? never
  : true = true;

/** Per-event allowed keys and, per key, the closed value list. */
const EVENT_SHAPE: Record<AnalyticsEventName, Record<string, readonly string[]>> = {
  screen_view: { screen: SCREENS },
  signup_step: { step: SIGNUP_STEPS },
  session_start: {},
  feature_used: { name: FEATURES },
  error_shown: { surface: SCREENS, code: ERROR_CODES },
};

export class AnalyticsPrivacyError extends Error {
  constructor(reason: string) {
    super(`analytics event rejected: ${reason}`);
    this.name = 'AnalyticsPrivacyError';
  }
}

/**
 * The runtime privacy gate. Throws unless the event is EXACTLY a member of
 * the closed vocabulary — unknown names, extra keys (lat/lon/cell/query/
 * content/age/sex/anything), and out-of-list values are all rejected.
 */
export function assertClosedVocabulary(event: unknown): asserts event is AnalyticsEvent {
  if (typeof event !== 'object' || event === null) throw new AnalyticsPrivacyError('not an object');
  const e = event as Record<string, unknown>;
  const name = e.type;
  if (typeof name !== 'string' || !(EVENT_NAMES as readonly string[]).includes(name)) {
    throw new AnalyticsPrivacyError(`unknown event name ${JSON.stringify(name)} — the vocabulary is closed`);
  }
  const shape = EVENT_SHAPE[name as AnalyticsEventName];
  for (const key of Object.keys(e)) {
    if (key === 'type') continue;
    const allowedValues = shape[key];
    if (!allowedValues) throw new AnalyticsPrivacyError(`property "${key}" is not allowed on ${name}`);
    const value = e[key];
    if (typeof value !== 'string' || !allowedValues.includes(value)) {
      throw new AnalyticsPrivacyError(`value for "${key}" on ${name} is outside the closed list`);
    }
  }
  for (const required of Object.keys(shape)) {
    if (!(required in e)) throw new AnalyticsPrivacyError(`missing property "${required}" on ${name}`);
  }
}

/** Opaque-id runtime heuristic backing the compile-time brand: never an
 *  email, phone-shaped number, or anything with whitespace. */
export function assertOpaqueUserId(id: string): void {
  if (id.length === 0) throw new AnalyticsPrivacyError('empty user id');
  if (/[@\s]/.test(id) || /\d{8,}/.test(id)) {
    throw new AnalyticsPrivacyError('user id must be the app opaque id — never an email or phone');
  }
}

/* ----------------------------- sink registry ----------------------------- */

class NoopAnalytics implements AnalyticsPort {
  identify(): void {}
  track(): void {}
  reset(): void {}
}

export const NOOP_ANALYTICS: AnalyticsPort = new NoopAnalytics();

let sink: AnalyticsPort = NOOP_ANALYTICS;

/** Swap the sink (init.ts on activation; tests). Events keep passing the
 *  privacy gate REGARDLESS of sink — the gate sits in front. */
export function setAnalyticsSink(next: AnalyticsPort): void {
  sink = next;
}

export function analyticsSink(): AnalyticsPort {
  return sink;
}

/** The one tracking entry point call sites use. NOOP while dark. */
export function track(event: AnalyticsEvent): void {
  assertClosedVocabulary(event);
  sink.track(event);
}

export function identify(userId: OpaqueAnalyticsUserId): void {
  assertOpaqueUserId(userId);
  sink.identify(userId);
}

export function resetAnalytics(): void {
  sink.reset();
}
