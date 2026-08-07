/**
 * Checkpoint 13 — web-next performance measurements.
 *
 * OFF BY DEFAULT (loud skip): run with RUN_DISCOVERY_BENCH=1. These numbers
 * come from jsdom under vitest — an approximation that EXCLUDES real browser
 * layout/paint, so they are honest upper bounds on JS work only (the doc that
 * quotes them carries the same caveat). Rendering uses the real components;
 * state updates use the real DiscoveryController with the fixture port.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, cleanup } from '@testing-library/react';
import { DiscoveryController, MemoryCache } from '../discovery/controller';
import { FixtureDiscoveryApi } from '../discovery/fixtures';
import { DisabledRealtime, FixedClock } from '../discovery/ports';
import type { GeolocationPort } from '../discovery/ports';
import { ResultList, StateBanner } from '../discovery/components';
import type { DiscoveryResult, DiscoveryResultPage } from '@spotme/contracts';

// web-next's tsconfig is browser-lib only; vitest still provides process.env.
declare const process: { env: Record<string, string | undefined>; stdout: { write(s: string): void } };

const enabled = process.env.RUN_DISCOVERY_BENCH === '1';
const bench = enabled ? describe : describe.skip;
if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn('[discovery-perf] SKIPPED — set RUN_DISCOVERY_BENCH=1 to measure web-next timings.');
}

const geo: GeolocationPort = { getFix: async () => ({ state: 'ok', fix: { lat: 12.9716, lon: 77.5946 } }) };

function pct(samples: number[], p: number): number {
  const s = [...samples].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] * 100) / 100;
}

bench('web-next discovery timings (jsdom — JS work only)', () => {
  it('controller full search cycle (fixture API): p50/p95 over 200 iterations', async () => {
    const controller = new DiscoveryController({
      api: new FixtureDiscoveryApi(),
      geo,
      realtime: new DisabledRealtime(),
      clock: new FixedClock(Date.parse('2026-08-03T18:10:00Z')),
      cache: new MemoryCache(),
      selfId: 'perf-self',
    });
    const samples: number[] = [];
    for (let i = 0; i < 200; i++) {
      const t0 = performance.now();
      await controller.search();
      samples.push(performance.now() - t0);
    }
    process.stdout.write(`PERF controllerSearchCycleMs p50=${pct(samples, 50)} p95=${pct(samples, 95)} runs=${samples.length}` + "\n");
    expect(controller.getState().kind).toBe('ready');
  });

  it('state-update fanout: 1000 subscriber notifications', async () => {
    const controller = new DiscoveryController({
      api: new FixtureDiscoveryApi(),
      geo,
      realtime: new DisabledRealtime(),
      clock: new FixedClock(Date.parse('2026-08-03T18:10:00Z')),
      cache: new MemoryCache(),
      selfId: 'perf-self',
    });
    let notified = 0;
    for (let i = 0; i < 50; i++) controller.subscribe(() => { notified += 1; });
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) controller.select(`id-${i}`);
    const total = performance.now() - t0;
    process.stdout.write(`PERF stateFanout 1000 updates x 50 subscribers totalMs=${Math.round(total * 100) / 100} notifications=${notified}` + "\n");
    expect(notified).toBe(50_000);
  });

  it('ResultList render with a full page (30 results): p50/p95 over 50 mounts', async () => {
    const api = new FixtureDiscoveryApi();
    const controller = new DiscoveryController({
      api,
      geo,
      realtime: new DisabledRealtime(),
      clock: new FixedClock(Date.parse('2026-08-03T18:10:00Z')),
      cache: new MemoryCache(),
      selfId: 'perf-self',
    });
    await controller.search();
    const state = controller.getState();
    if (state.kind !== 'ready') throw new Error('fixture search did not reach ready');
    // Pad the fixture page to a FULL page of 30 (the policy max page size).
    const base = state.page.results;
    const results: DiscoveryResult[] = Array.from({ length: 30 }, (_, i) => {
      const r = base[i % base.length];
      return r.type === 'place'
        ? { ...r, place: { ...r.place, placeId: `${r.place.placeId}-${i}` } }
        : { ...r, person: { ...r.person, userId: `${r.person.userId}-${i}` } };
    });
    const page: DiscoveryResultPage = { ...state.page, results };

    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      render(
        createElement(ResultList, {
          results: page.results,
          selectedId: null,
          onSelect: () => undefined,
          onFriendRequest: () => undefined,
          onBlock: () => undefined,
          onReport: () => undefined,
          onHide: () => undefined,
          onDirections: () => undefined,
          onSave: () => undefined,
        }),
      );
      samples.push(performance.now() - t0);
      cleanup();
    }
    process.stdout.write(`PERF resultListMount30Ms p50=${pct(samples, 50)} p95=${pct(samples, 95)} runs=${samples.length}` + "\n");
    expect(samples.length).toBe(50);
  });

  it('StateBanner mount across all transient states: p50 over 50 mounts', () => {
    const states = [
      { kind: 'locating' as const },
      { kind: 'permission-required' as const },
      { kind: 'offline' as const },
      { kind: 'empty' as const, radius: { km: 2 }, suggestion: 'try later' },
    ];
    const samples: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now();
      for (const s of states) {
        render(createElement(StateBanner, { state: s, onRetry: () => undefined, onEnableLocation: () => undefined }));
        cleanup();
      }
      samples.push(performance.now() - t0);
    }
    process.stdout.write(`PERF stateBanner4StatesMs p50=${pct(samples, 50)} p95=${pct(samples, 95)} runs=${samples.length}` + "\n");
    expect(samples.length).toBe(50);
  });
});
