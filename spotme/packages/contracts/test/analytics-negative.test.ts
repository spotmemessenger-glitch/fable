/**
 * COMPILE-TIME NEGATIVE TESTS for the analytics contracts (ADR-031).
 *
 * Each `@ts-expect-error` asserts the marked assignment DOES NOT compile: a
 * coordinate, cell id, query text, message/Moment content, age/sex value, an
 * ad-hoc event name, an unlisted screen/feature/step/code, a free-form
 * properties bag, or a raw (unbranded) user id must all be unrepresentable.
 * If a refactor makes one assignable, tsc fails with "unused @ts-expect-error".
 */

import type {
  AnalyticsEvent,
  AnalyticsEventName,
  AnalyticsPort,
  OpaqueAnalyticsUserId,
} from '../src/index.ts';
import { ANALYTICS_EVENT_NAMES } from '../src/index.ts';

/* ---------- positive control: the vocabulary itself compiles ---------- */

export const good: AnalyticsEvent[] = [
  { type: 'screen_view', screen: 'discovery' },
  { type: 'signup_step', step: 'otp_verified' },
  { type: 'session_start' },
  { type: 'feature_used', name: 'map_marker_select' },
  { type: 'error_shown', surface: 'discovery', code: 'offline' },
];

/* The runtime list is EXHAUSTIVE over the union (and vice versa). */
type MissingFromList = Exclude<AnalyticsEventName, (typeof ANALYTICS_EVENT_NAMES)[number]>;
export const listIsExhaustive: MissingFromList extends never ? true : never = true;

/* ---------- closed vocabulary ---------- */

// @ts-expect-error — an event name outside the closed list is unrepresentable
export const badName: AnalyticsEvent = { type: 'page_view', screen: 'discovery' };

// @ts-expect-error — screens are a closed list
export const badScreen: AnalyticsEvent = { type: 'screen_view', screen: 'admin' };

// @ts-expect-error — features are a closed list, not free-form strings
export const badFeature: AnalyticsEvent = { type: 'feature_used', name: 'whatever_happened' };

// @ts-expect-error — signup steps are a closed list
export const badStep: AnalyticsEvent = { type: 'signup_step', step: 'password_entered' };

// @ts-expect-error — error codes are machine categories, never message text
export const badCode: AnalyticsEvent = { type: 'error_shown', surface: 'discovery', code: 'TypeError: x is undefined' };

/* ---------- privacy laws ---------- */

// @ts-expect-error — NO coordinates in any event
export const withCoords: AnalyticsEvent = { type: 'screen_view', screen: 'discovery', lat: 12.97, lon: 77.59 };

// @ts-expect-error — NO location cell ids
export const withCell: AnalyticsEvent = { type: 'feature_used', name: 'map_marker_select', cellId: 'r40_77.6_12.9' };

// @ts-expect-error — NO search query text
export const withQuery: AnalyticsEvent = { type: 'feature_used', name: 'discovery_search', query: 'cafes near me' };

// @ts-expect-error — NO message/Moment content
export const withContent: AnalyticsEvent = { type: 'screen_view', screen: 'moments', content: 'my moment text' };

// @ts-expect-error — NO age/sex filter values
export const withAgeSex: AnalyticsEvent = { type: 'feature_used', name: 'discovery_search', age: 25, sex: 'f' };

// @ts-expect-error — no free-form properties bag exists on any event
export const withBag: AnalyticsEvent = { type: 'session_start', properties: { anything: 1 } };

/* ---------- identity ---------- */

declare const port: AnalyticsPort;

// @ts-expect-error — a raw string is not the branded opaque id
port.identify('user-123');

// @ts-expect-error — an email is not the branded opaque id
port.identify('someone@example.com');

export const okId = (id: OpaqueAnalyticsUserId) => port.identify(id);
