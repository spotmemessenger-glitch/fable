/**
 * ADR-031 — the RUNTIME privacy gate. The compile-time negatives live in
 * packages/contracts; these prove the same laws hold for whatever reaches
 * track() at runtime, before any sink (NOOP or PostHog) can see it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalyticsEvent, AnalyticsPort, OpaqueAnalyticsUserId } from '@spotme/contracts';
import {
  AnalyticsPrivacyError,
  NOOP_ANALYTICS,
  analyticsSink,
  assertClosedVocabulary,
  identify,
  resetAnalytics,
  setAnalyticsSink,
  track,
  vocabularyComplete,
} from '../src/analytics/index';

class RecordingSink implements AnalyticsPort {
  events: AnalyticsEvent[] = [];
  ids: string[] = [];
  resets = 0;
  identify(id: OpaqueAnalyticsUserId): void { this.ids.push(id); }
  track(e: AnalyticsEvent): void { this.events.push(e); }
  reset(): void { this.resets += 1; }
}

afterEach(() => setAnalyticsSink(NOOP_ANALYTICS));

describe('closed vocabulary at runtime', () => {
  it('the five closed events pass and reach the sink', () => {
    const sink = new RecordingSink();
    setAnalyticsSink(sink);
    track({ type: 'screen_view', screen: 'discovery' });
    track({ type: 'signup_step', step: 'otp_requested' });
    track({ type: 'session_start' });
    track({ type: 'feature_used', name: 'map_marker_select' });
    track({ type: 'error_shown', surface: 'discovery', code: 'offline' });
    expect(sink.events.map((e) => e.type)).toEqual([
      'screen_view', 'signup_step', 'session_start', 'feature_used', 'error_shown',
    ]);
    expect(vocabularyComplete).toBe(true);
  });

  it('an event name outside the closed list is rejected', () => {
    expect(() => track({ type: 'page_view' } as unknown as AnalyticsEvent)).toThrow(AnalyticsPrivacyError);
  });

  it('PRIVACY LAW: coordinates never pass', () => {
    const sink = new RecordingSink();
    setAnalyticsSink(sink);
    expect(() =>
      track({ type: 'screen_view', screen: 'discovery', lat: 12.9716, lon: 77.5946 } as unknown as AnalyticsEvent),
    ).toThrow(/not allowed/);
    expect(sink.events).toEqual([]);
  });

  it('PRIVACY LAW: location cell ids never pass', () => {
    expect(() =>
      track({ type: 'feature_used', name: 'map_marker_select', cell: 'r40_77.6_12.9' } as unknown as AnalyticsEvent),
    ).toThrow(AnalyticsPrivacyError);
  });

  it('PRIVACY LAW: search query text never passes', () => {
    expect(() =>
      track({ type: 'feature_used', name: 'discovery_search', query: 'cafes in indiranagar' } as unknown as AnalyticsEvent),
    ).toThrow(AnalyticsPrivacyError);
  });

  it('PRIVACY LAW: message/Moment content never passes', () => {
    expect(() =>
      track({ type: 'screen_view', screen: 'moments', content: 'my moment' } as unknown as AnalyticsEvent),
    ).toThrow(AnalyticsPrivacyError);
  });

  it('PRIVACY LAW: age/sex filter values never pass', () => {
    expect(() =>
      track({ type: 'feature_used', name: 'discovery_search', age: 25 } as unknown as AnalyticsEvent),
    ).toThrow(AnalyticsPrivacyError);
    expect(() =>
      track({ type: 'feature_used', name: 'discovery_search', sex: 'f' } as unknown as AnalyticsEvent),
    ).toThrow(AnalyticsPrivacyError);
  });

  it('values outside the closed lists are rejected even under allowed keys', () => {
    expect(() =>
      track({ type: 'screen_view', screen: 'somewhere-else' } as unknown as AnalyticsEvent),
    ).toThrow(/closed list/);
    expect(() =>
      track({ type: 'error_shown', surface: 'discovery', code: 'Error: boom at line 3' } as unknown as AnalyticsEvent),
    ).toThrow(/closed list/);
  });

  it('missing required properties are rejected (no silent partial events)', () => {
    expect(() => track({ type: 'screen_view' } as unknown as AnalyticsEvent)).toThrow(/missing/);
  });

  it('assertClosedVocabulary rejects non-objects', () => {
    expect(() => assertClosedVocabulary('screen_view')).toThrow(AnalyticsPrivacyError);
    expect(() => assertClosedVocabulary(null)).toThrow(AnalyticsPrivacyError);
  });
});

describe('identity', () => {
  it('the opaque app id passes; emails and phone-shaped ids never do', () => {
    const sink = new RecordingSink();
    setAnalyticsSink(sink);
    identify('cku7x2m3f0001abcd' as OpaqueAnalyticsUserId);
    expect(sink.ids).toEqual(['cku7x2m3f0001abcd']);
    expect(() => identify('user@example.com' as OpaqueAnalyticsUserId)).toThrow(/opaque/);
    expect(() => identify('+91 9876543210' as OpaqueAnalyticsUserId)).toThrow(/opaque/);
    expect(() => identify('9876543210' as OpaqueAnalyticsUserId)).toThrow(/opaque/);
  });

  it('reset reaches the sink (logout clears identity)', () => {
    const sink = new RecordingSink();
    setAnalyticsSink(sink);
    resetAnalytics();
    expect(sink.resets).toBe(1);
  });
});

describe('dark default', () => {
  it('the default sink is NOOP and tracking through it is side-effect free', () => {
    expect(analyticsSink()).toBe(NOOP_ANALYTICS);
    expect(() => track({ type: 'session_start' })).not.toThrow();
  });
});
