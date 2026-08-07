/**
 * Slice 5 — privacy-mutation battery for Discovery LIVE (ADR-024, ADR-035
 * §(f) #4: surfaces touching location carry one of these).
 *
 * The contract under test: NO coordinate — precise or coarse, mine or
 * theirs — exists anywhere in this package. Positions arrive only as
 * formatted labels, approximate metres, and RELATIVE offsets. These tests
 * mutate the boundary in the ways a regression would, and fail if any
 * coordinate-shaped value survives into the type surface, the source, or
 * the rendered DOM.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { DiscoveryLiveShell } from '../discovery-live/DiscoveryLiveShell';
import { fixtureDiscoveryPort } from '../discovery-live/ports';

afterEach(cleanup);

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..', 'discovery-live');
const sources = readdirSync(PKG).map((f) => ({ f, body: readFileSync(join(PKG, f), 'utf8') }));

// A precise fix a phone would report — the exact strings must never render.
const PRECISE_LAT = 12.971598;
const PRECISE_LON = 77.594566;

describe('discovery-live privacy battery', () => {
  it('no source file names an absolute-coordinate field or geolocation API', () => {
    for (const { f, body } of sources) {
      const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      expect(/\b(latitude|longitude|geolocation|getCurrentPosition|watchPosition)\b/i.test(code),
        `${f} must not touch coordinates or geolocation`).toBe(false);
      // lat/lon as identifiers (word-bounded, not in words like "latest")
      expect(/\b(lat|lon|lng)\s*[:=]/.test(code), `${f} must not carry lat/lon fields`).toBe(false);
    }
  });

  it('no source file touches storage or the network (fence restated locally)', () => {
    for (const { f, body } of sources) {
      expect(/\b(localStorage|sessionStorage|indexedDB|document\.cookie|fetch\s*\(|XMLHttpRequest|WebSocket)\b/.test(body),
        `${f} must not persist or fetch`).toBe(false);
    }
  });

  it('a hostile port smuggling coordinates in extra fields never gets them rendered', () => {
    // Mutation: a regressed adapter starts passing raw coordinates alongside
    // the sanctioned fields. The shell must render none of them — it can only
    // render fields it knows, so the precise strings must not appear in DOM.
    const port = fixtureDiscoveryPort();
    const snap = port.snapshot();
    // Memoized: useSyncExternalStore requires a stable snapshot object.
    const smuggled = {
      ...snap,
      peers: snap.peers.map((p) => ({
        ...p,
        lat: PRECISE_LAT, lon: PRECISE_LON,
        position: { lat: PRECISE_LAT, lon: PRECISE_LON },
      })),
    };
    const hostile = { ...port, snapshot: () => smuggled };
    const { container } = render(createElement(DiscoveryLiveShell, { port: hostile }));
    const html = container.innerHTML;
    expect(html.includes(String(PRECISE_LAT))).toBe(false);
    expect(html.includes(String(PRECISE_LON))).toBe(false);
    expect(html.includes('12.97')).toBe(false);
    expect(html.includes('77.59')).toBe(false);
  });

  it('the rendered DOM shows only tilde-approximate distances', () => {
    const { container } = render(createElement(DiscoveryLiveShell, { port: fixtureDiscoveryPort() }));
    const labels = [...container.querySelectorAll('.dl-dpill')].map((n) => n.textContent || '');
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label.startsWith('~')).toBe(true);
  });

  it('marker style positions are pixel offsets, never coordinate-magnitude values', () => {
    const { container } = render(createElement(DiscoveryLiveShell, { port: fixtureDiscoveryPort() }));
    const markers = [...container.querySelectorAll('.dl-mk')];
    expect(markers.length).toBeGreaterThan(0);
    for (const mk of markers) {
      // left/top are calc(50% ± Npx) with |N| clamped to the radar radius.
      const m = /calc\(50% [+-] (\d+(?:\.\d+)?)px\)/.exec((mk as HTMLElement).style.left);
      expect(m).toBeTruthy();
      expect(Number(m![1])).toBeLessThanOrEqual(98);
    }
  });
});
