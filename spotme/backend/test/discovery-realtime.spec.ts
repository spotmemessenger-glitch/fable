/**
 * Checkpoint 9 — realtime contract: minimal payloads (guard-enforced), scoped
 * channels, short-lived bounded claims, disabled default, invalidation events,
 * version-based staleness, and the no-broker/no-package assertions.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertPublishable,
  deriveChannelClaim,
  discoveryCellChannel,
  discoverySelfChannel,
  CLAIM_MAX_CHANNELS,
  CLAIM_TTL_SECONDS,
  DiscoveryRealtimeEvent,
} from '../src/discovery/realtime/realtime.port';
import {
  DisabledDiscoveryRealtimeAdapter,
  InMemoryDiscoveryRealtimeAdapter,
} from '../src/discovery/realtime/realtime.adapters';

const cellCh = discoveryCellChannel('cell-9');
const selfCh = discoverySelfChannel('u1');
const okEvent: DiscoveryRealtimeEvent = { type: 'cell-presence-updated', coarseCell: 'cell-9', visibilityVersion: 3 };

describe('event payload guard (C-RT-MIN)', () => {
  it('accepts the five minimal event shapes on their correct channels', () => {
    expect(() => assertPublishable(cellCh, okEvent)).not.toThrow();
    expect(() => assertPublishable(cellCh, { type: 'cell-presence-expired', coarseCell: 'cell-9', visibilityVersion: 4 })).not.toThrow();
    expect(() => assertPublishable(selfCh, { type: 'self-visibility-changed', userId: 'u1', visibilityVersion: 5 })).not.toThrow();
    expect(() => assertPublishable(selfCh, { type: 'self-projection-updated', userId: 'u1' })).not.toThrow();
    expect(() => assertPublishable(selfCh, { type: 'self-results-invalidated', scope: 'blocks-changed', userId: 'u1' })).not.toThrow();
  });

  it('REFUSES precise coordinates, tokens, profile and message content — even nested', () => {
    const poisoned = [
      { ...okEvent, lat: 12.97 },
      { ...okEvent, coords: { latitude: 1 } },
      { ...okEvent, token: 'abc' },
      { ...okEvent, authorization: 'Bearer x' },
      { ...okEvent, profile: { email: 'a@b.c' } },
      { ...okEvent, message: 'hi' },
      { ...okEvent, note: 'rediss://u:p@dfly.example:6385' },
    ];
    for (const e of poisoned) expect(() => assertPublishable(cellCh, e as never)).toThrow(/forbidden|credentialed|coordinate/);
  });

  it('REFUSES a coordinate carried as a VALUE under an innocent key (6.4)', () => {
    expect(() => assertPublishable(cellCh, { ...okEvent, place: '12.9716,77.5946' } as never)).toThrow(/coordinate/);
    expect(() => assertPublishable(cellCh, { ...okEvent, note: '13.08270N' } as never)).toThrow(/coordinate/);
  });

  it('ROUTING (6.2): a self/userId-bearing event may NEVER publish to a cell channel', () => {
    // The core anti-leak: presence identity can't reach a shared cell channel.
    expect(() => assertPublishable(cellCh, { type: 'self-results-invalidated', scope: 'blocks-changed', userId: 'victim' } as never))
      .toThrow(/leak identity|cell channel/);
    // And a self event must match its OWN self channel principal.
    expect(() => assertPublishable(discoverySelfChannel('someone-else'), { type: 'self-visibility-changed', userId: 'u1', visibilityVersion: 1 }))
      .toThrow(/must equal its self channel/);
    // A cell event carries no userId at the type level — nothing to leak.
    expect('userId' in okEvent).toBe(false);
  });
});

describe('channels and claims (T-RTABUSE)', () => {
  it('claims are short-lived, bounded, and derived from AUTHORITATIVE cells (6.1)', () => {
    const claim = deriveChannelClaim('me', ['cell-1', 'cell-2', 'cell-2', 'cell-3', 'cell-4', 'cell-5'], 1000);
    expect(claim.sub).toBe('me');
    expect(claim.exp).toBe(1000 + CLAIM_TTL_SECONDS);
    expect(claim.channels.length).toBeLessThanOrEqual(CLAIM_MAX_CHANNELS);
    expect(claim.channels[0]).toBe(discoverySelfChannel('me'));
    // The claim can ONLY contain the authoritative cells it was given + self —
    // it never invents or widens to a cell outside that set.
    const granted = claim.channels.slice(1).map((c) => c.replace('discovery:cell:', ''));
    for (const g of granted) expect(['cell-1', 'cell-2', 'cell-3', 'cell-4', 'cell-5']).toContain(g);
    for (const ch of claim.channels.slice(1)) expect(ch).toMatch(/^discovery:cell:/);
  });

  it('there is no channel constructor for another user\'s state', () => {
    expect(discoveryCellChannel('cell-1')).toBe('discovery:cell:cell-1');
    expect(discoverySelfChannel('me')).toBe('discovery:self:me');
    // The module exports exactly these two channel families.
    const src = readFileSync(join(__dirname, '../src/discovery/realtime/realtime.port.ts'), 'utf8');
    const families = [...new Set(src.match(/discovery:[a-z]+:/g))].sort();
    expect(families).toEqual(['discovery:cell:', 'discovery:self:']);
  });
});

describe('adapters', () => {
  it('DEFAULT (disabled): validates then drops; never enabled; no broker touched', async () => {
    const d = new DisabledDiscoveryRealtimeAdapter();
    expect(d.enabled()).toBe(false);
    expect(await d.publish(cellCh, okEvent)).toEqual({ ok: false });
    await expect(d.publish(cellCh, { ...okEvent, lat: 1 } as never)).rejects.toThrow();
  });

  it('results invalidation routes to the affected principal\'s OWN self channel (finding F7/6.7)', async () => {
    const m = new InMemoryDiscoveryRealtimeAdapter();
    await m.publish(discoverySelfChannel('victim'), { type: 'self-results-invalidated', scope: 'blocks-changed', userId: 'victim' });
    await m.publish(discoverySelfChannel('gone'), { type: 'self-results-invalidated', scope: 'user-deleted', userId: 'gone' });
    expect(m.published.map((p) => (p.event.type === 'self-results-invalidated' ? p.event.scope : ''))).toEqual([
      'blocks-changed',
      'user-deleted',
    ]);
    // Publishing that same event to a CELL channel is refused (would leak).
    await expect(m.publish(cellCh, { type: 'self-results-invalidated', scope: 'blocks-changed', userId: 'victim' } as never)).rejects.toThrow();
  });

  it('C-REPLAY (6.3): a stale/replayed version is DROPPED at publish, not merely droppable by consumers', async () => {
    const m = new InMemoryDiscoveryRealtimeAdapter();
    expect(await m.publish(cellCh, { type: 'cell-presence-updated', coarseCell: 'cell-9', visibilityVersion: 2 })).toEqual({ ok: true });
    expect(await m.publish(cellCh, { type: 'cell-presence-updated', coarseCell: 'cell-9', visibilityVersion: 5 })).toEqual({ ok: true });
    // A replayed v3 after v5 is refused by the server.
    expect(await m.publish(cellCh, { type: 'cell-presence-expired', coarseCell: 'cell-9', visibilityVersion: 3 })).toEqual({ ok: false });
    expect(m.latestVersion(cellCh)).toBe(5);
    expect(m.published.filter((p) => p.channel === cellCh)).toHaveLength(2); // the stale one never landed
  });
});

describe('no broker, no package, no startup activity', () => {
  it('no centrifugo/centrifuge package is a backend dependency', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(Object.keys(all).some((k) => /centrifug/i.test(k))).toBe(false);
  });

  it('no discovery realtime file opens a connection or imports a broker client', () => {
    for (const f of ['realtime.port.ts', 'realtime.adapters.ts']) {
      const src = readFileSync(join(__dirname, `../src/discovery/realtime/${f}`), 'utf8');
      expect(src).not.toMatch(/require\(['"](centrifug|ioredis|ws|socket)/);
      expect(src).not.toMatch(/from ['"](centrifug|ioredis|ws|socket)/);
      expect(src).not.toMatch(/new WebSocket|connect\(/);
    }
  });
});
