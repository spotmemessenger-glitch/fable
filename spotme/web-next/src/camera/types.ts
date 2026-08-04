/**
 * Camera engine core types (Stage 1 C2) — the two shapes that flow through
 * every algorithm, ported from the CAM-1 engine (#56, read-only source):
 *
 *   RgbaImage { data: Uint8ClampedArray, width, height }  — RGBA bytes
 *   LumaPlane { data: Float32Array, width, height }       — one channel, 0..1
 *
 * Everything downstream is PURE (fresh buffers, inputs untouched) and
 * dependency-free — which is what lets the golden-vector tests pin exact
 * numbers in Node/jsdom exactly as they did on the source branch.
 */

export interface RgbaImage {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export interface LumaPlane {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
}

/** A shift estimate in full-resolution pixels. */
export interface ShiftEstimate {
  readonly dx: number;
  readonly dy: number;
  readonly confidence: number;
  readonly flat?: boolean;
}

/** The CAM availability idiom, typed: available payload or a named refusal
 *  drawn from the closed contract vocabulary. */
import type { CaptureUnavailableReason } from '@spotme/contracts';

export type Availability<T> =
  | ({ readonly available: true } & T)
  | { readonly available: false; readonly reason: CaptureUnavailableReason; readonly detail: string };

export function available<T>(payload: T): Availability<T> {
  return { available: true, ...payload };
}

export function unavailable<T = never>(reason: CaptureUnavailableReason, detail: string): Availability<T> {
  return { available: false, reason, detail };
}
