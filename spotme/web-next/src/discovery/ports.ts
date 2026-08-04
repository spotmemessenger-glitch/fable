/**
 * Client-side ports for the Discovery experience (checkpoints 10/11).
 *
 * Every capability the UI needs sits behind a port with a deterministic test
 * double, so components never fetch, never touch geolocation, never talk to a
 * map SDK, and never open a socket (P9/P10). Precise device location exists
 * ONLY behind GeolocationPort in device-local memory; the application layer
 * converts it to the branded coarse contract before ANY outbound call
 * (checkpoint 11 mutation tests prove raw coordinates never escape).
 */

import type {
  CoarsePublicLocation,
  DiscoveryQuery,
  DiscoveryResultPage,
  VisibilityPreference,
} from '@spotme/contracts';

/** A precise device fix — NEVER leaves the client boundary (ADR-019). */
export interface DeviceFix {
  lat: number;
  lon: number;
  accuracyM?: number;
}

export type GeolocationOutcome =
  | { state: 'ok'; fix: DeviceFix }
  | { state: 'permission-required' }
  | { state: 'unavailable'; reason: string };

export interface GeolocationPort {
  getFix(): Promise<GeolocationOutcome>;
}

/** The ONLY outbound surface. Origins are already-coarse by type (P2). */
export interface DiscoveryApiPort {
  query(q: DiscoveryQuery, signal?: AbortSignal): Promise<DiscoveryResultPage>;
  setVisibility(v: { enabled: boolean; origin: CoarsePublicLocation | null; expiresInMinutes: number }): Promise<VisibilityPreference>;
}

/** Map rendering behind a port — no production map SDK exists in this phase. */
export interface MapMarker {
  id: string;
  lat: number;
  lon: number;
  kind: 'person' | 'place' | 'self';
  approximate: boolean;
  selected: boolean;
  /** Human-readable label for the accessible name — a display name, never a
   *  raw id (F7-2). Falls back to the kind when absent. */
  label?: string;
}

export interface MapPort {
  render(markers: MapMarker[], center: { lat: number; lon: number } | null): void;
  onMarkerSelect(cb: (id: string) => void): void;
}

export interface RealtimePort {
  /** Disabled by default — mirrors the server posture (checkpoint 9). */
  enabled(): boolean;
  onInvalidated(cb: () => void): void;
}

export interface ClockPort {
  now(): number;
}

/* ------------------------------------------------------------------ *
 * Deterministic doubles (the only implementations this phase)
 * ------------------------------------------------------------------ */

/** Deterministic map renderer: records what it was asked to draw. */
export class DeterministicMapRenderer implements MapPort {
  lastMarkers: MapMarker[] = [];
  lastCenter: { lat: number; lon: number } | null = null;
  private selectCb: ((id: string) => void) | null = null;

  render(markers: MapMarker[], center: { lat: number; lon: number } | null): void {
    this.lastMarkers = markers;
    this.lastCenter = center;
  }
  onMarkerSelect(cb: (id: string) => void): void {
    this.selectCb = cb;
  }
  /** Test/UI hook: simulate a marker tap. */
  simulateSelect(id: string): void {
    this.selectCb?.(id);
  }
}

export class FixedClock implements ClockPort {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class DisabledRealtime implements RealtimePort {
  enabled(): boolean {
    return false;
  }
  onInvalidated(): void {
    /* never fires while disabled */
  }
}
