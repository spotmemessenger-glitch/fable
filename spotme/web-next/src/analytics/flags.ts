/**
 * Compile-time analytics flag (ADR-015 pattern, ADR-031).
 *
 * ANALYTICS_MASTER is a plain module constant: no localStorage, no URL param,
 * no runtime toggle. While false, initAnalytics() refuses to construct the
 * PostHog adapter no matter what keys exist, and the adapter module is never
 * even dynamically imported — activation is ONE deliberate, owner-authorised
 * edit of this line (G8), visible in diff.
 */
export const ANALYTICS_MASTER = false;
