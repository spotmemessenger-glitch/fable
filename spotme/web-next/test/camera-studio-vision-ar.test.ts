/**
 * Stage 1 C3 — studio subset, vision, AR/beauty, cloud-consent, asset
 * integrity. Ported laws re-proven: undo-as-slicing, monotone curves,
 * naturalness caps, honest scan/OCR refusals, the landmark gate, the
 * consent boundary, and the no-CDN asset loader.
 */

import { describe, expect, it } from 'vitest';
import {
  createDocument, curveLut, deserializeDocument, evaluateDocument, pushOp,
  serializeDocument, unappliedOps, undo,
} from '../src/camera/studio';
import { createScanner, createTesseractRecognizer, noTextRecognizer } from '../src/camera/vision';
import {
  BEAUTY_LIMITS, applyBeauty, applyBrighten, applySkinSmooth, createBoxSmoother,
  createFaceTracker, skinToneMask, toneCurve,
} from '../src/camera/ar';
import { CloudConsentError, DisabledCloudVision, assertConsent } from '../src/camera/cloud';
import { loadVerifiedAsset } from '../src/camera/model-assets';
import { scene64 } from '../src/camera/fixtures';
import type { CloudConsentContext, ModelAssetRecord } from '@spotme/contracts';
import type { RgbaImage } from '../src/camera/types';

const consent = (over: Partial<CloudConsentContext> = {}): CloudConsentContext => ({
  kind: 'cloud-vision-consent', scope: 'single-request', grantedAtUTC: 1000, surface: 'test-sheet', ...over,
});

function grey(v: number, width = 8, height = 8): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255; }
  return { data, width, height };
}

/* ---------------- studio ---------------- */

