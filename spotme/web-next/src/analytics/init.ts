/**
 * Analytics initialisation gate (ADR-031). Dark by construction:
 *
 *   enabled ⇔ ANALYTICS_MASTER (compile-time) AND POSTHOG_KEY present.
 *
 * While either is missing the sink stays NOOP and the PostHog adapter module
 * is never imported — dynamic import below means posthog-js stays out of the
 * critical path (and, while no live code calls initAnalytics at all, out of
 * the bundle entirely; the artifact fence proves it).
 *
 * NOTHING in the live app calls this today. Activation = an owner-authorised
 * change that flips ANALYTICS_MASTER and calls initAnalytics() from the
 * app's wiring layer (G8). The overrides parameter exists for tests only.
 */

import { ANALYTICS_MASTER } from './flags';
import { analyticsKeyPresent, resolveAnalyticsConfig, type AnalyticsConfig } from './config';
import { setAnalyticsSink, track } from './index';

export type AnalyticsInitOutcome = 'disabled-flag' | 'disabled-no-key' | 'enabled';

export async function initAnalytics(
  overrides?: Partial<AnalyticsConfig> & { masterForTest?: boolean },
): Promise<AnalyticsInitOutcome> {
  const master = overrides?.masterForTest ?? ANALYTICS_MASTER;
  if (!master) return 'disabled-flag';

  const cfg = resolveAnalyticsConfig(overrides);
  if (!analyticsKeyPresent(cfg)) return 'disabled-no-key';

  const { createPostHogAnalytics } = await import('./posthog');
  setAnalyticsSink(createPostHogAnalytics(cfg));
  track({ type: 'session_start' });
  return 'enabled';
}
