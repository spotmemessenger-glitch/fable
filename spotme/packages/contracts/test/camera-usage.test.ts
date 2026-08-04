/**
 * COMPILE-TIME POSITIVE CONTROL for the Camera Stage 1 contracts. If these
 * break, the contracts became unusable, not just stricter — and a broken
 * import would make every negative `@ts-expect-error` pass vacuously.
 */

import { CAMERA_CONTRACTS_VERSION, CAPTURE_KINDS, EDIT_OP_KINDS, LOOK_IDS, SCAN_FORMATS } from '../src/index.ts';
import type {
  BeautyRequest, CaptureRequest, CaptureResult, CapturedMediaRef,
  CloudConsentContext, CloudVisionResult, EditDocument, EditOp,
  FaceTrackingResult, ModelAssetRecord, ScanResult, TextRecognitionResult,
} from '../src/index.ts';

export const version: 1 = CAMERA_CONTRACTS_VERSION;
export const kinds = CAPTURE_KINDS.length + EDIT_OP_KINDS.length + LOOK_IDS.length + SCAN_FORMATS.length;

const media: CapturedMediaRef = {
  mediaId: 'm1', kind: 'image', mimeType: 'image/jpeg', width: 1080, height: 1440,
  contentHash: 'sha256:abcd', captureLabel: 'takePhoto',
};

/* Capture: request + all three result arms. */
export const req: CaptureRequest = { kind: 'hdr', facing: 'environment', stabilization: 'basic' };
export const captured: CaptureResult = { state: 'captured', media };
export const burst: CaptureResult = { state: 'captured-burst', media: [media, { ...media, mediaId: 'm2' }] };
export const refused: CaptureResult = { state: 'unavailable', reason: 'no-high-fps-track' };

/* Exhaustive narrowing — no other arm exists. */
export function describeCapture(r: CaptureResult): string {
  switch (r.state) {
    case 'captured': return r.media.mediaId;
    case 'captured-burst': return String(r.media.length);
    case 'unavailable': return r.reason;
    default: { const never: never = r; return never; }
  }
}

/* Edit graph: a document with every op family; undo = slicing. */
const ops: EditOp[] = [
  { kind: 'exposure', value: 0.3 },
  { kind: 'curves', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  { kind: 'crop', x: 10, y: 10, width: 800, height: 600 },
  { kind: 'rotate', quarterTurns: 1 },
  { kind: 'straighten', degrees: -2.5 },
  { kind: 'look', look: 'noir', strength: 0.7 },
];
export const doc: EditDocument = { version: 1, baseMediaId: 'm1', ops };
export const undone: EditDocument = { ...doc, ops: doc.ops.slice(0, -1) };

/* Vision: detected / none / unavailable; honest OCR states incl. empty read. */
export const scanned: ScanResult = {
  state: 'detected',
  detections: [{ format: 'qr', rawValue: 'https://example.test', decoder: 'jsqr' }],
};
export const noDetector: ScanResult = { state: 'unavailable', reason: 'no-detector' };
export const emptyRead: TextRecognitionResult = { state: 'recognized', text: '', engine: 'tesseract-js' };
export const ocrNotLoaded: TextRecognitionResult = { state: 'unavailable', reason: 'not-loaded' };

/* Faces: platform boxes; landmarks only from the approved engine. */
export const tracked: FaceTrackingResult = {
  state: 'tracked',
  faces: [{ x: 0.1, y: 0.1, width: 0.3, height: 0.3, confidence: 0.9, source: 'platform-shape-detection' }],
  landmarks: { points: [{ x: 0.2, y: 0.2 }], engine: 'mediapipe-face-landmarker' },
};
export const noEngine: FaceTrackingResult = { state: 'unavailable', reason: 'no-landmark-engine' };

/* Beauty: tier-0 free-standing; advanced names the approved engine. */
export const tier0: BeautyRequest = { tier: 'tier-0', params: { smooth: 0.4, tone: 0.3, brighten: 0.2 } };
export const advanced: BeautyRequest = {
  tier: 'advanced', params: { smooth: 0.4, tone: 0.3, brighten: 0.2 },
  landmarkEngine: 'mediapipe-face-landmarker',
};

/* Cloud consent + disabled-by-default result. */
export const consent: CloudConsentContext = {
  kind: 'cloud-vision-consent', scope: 'single-request', grantedAtUTC: 1_700_000_000_000,
  surface: 'vision-cloud-sheet',
};
export const dark: CloudVisionResult = { state: 'disabled', reason: 'gateway-dark' };

/* Asset integrity: pinned, same-origin, hashed, licensed. */
export const asset: ModelAssetRecord = {
  assetId: 'face-landmarker-v1', engine: 'mediapipe-face-landmarker', version: '0.10.14',
  path: '/models/face_landmarker.task', sha256: 'sha256:abc123', licenseId: 'Apache-2.0',
  sourceUrl: 'https://github.com/google-ai-edge/mediapipe',
};
