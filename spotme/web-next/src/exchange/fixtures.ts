/**
 * Deterministic fixture Exchange API (Phase 3D) — the only ExchangeApiPort this
 * phase. No network. Records everything that "left" through the port for the
 * privacy mutation battery.
 */

import type {
  ComposeIntentInput,
  ExchangeApiPort,
  ExchangeIntentView,
  ExchangeMatchView,
  ExchangePage,
} from './ports';

export class FixtureExchangeApi implements ExchangeApiPort {
  readonly outbound: string[] = [];
  offline = false;
  unavailable = false;

  private record(op: string, payload: unknown) {
    this.outbound.push(JSON.stringify({ op, payload }));
    if (this.offline) throw new TypeError('network request failed');
  }

  async compose(input: ComposeIntentInput): Promise<ExchangeIntentView> {
    this.record('compose', input);
    return {
      id: 'fx-intent-1', kind: input.kind, status: 'active', category: input.category,
      title: input.title, text: input.text, tags: input.tags,
      budgetBand: input.budgetBand,
      ...(input.informationalPrice ? { informationalPrice: { label: input.informationalPrice, disclaimer: 'informational-only-no-payment' as const } } : {}),
      approxLocation: { lat: input.origin.lat, lon: input.origin.lon, cell: input.origin.cell ?? 'g' },
      version: { seq: 1 },
    };
  }

  async listMine(cursor: string | null): Promise<ExchangePage<ExchangeIntentView>> {
    this.record('listMine', { cursor });
    return { results: [this.mineFixture()], cursor: null, state: 'ok' };
  }

  async browse(opts: { kind?: 'need' | 'offer' | 'service'; category?: string; cursor?: string | null }): Promise<ExchangePage<ExchangeIntentView>> {
    this.record('browse', opts);
    if (this.unavailable) return { results: [], cursor: null, state: 'unavailable' };
    return { results: [this.mineFixture('fx-other-1', 'offer')], cursor: null, state: 'ok' };
  }

  async matchesFor(intentId: string): Promise<ExchangePage<ExchangeMatchView>> {
    this.record('matchesFor', { intentId });
    return { results: [this.matchFixture()], cursor: null, state: 'ok' };
  }

  async transition(id: string, version: number, to: 'active' | 'paused' | 'withdrawn' | 'fulfilled'): Promise<ExchangeIntentView> {
    this.record('transition', { id, version, to });
    return { ...this.mineFixture(id), status: to === 'fulfilled' ? 'fulfilled' : to === 'withdrawn' ? 'withdrawn' : to, version: { seq: version + 1 } };
  }

  async requestContact(matchId: string): Promise<ExchangeMatchView> {
    this.record('requestContact', { matchId });
    // The fixture recipient has NOT accepted — state moves to 'requested', not
    // 'accepted'; chat stays unavailable until an explicit accept.
    return { ...this.matchFixture(matchId), contact: { state: 'requested', canRequestContact: false, requiresExplicitConsent: true } };
  }

  async report(id: string, reason: string): Promise<void> { this.record('report', { id, reason }); }
  async block(ownerRef: string): Promise<void> { this.record('block', { ownerRef }); }

  private mineFixture(id = 'fx-intent-1', kind: 'need' | 'offer' | 'service' = 'need'): ExchangeIntentView {
    return {
      id, kind, status: 'active', category: 'services/plumbing', title: 'Leaking tap',
      text: 'Kitchen tap leaks tonight', tags: ['plumbing'], budgetBand: 'low',
      informationalPrice: { label: '~₹500', disclaimer: 'informational-only-no-payment' },
      approxLocation: { lat: 12.972, lon: 77.595, cell: 'g12.972:77.595' }, version: { seq: 1 },
    };
  }
  private matchFixture(id = 'fx-match-1'): ExchangeMatchView {
    return {
      id, intentTitle: 'Evening plumber', distanceBand: 'under1km',
      explanation: { components: [{ signal: 'intentFit', weight: 0.35, value: 0.9, weighted: 0.315 }, { signal: 'proximity', weight: 0.25, value: 0.75, weighted: 0.1875 }], total: 0.5025 },
      contact: { state: 'none', canRequestContact: true, requiresExplicitConsent: true },
    };
  }
}
