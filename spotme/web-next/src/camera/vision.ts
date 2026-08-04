/**
 * AI Vision — Stage 1 subset (C3), ported from #58 (read-only source) under
 * the ADR-029 vendor rule: barcode/QR = the platform-native BarcodeDetector
 * where the runtime has one, else the approved jsQR fallback ALREADY IN THE
 * REPO — reached through an INJECTED decoder seam (web-next's isolation
 * fence forbids new package imports; the one-line loader that imports the
 * repo's jsqr is an activation wiring, documented in ADR-029). Never a new
 * barcode vendor.
 *
 * OCR: the NEW tesseract.js `ITextRecognizer` adapter — LAZY by contract:
 * `not-loaded` until an explicit load() resolves; the loader seam is
 * injected the same way (tesseract.js is an approved dependency whose
 * physical import lands with the activation wiring + vendored assets per
 * ASSET INTEGRITY). The honesty law ports verbatim: a genuine empty read
 * is `''` (success); a malformed engine result is `failed`; an absent or
 * unloaded engine refuses — NEVER a fabricated read.
 */

import type { ScanDetection, ScanFormat, ScanResult, TextRecognitionResult } from '@spotme/contracts';
import type { RgbaImage } from './types';

/* ---------------- barcode/QR scan ---------------- */

/** Platform BarcodeDetector, structurally typed (no DOM lib dependency). */
export interface PlatformBarcodeDetector {
  detect(image: unknown): Promise<{ format: string; rawValue: string }[]>;
}

/** The approved JS fallback seam — jsQR-shaped: pixels in, one QR or null. */
export type JsQrDecoder = (
  data: Uint8ClampedArray, width: number, height: number,
) => { data: string } | null;

const PLATFORM_FORMATS: ReadonlySet<string> = new Set([
  'qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39',
  'code_93', 'codabar', 'itf', 'pdf417', 'aztec', 'data_matrix',
]);

function toScanFormat(platformFormat: string): ScanFormat | null {
  if (!PLATFORM_FORMATS.has(platformFormat)) return null;
  return platformFormat.replace(/_/g, '-').replace('qr-code', 'qr') as ScanFormat;
}

export interface ScannerDeps {
  /** () => the platform detector, or null where the API doesn't exist. */
  platformDetector?: () => PlatformBarcodeDetector | null;
  /** Lazy loader for the approved jsQR fallback — activation wiring. */
  loadJsQr?: () => Promise<JsQrDecoder>;
}

export function createScanner(deps: ScannerDeps = {}) {
  let jsqr: JsQrDecoder | null = null;

  return {
    async scan(image: RgbaImage): Promise<ScanResult> {
      if (!image?.data?.length) return { state: 'unavailable', reason: 'no-pixel-access' };

      const detector = deps.platformDetector?.() ?? null;
      if (detector) {
        const raw = await detector.detect(image);
        const detections = raw
          .map((d): ScanDetection | null => {
            const format = toScanFormat(d.format);
            return format ? { format, rawValue: d.rawValue, decoder: 'platform-barcode-detector' } : null;
          })
          .filter((d): d is ScanDetection => d !== null);
        if (detections.length > 0) {
          return { state: 'detected', detections: detections as [ScanDetection, ...ScanDetection[]] };
        }
        return { state: 'none' };
      }

      if (deps.loadJsQr) {
        if (!jsqr) jsqr = await deps.loadJsQr();
        const hit = jsqr(image.data, image.width, image.height);
        if (hit && typeof hit.data === 'string') {
          return { state: 'detected', detections: [{ format: 'qr', rawValue: hit.data, decoder: 'jsqr' }] };
        }
        return { state: 'none' };
      }

      // No platform API, no fallback wired: the honest refusal, not a fake.
      return { state: 'unavailable', reason: 'no-detector' };
    },
  };
}

/* ---------------- OCR: the tesseract.js ITextRecognizer ---------------- */

/** tesseract.js, structurally typed at the seam. */
export interface TesseractLike {
  recognize(image: unknown): Promise<{ data?: { text?: unknown } }>;
}

export interface TextRecognizer {
  readonly engine: 'tesseract-js';
  readonly loaded: boolean;
  load(): Promise<void>;
  recognize(image: RgbaImage): Promise<TextRecognitionResult>;
}

/**
 * Lazy, on-device (ADR-029). Until `load()` resolves every call answers
 * `not-loaded` — loading NEVER happens implicitly on recognize(), so a
 * surface cannot trigger a model fetch as a side effect of a scan.
 */
export function createTesseractRecognizer(loadEngine: () => Promise<TesseractLike>): TextRecognizer {
  let engine: TesseractLike | null = null;
  let loading: Promise<void> | null = null;

  return {
    engine: 'tesseract-js',
    get loaded() { return engine !== null; },

    async load(): Promise<void> {
      if (engine) return;
      if (!loading) {
        loading = loadEngine().then((e) => { engine = e; }).catch((err) => { loading = null; throw err; });
      }
      return loading;
    },

    async recognize(image: RgbaImage): Promise<TextRecognitionResult> {
      if (!engine) return { state: 'unavailable', reason: 'not-loaded' };
      try {
        const result = await engine.recognize(image);
        const text = result?.data?.text;
        // A malformed engine payload is FAILED — never coerced into a read.
        if (typeof text !== 'string') return { state: 'unavailable', reason: 'failed' };
        // A genuine empty read is '' — honest success, not an error.
        return { state: 'recognized', text, engine: 'tesseract-js' };
      } catch {
        return { state: 'unavailable', reason: 'failed' };
      }
    },
  };
}

/** The empty registry default — what the app sees while nothing is wired. */
export function noTextRecognizer(): TextRecognitionResult {
  return { state: 'unavailable', reason: 'no-text-recognizer' };
}
