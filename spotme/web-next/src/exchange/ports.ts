/**
 * Exchange client ports (Phase 3D). The controller composes these; this phase
 * ships only fixture/disabled adapters. No component fetches; only ports could
 * ever touch a network, and this phase none do.
 */

import type { DeviceFix, GeolocationPort, ClockPort } from '../discovery/ports';

export type { DeviceFix, GeolocationPort, ClockPort };

/** A composed intent as the UI submits it (already coarsened origin). */
export interface ComposeIntentInput {
  kind: 'need' | 'offer' | 'service';
  category: string;
  title: string;
  text: string;
  tags: string[];
  budgetBand?: 'low' | 'medium' | 'high';
  /** Display-only label; the UI shows the no-payment disclaimer beside it. */
  informationalPrice?: string;
  availability: { state: 'window'; fromIso: string; toIso: string } | { state: 'recurring'; scheduleLabel: string } | { state: 'unknown' };
  origin: { lat: number; lon: number; cell?: string };
  radiusKm: number;
  visibility: 'hidden' | 'discoverable';
  idempotencyKey: string;
}

export interface ExchangeIntentView {
  id: string;
  kind: 'need' | 'offer' | 'service';
  status: 'draft' | 'active' | 'paused' | 'matched' | 'fulfilled' | 'expired' | 'withdrawn' | 'removed';
  category: string;
  title: string;
  text: string;
  tags: string[];
  budgetBand?: 'low' | 'medium' | 'high';
  informationalPrice?: { label: string; disclaimer: 'informational-only-no-payment' };
  approxLocation: { lat: number; lon: number; cell: string };
  version: { seq: number };
}

export interface ExchangeMatchView {
  id: string;
  intentTitle: string;
  distanceBand: string;
  explanation: { components: { signal: string; weight: number; value: number; weighted: number }[]; total: number };
  /** Consent-gated: chat becomes available ONLY after explicit acceptance. */
  contact: { state: 'none' | 'requested' | 'accepted' | 'declined'; canRequestContact: boolean; requiresExplicitConsent: true };
}

export interface ExchangePage<T> {
  results: T[];
  cursor: string | null;
  state: 'ok' | 'partial' | 'empty' | 'unavailable' | 'failed';
}

export interface ExchangeApiPort {
  compose(input: ComposeIntentInput): Promise<ExchangeIntentView>;
  listMine(cursor: string | null): Promise<ExchangePage<ExchangeIntentView>>;
  browse(opts: { kind?: 'need' | 'offer' | 'service'; category?: string; cursor?: string | null }): Promise<ExchangePage<ExchangeIntentView>>;
  matchesFor(intentId: string): Promise<ExchangePage<ExchangeMatchView>>;
  transition(id: string, version: number, to: 'active' | 'paused' | 'withdrawn' | 'fulfilled'): Promise<ExchangeIntentView>;
  /** Consent gate: request contact on a match; chat opens only after accept. */
  requestContact(matchId: string): Promise<ExchangeMatchView>;
  report(id: string, reason: string): Promise<void>;
  block(ownerRef: string): Promise<void>;
}
