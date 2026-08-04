/**
 * Analytics configuration (ADR-031). Two build-time env names, injected via
 * Vite `define` — never read from a request, never persisted:
 *
 *   POSTHOG_KEY  — the PostHog project API key ("phc_…", a publishable
 *                  client key, still treated as config: name-only in the
 *                  repo, value owner-set in the build environment).
 *   POSTHOG_HOST — the ingestion host. The owner is on PostHog US Cloud, so
 *                  the default is https://us.i.posthog.com.
 *
 * Missing key ⇒ analytics stays NOOP even if the compile-time flag were on:
 * presence of BOTH the flag and the key is required (init.ts).
 */

declare const __POSTHOG_KEY__: string | undefined;
declare const __POSTHOG_HOST__: string | undefined;

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

export interface AnalyticsConfig {
  key: string;
  host: string;
}

/** Resolve build-time config; explicit overrides are for tests only. */
export function resolveAnalyticsConfig(overrides?: Partial<AnalyticsConfig>): AnalyticsConfig {
  const key = overrides?.key ?? (typeof __POSTHOG_KEY__ === 'string' ? __POSTHOG_KEY__ : '');
  const host =
    overrides?.host ?? ((typeof __POSTHOG_HOST__ === 'string' && __POSTHOG_HOST__) || DEFAULT_POSTHOG_HOST);
  return { key: key.trim(), host };
}

export function analyticsKeyPresent(cfg: AnalyticsConfig): boolean {
  return cfg.key.length > 0;
}
