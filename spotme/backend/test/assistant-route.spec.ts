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

describe('validateRouteOrigin (X6)', () => {
  it('accepts the coarse public grid and place references', () => {
    expect(validateRouteOrigin(coarse)).toBe(coarse);
    expect(validateRouteOrigin(placeRef)).toBe(placeRef);
  });

  it('THROWS on device-precision coordinates — never rounds a leak into silence', () => {
    for (const [lat, lon] of [[12.9716123, 77.595], [12.972, 77.5946098], [12.97161, 77.59461]]) {
      expect(codeOf(() => validateRouteOrigin({ kind: 'coarse', origin: { lat, lon } })))
        .toBe('precise-route-origin');
    }
  });

  it('THROWS on out-of-range or malformed origins', () => {
    expect(codeOf(() => validateRouteOrigin({ kind: 'coarse', origin: { lat: 91, lon: 0 } })))
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

  it('a precise origin cannot reach the provider path', () => {
    expect(codeOf(() => buildProviderRoute(
      { kind: 'coarse', origin: { lat: 12.9716123, lon: 77.5946098 } }, [candidate], [legRecord()])))
      .toBe('precise-route-origin');
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

  it('THROWS on a precise origin or destination', () => {
    expect(codeOf(() => buildStraightLineEstimate(
      { kind: 'coarse', origin: { lat: 12.9716123, lon: 77.595 } }, { lat: 12.982, lon: 77.605 })))
      .toBe('precise-route-origin');
    expect(codeOf(() => buildStraightLineEstimate(coarse, { lat: 12.9812345, lon: 77.605 })))
      .toBe('precise-route-origin');
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
