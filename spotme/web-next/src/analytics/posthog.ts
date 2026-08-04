/**
 * PostHog adapter (ADR-031) — the ONLY file allowed to import posthog-js,
 * and only init.ts may import this file (fence-tested). Configuration is
 * privacy-hardened and non-negotiable:
 *
 *   - autocapture OFF — only the closed vocabulary is ever sent.
 *   - automatic pageview/pageleave OFF — screen_view is explicit.
 *   - session recording OFF.
 *   - persistence: 'memory' — no cookies, no client storage.
 *   - person profiles only for identified users (the opaque id).
 *
 * Every event still passes the assertClosedVocabulary gate in index.ts
 * BEFORE this adapter sees it; the re-assert here is defence in depth so a
 * future direct use of the adapter cannot skip the gate.
 */

import { posthog } from 'posthog-js';
import type { AnalyticsEvent, AnalyticsPort, OpaqueAnalyticsUserId } from '@spotme/contracts';
import { assertClosedVocabulary, assertOpaqueUserId } from './index';
import type { AnalyticsConfig } from './config';

export function createPostHogAnalytics(cfg: AnalyticsConfig): AnalyticsPort {
  posthog.init(cfg.key, {
    api_host: cfg.host,
    autocapture: false,
    capture_pageview: false,
    capture_pageleave: false,
    disable_session_recording: true,
    persistence: 'memory',
    person_profiles: 'identified_only',
  });

  return {
    identify(userId: OpaqueAnalyticsUserId): void {
      assertOpaqueUserId(userId);
      posthog.identify(userId);
    },
    track(event: AnalyticsEvent): void {
      assertClosedVocabulary(event);
      const { type, ...properties } = event;
      posthog.capture(type, properties);
    },
    reset(): void {
      posthog.reset();
    },
  };
}
