/**
 * Camera contracts (Camera Stage 1, group C1, DARK).
 *
 * The typed surface for the camera platform migration (ADR-029): capture
 * request/result, the non-destructive edit-operation graph, vision scan
 * shapes, beauty tiers, and the CLOUD-CONSENT context. Privacy-branded by
 * ABSENCE: no capture shape carries a location field of any kind — EXIF/GPS
 * is stripped by the existing media pipeline before persistence (Phase 5B),
 * and these types give coordinates nowhere to live before that boundary.
 *
 * Honesty rule inherited from the CAM-1..4 platform: where a capability is
 * unavailable the API answers a CLOSED machine-readable reason — never a
 * degraded fake. Fake HDR, interpolated slow-mo, oval "face tracking", and
 * fabricated OCR are unrepresentable as successful results.
 */

export const CAMERA_CONTRACTS_VERSION = 1 as const;
export type CameraContractsVersion = typeof CAMERA_CONTRACTS_VERSION;

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

export type CaptureKind =
  | 'still' | 'hdr' | 'night' | 'burst' | 'video' | 'timelapse' | 'slow-mo';

export const CAPTURE_KINDS: readonly CaptureKind[] = [
  'still', 'hdr', 'night', 'burst', 'video', 'timelapse', 'slow-mo',
];

export type CameraFacing = 'user' | 'environment';

/** Closed refusal vocabulary — every unavailable capture names its reason. */
export type CaptureUnavailableReason =
  | 'permission-denied'
  | 'no-device'
  | 'no-exposure-control'   // fusing identical exposures is fake HDR — refused
  | 'no-high-fps-track'     // interpolated slow-mo is a lie — refused
  | 'no-pixel-access'
  | 'timeout'
  | 'aborted'
  | 'byte-budget-exceeded'
  | 'unsupported';

export const CAPTURE_UNAVAILABLE_REASONS: readonly CaptureUnavailableReason[] = [
  'permission-denied', 'no-device', 'no-exposure-control', 'no-high-fps-track',
  'no-pixel-access', 'timeout', 'aborted', 'byte-budget-exceeded', 'unsupported',
];

export interface CaptureRequest {
  readonly kind: CaptureKind;
  readonly facing?: CameraFacing;
  readonly deviceId?: string;
  /** TIER_BASIC EIS only this stage; gyro/advanced = Stage 3 native. */
  readonly stabilization?: 'off' | 'basic';
  /** video/timelapse/burst bounds — enforced by the engine, typed here. */
  readonly maxDurationMs?: number;
  readonly maxBytes?: number;
}

/**
 * A captured media reference. Deliberately ABSENT: latitude, longitude,
 * altitude, GPS, place, EXIF blobs — location has no field to live in on any
 * capture shape (threat model T-CA-2), and raw metadata rides only inside
 * the media bytes until the Phase 5B EXIF strip removes it at upload.
 */
export interface CapturedMediaRef {
  readonly mediaId: string;
  readonly kind: 'image' | 'video';
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs?: number;
  /** sha256 content hash — the moderation/dedup handle (Phase 5B). */
  readonly contentHash: string;
  /** Which pump/path produced this frame — honesty label, never inferred. */
  readonly captureLabel: string;
}

export type CaptureResult =
  | { readonly state: 'captured'; readonly media: CapturedMediaRef }
  | { readonly state: 'captured-burst'; readonly media: readonly [CapturedMediaRef, ...CapturedMediaRef[]] }
  | { readonly state: 'unavailable'; readonly reason: CaptureUnavailableReason };

/* ------------------------------------------------------------------ *
 * Edit-operation graph (Creative Studio subset)
 * ------------------------------------------------------------------ */

/** Closed op vocabulary — the Stage 1 studio subset (ADR-029 §3). */
export type EditOpKind =
  | 'exposure' | 'contrast' | 'saturation' | 'temperature' | 'tint'
  | 'highlights' | 'shadows' | 'curves' | 'vignette' | 'sharpen'
  | 'clarity' | 'grain' | 'crop' | 'rotate' | 'straighten' | 'look';

export const EDIT_OP_KINDS: readonly EditOpKind[] = [
  'exposure', 'contrast', 'saturation', 'temperature', 'tint', 'highlights',
  'shadows', 'curves', 'vignette', 'sharpen', 'clarity', 'grain', 'crop',
  'rotate', 'straighten', 'look',
];

/** Unit-bounded scalar ops share one shape: value in [-1, 1]. */
export type ScalarOpKind = Exclude<EditOpKind, 'curves' | 'crop' | 'rotate' | 'straighten' | 'look'>;

/** The 8 procedural looks — honestly named, never "AI". Closed. */
export type LookId =
  | 'silver' | 'ember' | 'coast' | 'meadow' | 'noir' | 'lumen' | 'fade' | 'dusk';

export const LOOK_IDS: readonly LookId[] = [
  'silver', 'ember', 'coast', 'meadow', 'noir', 'lumen', 'fade', 'dusk',
];

export interface CurvePoint { readonly x: number; readonly y: number }

export type EditOp =
  | { readonly kind: ScalarOpKind; readonly value: number }
  | { readonly kind: 'curves'; readonly points: readonly [CurvePoint, CurvePoint, ...CurvePoint[]] }
  | { readonly kind: 'crop'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly kind: 'rotate'; readonly quarterTurns: 1 | 2 | 3 }
  | { readonly kind: 'straighten'; readonly degrees: number }
  | { readonly kind: 'look'; readonly look: LookId; readonly strength: number };

