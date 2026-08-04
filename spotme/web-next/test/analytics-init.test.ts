/**
 * ADR-031 — the init gate: flag AND key presence, NOOP otherwise, and the
 * PostHog adapter is configured privacy-hardened when (and only when) both
 * are present. posthog-js is mocked; what's under test is OUR gate + config.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NOOP_ANALYTICS, analyticsSink, setAnalyticsSink } from '../src/analytics/index';
import { initAnalytics } from '../src/analytics/init';
import { DEFAULT_POSTHOG_HOST, resolveAnalyticsConfig } from '../src/analytics/config';
import { ANALYTICS_MASTER } from '../src/analytics/flags';

const posthogMock = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
}));
vi.mock('posthog-js', () => ({ posthog: posthogMock }));

afterEach(() => {
  setAnalyticsSink(NOOP_ANALYTICS);
  posthogMock.init.mockClear();
  posthogMock.capture.mockClear();
});

describe('the gate', () => {
  it('the compile-time flag is FALSE in this repo (dark, ADR-015 style)', () => {
    expect(ANALYTICS_MASTER).toBe(false);
  });

  it('flag off ⇒ disabled, no adapter, no SDK init — regardless of key', async () => {
    expect(await initAnalytics({ key: 'phc_testkeyonly' })).toBe('disabled-flag');
    expect(analyticsSink()).toBe(NOOP_ANALYTICS);
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('flag on but NO key ⇒ still disabled, no SDK init (presence gate)', async () => {
    expect(await initAnalytics({ masterForTest: true, key: '' })).toBe('disabled-no-key');
    expect(analyticsSink()).toBe(NOOP_ANALYTICS);
    expect(posthogMock.init).not.toHaveBeenCalled();
  });

  it('flag on AND key present ⇒ enabled: adapter installed, session_start tracked', async () => {
    expect(await initAnalytics({ masterForTest: true, key: 'phc_testkeyonly' })).toBe('enabled');
    expect(analyticsSink()).not.toBe(NOOP_ANALYTICS);
    expect(posthogMock.init).toHaveBeenCalledTimes(1);
    expect(posthogMock.capture).toHaveBeenCalledWith('session_start', {});
  });

  it('the adapter is privacy-hardened: no autocapture, no pageview, no session recording, memory persistence', async () => {
    await initAnalytics({ masterForTest: true, key: 'phc_testkeyonly' });
    const [key, options] = posthogMock.init.mock.calls[0];
    expect(key).toBe('phc_testkeyonly');
    expect(options).toMatchObject({
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: 'memory',
      person_profiles: 'identified_only',
    });
  });

  it('the owner is on PostHog US Cloud: default host is us.i.posthog.com', async () => {
    expect(DEFAULT_POSTHOG_HOST).toBe('https://us.i.posthog.com');
    expect(resolveAnalyticsConfig({ key: 'k' }).host).toBe('https://us.i.posthog.com');
    await initAnalytics({ masterForTest: true, key: 'phc_testkeyonly' });
    expect(posthogMock.init.mock.calls[0][1].api_host).toBe(DEFAULT_POSTHOG_HOST);
  });

  it('an explicit POSTHOG_HOST override wins', async () => {
    await initAnalytics({ masterForTest: true, key: 'phc_testkeyonly', host: 'https://eu.i.posthog.com' });
    expect(posthogMock.init.mock.calls[0][1].api_host).toBe('https://eu.i.posthog.com');
  });
});
