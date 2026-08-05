/**
 * COMPILE-TIME NEGATIVE TESTS for the Camera Stage 1 contracts.
 * Each `@ts-expect-error` asserts the marked assignment DOES NOT compile.
 */

import type {
  BeautyRequest, CapturedMediaRef, CaptureResult, CaptureUnavailableReason,
  CloudConsentContext, EditOp, FaceLandmarks, LookId, ScanResult,
  TextRecognitionResult,
} from '../src/index.ts';

const media: CapturedMediaRef = {
  mediaId: 'm1', kind: 'image', mimeType: 'image/jpeg', width: 1080, height: 1440,
  contentHash: 'sha256:x', captureLabel: 'takePhoto',
};

/* Privacy by absence: NO location field exists on any capture shape. */
export function noLocationOnCapture(m: CapturedMediaRef): void {
  // @ts-expect-error capture media carries no latitude (T-CA-2)
  void m.lat;
  // @ts-expect-error capture media carries no longitude (T-CA-2)
  void m.lon;
  // @ts-expect-error capture media carries no gps blob (T-CA-2)
  void m.gps;
  // @ts-expect-error capture media carries no location object (T-CA-2)
  void m.location;
  // @ts-expect-error capture media carries no exif field — bytes-only until the 5B strip
  void m.exif;
}

/* Honest refusals: unavailable reasons are a closed set. */
// @ts-expect-error 'because' is not a closed refusal reason
export const badReason: CaptureUnavailableReason = 'because';
export const okUnavailable: CaptureResult = { state: 'unavailable', reason: 'no-exposure-control' };
// @ts-expect-error a captured result cannot carry a refusal reason
export const mixedResult: CaptureResult = { state: 'captured', media, reason: 'timeout' };

/* Edit graph: op vocabulary and bounds are closed. */
// @ts-expect-error 'ai-magic' is not an edit op
export const badOp: EditOp = { kind: 'ai-magic', value: 1 };
// @ts-expect-error rotate takes quarter turns only
export const badRotate: EditOp = { kind: 'rotate', quarterTurns: 1.5 };
// @ts-expect-error 'vivid-ai' is not a look id
export const badLook: LookId = 'vivid-ai';

/* Vision: no fabricated success shapes. */
// @ts-expect-error scan detections cannot be empty in a detected result
export const emptyDetect: ScanResult = { state: 'detected', detections: [] };
export const okNone: ScanResult = { state: 'none' };
// @ts-expect-error an OCR result cannot claim recognition from an unknown engine
export const badOcr: TextRecognitionResult = { state: 'recognized', text: 'x', engine: 'gpt-vision' };

/* Beauty: ADVANCED structurally requires the approved landmark engine. */
// @ts-expect-error advanced beauty without the landmark engine cannot type (ADR-014c gate)
export const badBeauty: BeautyRequest = { tier: 'advanced', params: { smooth: 0.5, tone: 0.5, brighten: 0.2 } };
export const badEngine: BeautyRequest = {
  tier: 'advanced', params: { smooth: 0.5, tone: 0.5, brighten: 0.2 },
  // @ts-expect-error only the approved engine literal is nameable
  landmarkEngine: 'some-cdn-model',
};
// @ts-expect-error landmarks cannot come from an unapproved engine
export const badLandmarks: FaceLandmarks = { points: [{ x: 0, y: 0 }], engine: 'box-guesser' };

/* Cloud consent: no global/cached/session consent is representable. */
// @ts-expect-error consent scope is single-request only — no session consent
export const badConsent: CloudConsentContext = { kind: 'cloud-vision-consent', scope: 'session', grantedAtUTC: 1, surface: 's' };
export const okConsent: CloudConsentContext = { kind: 'cloud-vision-consent', scope: 'single-request', grantedAtUTC: 1, surface: 'studio-cloud-sheet' };
