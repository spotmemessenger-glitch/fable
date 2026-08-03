/**
 * The ONLY place adapters that exist this phase (checkpoint 7):
 *  - DeterministicInMemoryPlaceAdapter — a seeded fixture set for tests and
 *    dark development; fully deterministic, no network, no key.
 *  - UnavailablePlaceAdapter — the deterministic fallback: every call answers
 *    with the typed 'provider-unavailable' state.
 * No production provider, no API key, no network activation (C-NONET).
 */

import { Injectable } from '@nestjs/common';
import {
  CoarseOrigin,
  DirectionsHandoff,
  DirectionsPort,
  NormalizedPlace,
  PlaceDetailsPort,
  PlaceDetailsResult,
  PlaceSearchPort,
  PlaceSearchResult,
} from './place.ports';
import { normalizeProviderPlace, straightLineLabel, straightLineM } from './place.normalize';

/** Deterministic fixture records — run through the SAME normalizer real
 *  providers will use, so the fixture can never be laxer than production. */
const FIXTURES: unknown[] = [
  { id: 'fx-cafe-1', name: 'Cubbon Coffee House', category: 'cafe', lat: 12.973, lon: 77.59, openNow: true, localityLabel: 'Cubbon' },
  { id: 'fx-cafe-2', name: 'Riverside Beans', category: 'cafe', lat: 12.98, lon: 77.6, localityLabel: 'Riverside' }, // openNow UNKNOWN
  { id: 'fx-hosp-1', name: 'Lakeview Orthopaedic Hospital', category: 'hospital', lat: 12.95, lon: 77.58, openNow: true, localityLabel: 'Lakeview' },
  { id: 'fx-rest-1', name: 'Green Leaf Vegetarian Restaurant', category: 'restaurant', lat: 12.965, lon: 77.585, openNow: false, localityLabel: 'Central' },
];

const SOURCE = { provider: 'in-memory-fixture', attribution: 'Deterministic Test Fixture Data' };

@Injectable()
export class DeterministicInMemoryPlaceAdapter implements PlaceSearchPort, PlaceDetailsPort {
  readonly name = 'in-memory-fixture';
  private readonly places: NormalizedPlace[];

  constructor(rawFixtures: unknown[] = FIXTURES) {
    this.places = rawFixtures
      .map((r) => normalizeProviderPlace(r, SOURCE))
      .filter((p): p is NormalizedPlace => p !== null);
  }

  async searchPlaces(q: { text?: string; category?: string; openNow?: boolean; origin: CoarseOrigin; radiusKm: number; limit: number }): Promise<PlaceSearchResult> {
    const text = (q.text ?? '').toLowerCase();
    let out = this.places.filter((p) => {
      if (q.category && p.category !== q.category) return false;
      if (text && !`${p.name} ${p.category ?? ''} ${p.localityLabel ?? ''}`.toLowerCase().includes(text)) return false;
      if (straightLineM(q.origin, p) > q.radiusKm * 1000) return false;
      // A8: openNow filters ONLY records with known hours; unknown (null) is
      // EXCLUDED by an open-now filter rather than assumed open.
      if (q.openNow === true && p.openNow !== true) return false;
      return true;
    });
    out = out
      .sort((a, b) => straightLineM(q.origin, a) - straightLineM(q.origin, b) || a.placeId.localeCompare(b.placeId))
      .slice(0, q.limit);
    return out.length ? { state: 'ok', places: out } : { state: 'no-results' };
  }

  async getDetails(placeId: string): Promise<PlaceDetailsResult> {
    const place = this.places.find((p) => p.placeId === placeId);
    if (!place) return { state: 'not-found' };
    // Unknown detail fields stay null — the fixture invents nothing (P4).
    return { state: 'ok', place, details: { hoursText: null, phone: null, website: null } };
  }
}

@Injectable()
export class UnavailablePlaceAdapter implements PlaceSearchPort, PlaceDetailsPort {
  readonly name = 'unavailable';
  async searchPlaces(): Promise<PlaceSearchResult> {
    return { state: 'provider-unavailable', provider: this.name };
  }
  async getDetails(): Promise<PlaceDetailsResult> {
    return { state: 'provider-unavailable', provider: this.name };
  }
}

@Injectable()
export class StraightLineDirectionsAdapter implements DirectionsPort {
  readonly name = 'straight-line-handoff';
  /** NEVER a route, travel time, or road distance — a labeled straight line
   *  plus an external-navigator handoff is ALL this port produces (P4). */
  handoff(origin: CoarseOrigin, dest: { lat: number; lon: number; name: string }): DirectionsHandoff {
    const m = straightLineM(origin, dest);
    return {
      kind: 'external-handoff',
      straightLineM: m,
      straightLineLabel: straightLineLabel(m),
      destination: dest,
    };
  }
}
