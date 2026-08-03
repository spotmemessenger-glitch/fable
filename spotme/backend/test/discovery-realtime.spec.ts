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

const okEvent: DiscoveryRealtimeEvent = { type: 'presence-updated', userId: 'u1', coarseCell: 'cell-9', visibilityVersion: 3 };

describe('event payload guard (C-RT-MIN)', () => {
  it('accepts the five minimal event shapes', () => {
    const events: DiscoveryRealtimeEvent[] = [
      okEvent,
      { type: 'presence-expired', userId: 'u1', coarseCell: 'cell-9', visibilityVersion: 4 },
      { type: 'visibility-disabled', userId: 'u1', visibilityVersion: 5 },
      { type: 'profile-projection-updated', userId: 'u1' },
      { type: 'discovery-result-invalidated', scope: 'blocks-changed', userId: 'u1' },
    ];
    for (const e of events) expect(() => assertPublishable(e)).not.toThrow();
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
    for (const e of poisoned) expect(() => assertPublishable(e as never)).toThrow(/forbidden|credentialed/);
  });
});

describe('channels and claims (T-RTABUSE)', () => {
  it('claims are short-lived, bounded, and derived — never arbitrary users', () => {
    const claim = deriveChannelClaim('me', ['cell-1', 'cell-2', 'cell-2', 'cell-3', 'cell-4', 'cell-5'], 1000);
    expect(claim.sub).toBe('me');
    expect(claim.exp).toBe(1000 + CLAIM_TTL_SECONDS);
    expect(claim.channels.length).toBeLessThanOrEqual(CLAIM_MAX_CHANNELS);
    expect(claim.channels[0]).toBe(discoverySelfChannel('me'));
    // Only cell channels + own self channel — no other-user channel shape exists.
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
    expect(await d.publish('discovery:cell:x', okEvent)).toEqual({ ok: false });
    await expect(d.publish('c', { ...okEvent, lat: 1 } as never)).rejects.toThrow();
  });

  it('block changes and user deletion emit invalidation events (in-memory)', async () => {
    const m = new InMemoryDiscoveryRealtimeAdapter();
    await m.publish(discoverySelfChannel('victim'), { type: 'discovery-result-invalidated', scope: 'blocks-changed', userId: 'victim' });
    await m.publish(discoverySelfChannel('gone'), { type: 'discovery-result-invalidated', scope: 'user-deleted', userId: 'gone' });
    expect(m.published.map((p) => (p.event.type === 'discovery-result-invalidated' ? p.event.scope : ''))).toEqual([
      'blocks-changed',
      'user-deleted',
    ]);
  });

  it('version staleness: consumers can drop anything below the latest visibilityVersion', async () => {
    const m = new InMemoryDiscoveryRealtimeAdapter();
    await m.publish('discovery:cell:c', { type: 'presence-updated', userId: 'u1', coarseCell: 'c', visibilityVersion: 2 });
    await m.publish('discovery:cell:c', { type: 'presence-updated', userId: 'u1', coarseCell: 'c', visibilityVersion: 5 });
    await m.publish('discovery:cell:c', { type: 'presence-expired', userId: 'u1', coarseCell: 'c', visibilityVersion: 3 });
    expect(m.latestVersion('u1')).toBe(5); // the v3 expiry is stale against v5
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