/**
 * A non-destructive edit document. Undo IS document slicing — there is no
 * destructive mutation to reverse. Versioned for serialization.
 */
export interface EditDocument {
  readonly version: 1;
  readonly baseMediaId: string;
  readonly ops: readonly EditOp[];
}

/* ------------------------------------------------------------------ *
 * Vision scan (barcode/QR + OCR)
 * ------------------------------------------------------------------ */

/** Formats the platform-native detector may report; the JS fallback reports
 *  'qr' only. Closed. */
export type ScanFormat =
  | 'qr' | 'ean-13' | 'ean-8' | 'upc-a' | 'upc-e' | 'code-128' | 'code-39'
  | 'code-93' | 'codabar' | 'itf' | 'pdf417' | 'aztec' | 'data-matrix';

export const SCAN_FORMATS: readonly ScanFormat[] = [
  'qr', 'ean-13', 'ean-8', 'upc-a', 'upc-e', 'code-128', 'code-39',
  'code-93', 'codabar', 'itf', 'pdf417', 'aztec', 'data-matrix',
];

export interface ScanDetection {
  readonly format: ScanFormat;
  readonly rawValue: string;
  /** Which decoder produced this — 'platform-barcode-detector' | 'jsqr'. */
  readonly decoder: 'platform-barcode-detector' | 'jsqr';
}

export type ScanResult =
  | { readonly state: 'detected'; readonly detections: readonly [ScanDetection, ...ScanDetection[]] }
  | { readonly state: 'none' }
  | { readonly state: 'unavailable'; readonly reason: 'no-detector' | 'no-pixel-access' };

/** OCR — a genuine empty read is '' (success); a malformed engine result is
 *  'failed'; an absent engine is the honest 'no-text-recognizer'. */
export type TextRecognitionResult =
  | { readonly state: 'recognized'; readonly text: string; readonly engine: 'tesseract-js' }
  | { readonly state: 'unavailable'; readonly reason: 'no-text-recognizer' | 'not-loaded' | 'failed' };

/* ------------------------------------------------------------------ *
 * Face tracking & beauty tiers
 * ------------------------------------------------------------------ */

/** The one approved landmark engine — a LITERAL, so no other engine is even
 *  nameable on these shapes (ADR-029 asset-integrity posture). */
export type ApprovedLandmarkEngine = 'mediapipe-face-landmarker';

export interface FaceBox {
  readonly x: number; readonly y: number;
  readonly width: number; readonly height: number;
  readonly confidence: number;
  readonly source: 'platform-shape-detection' | ApprovedLandmarkEngine;
}

export interface FaceLandmarks {
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly engine: ApprovedLandmarkEngine;
}

export type FaceTrackingResult =
  | { readonly state: 'tracked'; readonly faces: readonly FaceBox[]; readonly landmarks?: FaceLandmarks }
  | { readonly state: 'unavailable'; readonly reason: 'no-platform-face-detector' | 'no-landmark-engine' | 'asset-integrity-failed' };

/** Tier-0 beauty: three bounded stages, naturalness-capped at [0, 1]. */
export interface BeautyTier0Params {
  readonly smooth: number;
  readonly tone: number;
  readonly brighten: number;
}

/**
 * Beauty request — ADVANCED structurally requires the approved landmark
 * engine name (ADR-014c gating preserved at type level: a box-only tracker
 * cannot satisfy an advanced request).
 */
export type BeautyRequest =
  | { readonly tier: 'tier-0'; readonly params: BeautyTier0Params }
  | { readonly tier: 'advanced'; readonly params: BeautyTier0Params; readonly landmarkEngine: ApprovedLandmarkEngine };

/* ------------------------------------------------------------------ *
 * Cloud consent (technically enforced boundary)
 * ------------------------------------------------------------------ */

/**
 * The NON-OPTIONAL consent context every cloud-vision port method takes.
 * Single-request scope only — no session/global/cached consent is
 * representable. Minted per user gesture at the calling surface.
 */
export interface CloudConsentContext {
  readonly kind: 'cloud-vision-consent';
  readonly scope: 'single-request';
  readonly grantedAtUTC: number;
  /** The UI surface that collected the consent — closed at the port. */
  readonly surface: string;
}

/** The closed cloud-vision operations (gateway-routed only; medical is NOT a
 *  member — held under owner policy, refused by absence). */
export type CloudVisionOp = 'recognize' | 'photo-translate' | 'caption-suggest';

export type CloudVisionResult =
  | { readonly state: 'disabled'; readonly reason: 'gateway-dark' }
  | { readonly state: 'result'; readonly op: CloudVisionOp; readonly payloadRef: string };

/* ------------------------------------------------------------------ *
 * Asset integrity (model/runtime assets)
 * ------------------------------------------------------------------ */

/** A pinned, self-hosted, integrity-checked model asset (ADR-029 §4). */
export interface ModelAssetRecord {
  readonly assetId: string;
  readonly engine: ApprovedLandmarkEngine | 'tesseract-js';
  readonly version: string;
  /** Same-origin path — never a CDN URL; the manifest fence enforces. */
  readonly path: string;
  readonly sha256: string;
  readonly licenseId: 'Apache-2.0';
  readonly sourceUrl: string;
}
