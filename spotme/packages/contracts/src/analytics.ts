/**
 * Product-analytics contracts (ADR-031) — the CLOSED event vocabulary and the
 * AnalyticsPort every surface must go through. PostHog (or any successor) is
 * an adapter behind this port, never a direct import at a call site.
 *
 * PRIVACY LAWS (fence-tested in web-next and by the compile-time negatives):
 *   - NO coordinates and NO location cell ids in any event.
 *   - NO message or Moment content, NO search query text.
 *   - NO age or sex/gender filter values.
 *   - The user id is the app's opaque id ONLY (branded below) — never an
 *     email, phone number, or handle.
 *
 * The vocabulary is CLOSED: every event name and every property value set is
 * a finite union in this file. Adding an event (or a screen/feature/step/code)
 * means editing these lists — a change that is visible in diff and reviewed,
 * never an ad-hoc string at a call site.
 */

export const ANALYTICS_CONTRACTS_VERSION = '1.0.0' as const;
export type AnalyticsContractsVersion = typeof ANALYTICS_CONTRACTS_VERSION;

/** The app's opaque user id, branded so raw identifiers cannot be passed. */
export type OpaqueAnalyticsUserId = string & { readonly __opaqueAnalyticsUserId: unique symbol };

/** Closed list of screens. One entry per surfaced screen — nothing dynamic. */
export type AnalyticsScreen =
  | 'discovery'
  | 'events'
  | 'exchange'
  | 'moments'
  | 'assistant'
  | 'chat'
  | 'signup'
  | 'settings';

/** Closed list of signup-funnel steps (activation funnel, Wave 1). */
export type AnalyticsSignupStep =
  | 'started'
  | 'otp_requested'
  | 'otp_verified'
  | 'profile_completed';

/** Closed list of feature interactions. Names describe the ACTION, never data. */
export type AnalyticsFeature =
  | 'map_marker_select'
  | 'discovery_search'
  | 'discovery_visibility_toggle'
  | 'view_mode_toggle'
  | 'event_save'
  | 'exchange_compose_open'
  | 'moment_compose_open';

/** Closed list of error codes — machine categories, never message text. */
export type AnalyticsErrorCode =
  | 'offline'
  | 'provider_unavailable'
  | 'permission_required'
  | 'location_unavailable'
  | 'validation'
  | 'unknown';

/**
 * The closed event union. `type` is the wire event name; every property is a
 * member of a closed list above. There is deliberately NO free-form
 * properties bag — payload shape is part of the contract.
 */
export type AnalyticsEvent =
  | { readonly type: 'screen_view'; readonly screen: AnalyticsScreen }
  | { readonly type: 'signup_step'; readonly step: AnalyticsSignupStep }
  | { readonly type: 'session_start' }
  | { readonly type: 'feature_used'; readonly name: AnalyticsFeature }
  | { readonly type: 'error_shown'; readonly surface: AnalyticsScreen; readonly code: AnalyticsErrorCode };

export type AnalyticsEventName = AnalyticsEvent['type'];

/** The runtime mirror of the closed name list — the single place to extend. */
export const ANALYTICS_EVENT_NAMES = [
  'screen_view',
  'signup_step',
  'session_start',
  'feature_used',
  'error_shown',
] as const satisfies readonly AnalyticsEventName[];

/**
 * The port. Implementations: a NOOP default everywhere, and the PostHog
 * adapter in web-next (dark until flag + key). `identify` accepts ONLY the
 * branded opaque id; `reset` clears identity on logout.
 */
export interface AnalyticsPort {
  identify(userId: OpaqueAnalyticsUserId): void;
  track(event: AnalyticsEvent): void;
  reset(): void;
}
