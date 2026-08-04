/**
 * Phase 6C — route phase-1 (X6). A precise device origin THROWS (never
 * rounded into silence); provider legs are attributed passthrough citing
 * CURRENT route-leg evidence; absent provider numbers stay null (never
 * computed); the straight-line fallback carries its fixed label and has no
 * duration field to fake an ETA with.
 */

import { AssistantError } from '../src/assistant/assistant.errors';
import {
  buildProviderRoute, buildStraightLineEstimate, validateRouteOrigin,
} from '../src/assistant/assistant.route';
import { FixtureRouteEvidence } from '../src/assistant/assistant.fixtures';
import { mintEvidenceRecord } from '../src/assistant/assistant.evidence';
import type { EvidenceRecord, RouteOrigin } from '../src/assistant/assistant.types';

const coarse: RouteOrigin = { kind: 'coarse', origin: { lat: 12.972, lon: 77.595 } };
const placeRef: RouteOrigin = { kind: 'place-ref', placeRefId: 'place:library' };

const legRecord = (over: Record<string, unknown> = {}): EvidenceRecord => mintEvidenceRecord({
  id: 'ev:leg:1', sourceId: 'fixture:routes', sourceType: 'fixture',
  licenseClass: 'licensed-provider', category: 'route-leg', retrievedAtUTC: 1000,
  sourceUpdatedAtUTC: null, freshness: 'current', contentRef: 'ref:leg:1',
  integrityDigest: 'sha256:abcd', attributionLabel: 'Fixture Routes',
  permittedUse: 'display-with-attribution', ...over,
});

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (e) { if (e instanceof AssistantError) return e.code; throw e; }
  throw new Error('expected throw');
};

describe('validateRouteOrigin (X6, F1 quantizing model)', () => {
  it('passes grid values through unchanged in value, and place references as-is', () => {
    const checked = validateRouteOrigin(coarse);
    if (checked.kind !== 'coarse') throw new Error('expected coarse');
    expect(checked.origin).toEqual({ lat: 12.972, lon: 77.595 });
    expect(validateRouteOrigin(placeRef)).toBe(placeRef);
  });

  it('QUANTIZES device-precision coordinates to the public grid — nothing finer survives (F1)', () => {
    const checked = validateRouteOrigin({ kind: 'coarse', origin: { lat: 12.9716123, lon: 77.5946098 } });
    if (checked.kind !== 'coarse') throw new Error('expected coarse');
    expect(checked.origin).toEqual({ lat: 12.972, lon: 77.595 });
    // The precise digits are unrecoverable from what leaves the boundary.
    expect(JSON.stringify(checked)).not.toContain('12.9716123');
    expect(JSON.stringify(checked)).not.toContain('77.5946098');
  });

  it("F1 regression: the client's JITTERED coarse output is accepted, not rejected", () => {
    // coarsenForPublic = 3-decimal grid + per-identity jitter (±0.0009°);
    // the old exact-grid check rejected 100% of this legitimate traffic.
    const jittered = { lat: 12.972 + 0.00072, lon: 77.595 - 0.00054 };
    const checked = validateRouteOrigin({ kind: 'coarse', origin: jittered });
    if (checked.kind !== 'coarse') throw new Error('expected coarse');
    expect(Math.abs(checked.origin.lat - 12.972)).toBeLessThanOrEqual(0.0011); // one grid cell + float noise
    expect(Number.isInteger(checked.origin.lat * 1000 + Number.EPSILON) ||
      Math.abs(Math.round(checked.origin.lat * 1000) - checked.origin.lat * 1000) < 1e-6).toBe(true);
  });

  it('F1 regression: float-hostile grid values (e.g. 32.331) are no longer falsely rejected', () => {
    for (const lat of [32.331, -16.092, 32.608, -65.514]) {
      const checked = validateRouteOrigin({ kind: 'coarse', origin: { lat, lon: 77.595 } });
      if (checked.kind !== 'coarse') throw new Error('expected coarse');
      expect(checked.origin.lat).toBeCloseTo(lat, 6);
    }
  });

  it('THROWS on out-of-range or malformed origins', () => {
    expect(codeOf(() => validateRouteOrigin({ kind: 'coarse', origin: { lat: 91, lon: 0 } })))
      .toBe('malformed-evidence');
    expect(codeOf(() => validateRouteOrigin({ kind: 'coarse', origin: { lat: Number.NaN, lon: 0 } })))
      .toBe('malformed-evidence');
    expect(codeOf(() => validateRouteOrigin({ kind: 'place-ref', placeRefId: '' })))
      .toBe('malformed-evidence');
  });
});