describe('studio: op-doc model', () => {
  it('undo IS slicing; serialization round-trips; corrupt json is null', () => {
    let doc = createDocument('m1');
    doc = pushOp(doc, { kind: 'exposure', value: 0.5 });
    doc = pushOp(doc, { kind: 'look', look: 'noir', strength: 1 });
    expect(doc.ops.length).toBe(2);
    const undone = undo(doc);
    expect(undone.ops.length).toBe(1);
    expect(doc.ops.length).toBe(2); // non-destructive: the original is untouched
    expect(deserializeDocument(serializeDocument(doc))).toEqual(doc);
    expect(deserializeDocument('{"nope":1}')).toBeNull();
    expect(deserializeDocument('not json')).toBeNull();
  });

  it('curves LUT is MONOTONE for monotone control points — no overshoot, ever', () => {
    const lut = curveLut([{ x: 0, y: 0 }, { x: 0.3, y: 0.6 }, { x: 1, y: 1 }]);
    for (let v = 1; v < 256; v++) expect(lut[v]).toBeGreaterThanOrEqual(lut[v - 1]);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('exposure brightens, contrast pivots at mid-grey, crop/rotate change geometry', () => {
    const base = scene64();
    const brighter = evaluateDocument(base, pushOp(createDocument('m'), { kind: 'exposure', value: 0.5 }));
    expect(brighter.data[4]).toBeGreaterThanOrEqual(base.data[4]);

    const mid = grey(128);
    const contrasted = evaluateDocument(mid, pushOp(createDocument('m'), { kind: 'contrast', value: 0.8 }));
    expect(Math.abs(contrasted.data[0] - 128)).toBeLessThanOrEqual(1); // pivot fixed

    const cropped = evaluateDocument(base, pushOp(createDocument('m'), { kind: 'crop', x: 8, y: 8, width: 16, height: 12 }));
    expect(cropped.width).toBe(16);
    expect(cropped.height).toBe(12);

    const rotated = evaluateDocument(base, pushOp(createDocument('m'), { kind: 'rotate', quarterTurns: 1 }));
    expect(rotated.width).toBe(base.height);
    expect(rotated.height).toBe(base.width);
  });

  it('a look at strength 0 is the identity; noir desaturates toward luma', () => {
    const base = scene64();
    const zero = evaluateDocument(base, pushOp(createDocument('m'), { kind: 'look', look: 'ember', strength: 0 }));
    expect([...zero.data]).toEqual([...base.data]);

    const tinted: RgbaImage = grey(0, 4, 4);
    for (let i = 0; i < tinted.data.length; i += 4) { tinted.data[i] = 200; tinted.data[i + 1] = 80; tinted.data[i + 2] = 40; }
    const noir = evaluateDocument(tinted, pushOp(createDocument('m'), { kind: 'look', look: 'noir', strength: 1 }));
    const spread = Math.abs(noir.data[0] - noir.data[1]) + Math.abs(noir.data[1] - noir.data[2]);
    const originalSpread = Math.abs(200 - 80) + Math.abs(80 - 40);
    expect(spread).toBeLessThan(originalSpread * 0.5);
  });
});

/* ---------------- vision ---------------- */

describe('vision: scan', () => {
  const image = scene64();

  it('platform detector wins and maps formats; unmapped formats are dropped, empty is none', async () => {
    const scanner = createScanner({
      platformDetector: () => ({
        detect: async () => [
          { format: 'qr_code', rawValue: 'hello' },
          { format: 'ean_13', rawValue: '4006381333931' },
          { format: 'martian_code', rawValue: 'x' },
        ],
      }),
    });
    const result = await scanner.scan(image);
    expect(result.state).toBe('detected');
    if (result.state !== 'detected') return;
    expect(result.detections.map((d) => d.format)).toEqual(['qr', 'ean-13']);
    expect(result.detections[0].decoder).toBe('platform-barcode-detector');
  });

  it('the injected jsQR fallback decodes qr-only; loads LAZILY and once', async () => {
    let loads = 0;
    const scanner = createScanner({
      loadJsQr: async () => { loads++; return () => ({ data: 'qr-payload' }); },
    });
    expect(loads).toBe(0); // nothing loads at construction
    const first = await scanner.scan(image);
    const second = await scanner.scan(image);
    expect(loads).toBe(1);
    expect(first.state).toBe('detected');
    if (first.state === 'detected') expect(first.detections[0]).toMatchObject({ format: 'qr', decoder: 'jsqr' });
    expect(second.state).toBe('detected');
  });

  it('no platform API and no fallback wired: the honest NO_DETECTOR, never a fake', async () => {
    expect(await createScanner().scan(image)).toEqual({ state: 'unavailable', reason: 'no-detector' });
    expect(await createScanner().scan({ data: new Uint8ClampedArray(0), width: 0, height: 0 }))
      .toEqual({ state: 'unavailable', reason: 'no-pixel-access' });
  });
});

describe('vision: tesseract ITextRecognizer', () => {
  const image = scene64();

  it('is honest not-loaded until load() resolves — recognize NEVER loads implicitly', async () => {
    let loads = 0;
    const ocr = createTesseractRecognizer(async () => { loads++; return { recognize: async () => ({ data: { text: 'hi' } }) }; });
    expect(await ocr.recognize(image)).toEqual({ state: 'unavailable', reason: 'not-loaded' });
    expect(loads).toBe(0);
    await ocr.load();
    expect(loads).toBe(1);
    expect(await ocr.recognize(image)).toEqual({ state: 'recognized', text: 'hi', engine: 'tesseract-js' });
  });

  it("a genuine empty read is '' success; a malformed engine payload is FAILED — never coerced", async () => {
    const empty = createTesseractRecognizer(async () => ({ recognize: async () => ({ data: { text: '' } }) }));
    await empty.load();
    expect(await empty.recognize(image)).toEqual({ state: 'recognized', text: '', engine: 'tesseract-js' });

    const malformed = createTesseractRecognizer(async () => ({ recognize: async () => ({ data: { text: 42 } }) }));
    await malformed.load();
    expect(await malformed.recognize(image)).toEqual({ state: 'unavailable', reason: 'failed' });

    const throwing = createTesseractRecognizer(async () => ({ recognize: async () => { throw new Error('x'); } }));
    await throwing.load();
    expect(await throwing.recognize(image)).toEqual({ state: 'unavailable', reason: 'failed' });
  });

  it('the empty registry default refuses by name', () => {
    expect(noTextRecognizer()).toEqual({ state: 'unavailable', reason: 'no-text-recognizer' });
  });
});

/* ---------------- AR / beauty ---------------- */

describe('beauty tier-0 (ported formulas + caps)', () => {
  it('skinToneMask: a skin-cluster pixel scores high, saturated blue scores ~0, shadow gated', () => {
    const skin = grey(0, 1, 1); skin.data.set([190, 140, 110, 255]);
    const blue = grey(0, 1, 1); blue.data.set([30, 60, 220, 255]);
    const dark = grey(0, 1, 1); dark.data.set([20, 15, 12, 255]);
    expect(skinToneMask(skin).data[0]).toBeGreaterThan(0.5);
    expect(skinToneMask(blue).data[0]).toBeLessThan(0.05);
    expect(skinToneMask(dark).data[0]).toBeLessThan(0.05);
  });

  it('NATURALNESS CAPS: strength 5 produces exactly the capped effect of strength 1', () => {
    const skinField = grey(0, 8, 8);
    for (let i = 0; i < skinField.data.length; i += 4) {
      const jitter = (i / 4) % 3 === 0 ? 12 : 0;
      skinField.data[i] = 190 + jitter; skinField.data[i + 1] = 140; skinField.data[i + 2] = 110;
    }
    const capped = applySkinSmooth(skinField, 1);
    const excessive = applySkinSmooth(skinField, 5 as number);
    expect([...excessive.data]).toEqual([...capped.data]);
  });

  it('toneCurve endpoints stay pinned and the blend is capped', () => {
    const c = toneCurve(1);
    expect(c[0]).toBe(0);
    expect(c[255]).toBe(255);
    const c5 = toneCurve(5 as number);
    expect([...c5]).toEqual([...toneCurve(1)]);
  });

  it('brighten is algebraically clip-free and leaves highlights nearly untouched', () => {
    const bright = applyBrighten(grey(250), 1);
    expect(bright.data[0]).toBeLessThanOrEqual(255);
    expect(bright.data[0] - 250).toBeLessThanOrEqual(Math.round(255 * BEAUTY_LIMITS.BRIGHTEN_MAX_LIFT * (5 / 255)) + 2);
    const shadows = applyBrighten(grey(20), 1);
    expect(shadows.data[0]).toBeGreaterThan(60); // shadows lift most
  });

  it('THE LANDMARK GATE: advanced beauty refuses without a registered landmark engine', () => {
    const result = applyBeauty(grey(128), {
      tier: 'advanced', params: { smooth: 0.5, tone: 0, brighten: 0 },
      landmarkEngine: 'mediapipe-face-landmarker',
    }, false);
    expect(result).toEqual({ state: 'unavailable', reason: 'no-landmark-engine' });
    const tier0 = applyBeauty(grey(128), { tier: 'tier-0', params: { smooth: 0.5, tone: 0, brighten: 0 } }, false);
    expect('data' in tier0).toBe(true);
  });
});

describe('face tracking', () => {
  it('no platform detector: honest refusal, never an oval guess', async () => {
    const tracker = createFaceTracker();
    expect(await tracker.track(scene64())).toEqual({ state: 'unavailable', reason: 'no-platform-face-detector' });
    expect(tracker.landmarkAvailability()).toBe(false);
  });

  it('platform boxes are normalized, labeled, and EMA-smoothed across frames', async () => {
    let call = 0;
    const tracker = createFaceTracker({
      platformDetector: () => ({
        detect: async () => { call++; return [{ boundingBox: { x: call === 1 ? 16 : 32, y: 16, width: 16, height: 16 } }]; },
      }),
    });
    const first = await tracker.track(scene64());
    const second = await tracker.track(scene64());
    if (first.state !== 'tracked' || second.state !== 'tracked') throw new Error('expected tracks');
    expect(first.faces[0].source).toBe('platform-shape-detection');
    expect(first.faces[0].confidence).toBe(0); // F-CAM-2: never invented
    expect(first.faces[0].x).toBeCloseTo(0.25, 5);
    // EMA: the second frame's jump to 0.5 is smoothed toward the first.
    expect(second.faces[0].x).toBeGreaterThan(0.25);
    expect(second.faces[0].x).toBeLessThan(0.5);
  });

  it('the MediaPipe registration path goes through the integrity loader — with the Stage 1 EMPTY manifest it always refuses', async () => {
    const tracker = createFaceTracker({
      assetLoader: { fetchBytes: async () => new Uint8Array([1]), digest: async () => 'whatever' },
    });
    expect(await tracker.registerLandmarker()).toEqual({ state: 'unavailable', reason: 'no-landmark-engine' });
    expect(tracker.landmarkAvailability()).toBe(false);
  });

  it('EMA smoother resets when the face count changes', () => {
    const smooth = createBoxSmoother(0.5);
    const box = (x: number) => ({ x, y: 0, width: 0.1, height: 0.1, confidence: 0, source: 'platform-shape-detection' as const });
    smooth([box(0.2)]);
    expect(smooth([])).toEqual([]); // count changed: passthrough, no stale ghosts
  });
});

/* ---------------- cloud consent + asset integrity ---------------- */

describe('cloud consent boundary', () => {
  it('the disabled adapter validates consent then answers gateway-dark with zero egress', async () => {
    const port = new DisabledCloudVision(() => 2000);
    expect(await port.request('recognize', 'ref:1', consent()))
      .toEqual({ state: 'disabled', reason: 'gateway-dark' });
  });

  it('missing / malformed / stale consent THROWS even past the types', () => {
    const now = 10 * 60_000 + 2000;
    expect(() => assertConsent(undefined as unknown as CloudConsentContext, 2000)).toThrow(CloudConsentError);
    expect(() => assertConsent(consent({ scope: 'session' as never }), 2000)).toThrow(/malformed/);
    expect(() => assertConsent(consent({ surface: '' }), 2000)).toThrow(/malformed/);
    expect(() => assertConsent(consent({ grantedAtUTC: 1000 }), now)).toThrow(/stale/); // cached consent cannot work
  });
});

describe('asset integrity loader (ADR-029 §4)', () => {
  const record: ModelAssetRecord = {
    assetId: 'face-landmarker', engine: 'mediapipe-face-landmarker', version: '0.10.14',
    path: '/models/face_landmarker.task', sha256: 'sha256:abc', licenseId: 'Apache-2.0',
    sourceUrl: 'https://github.com/google-ai-edge/mediapipe',
  };
  const deps = (digest: string) => ({
    fetchBytes: async () => new Uint8Array([1, 2, 3]),
    digest: async () => digest,
  });

  it('the committed manifest is EMPTY at Stage 1 — every load refuses unknown-asset', async () => {
    expect(await loadVerifiedAsset('face-landmarker', deps('abc')))
      .toEqual({ state: 'unavailable', reason: 'unknown-asset' });
  });

  it('a digest mismatch is asset-integrity-failed — never a silent fetch-elsewhere', async () => {
    expect(await loadVerifiedAsset('face-landmarker', deps('WRONG'), [record]))
      .toEqual({ state: 'unavailable', reason: 'asset-integrity-failed' });
    const ok = await loadVerifiedAsset('face-landmarker', deps('abc'), [record]);
    expect(ok.state).toBe('loaded');
  });

  it('NO RUNTIME CDN PATH: any non-same-origin manifest path is refused structurally', async () => {
    for (const path of ['https://cdn.example.com/model.task', '//cdn.example.com/m', 'http://x/m', 'data:application/octet-stream;base64,AA']) {
      expect(await loadVerifiedAsset('face-landmarker', deps('abc'), [{ ...record, path }]))
        .toEqual({ state: 'unavailable', reason: 'not-same-origin' });
    }
  });
});

describe('Stage 1 review repairs — regression battery', () => {
  it('F-CAM-1: future-granted consent is refused as stale — the clock cannot be gamed', () => {
    expect(() => assertConsent(consent({ grantedAtUTC: 5000 }), 2000)).toThrow(/stale/);
  });

  it('F-CAM-3: vignette/sharpen/clarity/grain REALLY apply — no silent no-op op', () => {
    const base = scene64();
    for (const op of [
      { kind: 'vignette' as const, value: 0.8 },
      { kind: 'sharpen' as const, value: 0.8 },
      { kind: 'clarity' as const, value: 0.8 },
      { kind: 'grain' as const, value: 0.8 },
    ]) {
      const out = evaluateDocument(base, pushOp(createDocument('m'), op));
      expect([...out.data].join(',')).not.toBe([...base.data].join(','));
    }
    // Vignette darkens corners more than the centre.
    const vig = evaluateDocument(base, pushOp(createDocument('m'), { kind: 'vignette', value: 1 }));
    const corner = vig.data[0] / Math.max(1, base.data[0]);
    const centreIdx = (32 * 64 + 32) * 4;
    const centre = vig.data[centreIdx] / Math.max(1, base.data[centreIdx]);
    expect(corner).toBeLessThan(centre);
  });

  it('F-CAM-3: unappliedOps discloses exactly the stored-unrasterized straighten', () => {
    let doc = createDocument('m');
    doc = pushOp(doc, { kind: 'straighten', degrees: 2 });
    doc = pushOp(doc, { kind: 'exposure', value: 0.2 });
    expect(unappliedOps(doc)).toEqual(['straighten']);
    expect(unappliedOps(createDocument('m'))).toEqual([]);
  });
});