describe('buildProviderRoute (X6 passthrough)', () => {
  const candidate = {
    mode: 'walk' as const, providerDistanceM: 850, providerDurationS: 660,
    attribution: 'Fixture Routes', citationId: 'ev:leg:1',
  };

  it('passes provider numbers through attributed, with a resolving CURRENT citation', () => {
    const advice = buildProviderRoute(coarse, [candidate], [legRecord()]);
    expect(advice.kind).toBe('provider-route');
    if (advice.kind !== 'provider-route') return;
    expect(advice.legs[0]).toEqual({
      mode: 'walk', providerDistanceM: 850, providerDurationS: 660,
      attribution: 'Fixture Routes', citationId: 'ev:leg:1',
    });
    expect(advice.sources[0].id).toBe('ev:leg:1');
  });

  it('absent provider numbers stay NULL — nothing is computed the provider did not supply', () => {
    const advice = buildProviderRoute(coarse,
      [{ ...candidate, providerDistanceM: undefined, providerDurationS: undefined }], [legRecord()]);
    if (advice.kind !== 'provider-route') throw new Error('expected route');
    expect(advice.legs[0].providerDistanceM).toBeNull();
    expect(advice.legs[0].providerDurationS).toBeNull();
  });

  it('REFUSES stale route-leg evidence (X4) and unresolved/miscategorized citations (X3)', () => {
    expect(codeOf(() => buildProviderRoute(coarse, [candidate], [legRecord({ freshness: 'stale' })])))
      .toBe('stale-current-state');
    expect(codeOf(() => buildProviderRoute(coarse, [candidate], [])))
      .toBe('citation-unresolved');
    expect(codeOf(() => buildProviderRoute(coarse, [candidate], [legRecord({ category: 'place-name' })])))
      .toBe('citation-unresolved');
  });

  it('REFUSES a missing attribution — passthrough is attributed or it is nothing', () => {
    expect(codeOf(() => buildProviderRoute(coarse, [{ ...candidate, attribution: '' }], [legRecord()])))
      .toBe('malformed-evidence');
  });

  it('a precise origin cannot reach the provider path — quantized before the adapter (F1)', () => {
    const advice = buildProviderRoute(
      { kind: 'coarse', origin: { lat: 12.9716123, lon: 77.5946098 } }, [candidate], [legRecord()]);
    if (advice.kind !== 'provider-route') throw new Error('expected route');
    expect(advice.origin).toEqual({ kind: 'coarse', origin: { lat: 12.972, lon: 77.595 } });
    expect(JSON.stringify(advice)).not.toContain('9716123');
    expect(JSON.stringify(advice)).not.toContain('5946098');
  });
});

describe('buildStraightLineEstimate (X6 fallback)', () => {
  it('carries the FIXED label and a distance — the shape has no duration/ETA field', () => {
    const advice = buildStraightLineEstimate(coarse, { lat: 12.982, lon: 77.605 });
    expect(advice.kind).toBe('straight-line');
    if (advice.kind !== 'straight-line') return;
    expect(advice.estimate.label).toBe('straight-line estimate');
    expect(advice.estimate.distanceM).toBeGreaterThan(1000);
    expect(advice.estimate.distanceM).toBeLessThan(2500);
    expect((advice.estimate as unknown as Record<string, unknown>).durationS).toBeUndefined();
    expect(JSON.stringify(advice)).not.toMatch(/duration|eta/i);
  });

  it('QUANTIZES a precise origin/destination — the estimate carries only grid values (F1)', () => {
    const advice = buildStraightLineEstimate(
      { kind: 'coarse', origin: { lat: 12.9716123, lon: 77.595 } }, { lat: 12.9812345, lon: 77.605 });
    if (advice.kind !== 'straight-line') throw new Error('expected estimate');
    expect(advice.origin).toEqual({ kind: 'coarse', origin: { lat: 12.972, lon: 77.595 } });
    expect(JSON.stringify(advice)).not.toContain('9716123');
    expect(JSON.stringify(advice)).not.toContain('9812345');
    // The quantized estimate matches the grid-value computation.
    const grid = buildStraightLineEstimate(coarse, { lat: 12.981, lon: 77.605 });
    if (grid.kind !== 'straight-line') throw new Error('expected estimate');
    expect(advice.estimate.distanceM).toBe(grid.estimate.distanceM);
  });

  it('THROWS on an out-of-range destination', () => {
    expect(codeOf(() => buildStraightLineEstimate(coarse, { lat: 120, lon: 77.605 })))
      .toBe('malformed-evidence');
  });

  it('is honestly unavailable from a place-ref origin (no coordinates in phase-1)', () => {
    expect(buildStraightLineEstimate(placeRef, { lat: 12.982, lon: 77.605 }))
      .toEqual({ kind: 'unavailable', reason: 'provider-unconfigured' });
  });
});

describe('FixtureRouteEvidence (test-only adapter)', () => {
  it('answers a provider route for the known destination and unavailable otherwise', async () => {
    const fixture = new FixtureRouteEvidence();
    const advice = await fixture.advise(coarse, 'place:cafe-azul');
    expect(advice.kind).toBe('provider-route');
    expect(await fixture.advise(coarse, 'place:unknown'))
      .toEqual({ kind: 'unavailable', reason: 'provider-unconfigured' });
  });

  it('refuses to construct outside a test environment', () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new FixtureRouteEvidence()).toThrow(AssistantError);
    } finally {
      process.env.NODE_ENV = prior;
    }
  });
});
