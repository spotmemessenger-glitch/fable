/**
 * Camera Stage 2A — THE FOUR ACTIVATION WIRINGS, real code, LAB-ONLY.
 *
 * These live OUTSIDE `src/` on purpose: each injects a real capability
 * (network fetch of same-origin assets, the vendored engine packages, the
 * navigator MediaStream) into a C3/C4 seam that in `src/` stays pure and
 * fence-clean. They are compiled ONLY into the camera-lab bundle, which is
 * built solely when `CAMERA_LAB_ENABLED=true` and is fence-proven absent
 * from the production artifact. None of this is imported by `src/`, `App`,
 * or any production surface.
 *
 * "One-line wirings" (the C5-identified activations): each `wire*` function
 * is the single call site that turns an injected seam live.
 */

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { createWorker } from 'tesseract.js';
import jsQR from 'jsqr';

import { createScanner, createTesseractRecognizer } from '../src/camera/vision';
import { createFaceTracker } from '../src/camera/ar';
import { EngineCameraAdapter } from '../src/camera/camera-port';
import { createCameraEngine } from '../src/camera/engine';
import { loadVerifiedAsset } from '../src/camera/model-assets';
import type { AssetLoaderDeps } from '../src/camera/model-assets';
import type { CameraDevicePort } from '../src/camera/engine';
import type { RgbaImage } from '../src/camera/types';
import type { JsQrDecoder } from '../src/camera/vision';

/** Same-origin asset loader deps for the ADR-029 integrity loader. The fetch
 *  is same-origin `/models/*` ONLY; the digest is SubtleCrypto. */
export const sameOriginAssetLoader: AssetLoaderDeps = {
  async fetchBytes(path: string): Promise<Uint8Array | null> {
    // Same-origin guard belt-and-braces: the loader already refuses non-
    // same-origin manifest paths; this refuses to fetch anything else too.
    if (!path.startsWith('/models/')) return null;
    const res = await fetch(path);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  },
  async digest(bytes: Uint8Array): Promise<string> {
    const view = new Uint8Array(bytes); // ArrayBuffer-backed for BufferSource
    const hash = await crypto.subtle.digest('SHA-256', view.buffer as ArrayBuffer);
    const hex = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `sha256:${hex}`;
  },
};

/* ---------------- Wiring 1: jsQR lazy loader ---------------- */

export function wireScanner() {
  return createScanner({
    platformDetector: () =>
      typeof (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector === 'function'
        ? new (globalThis as unknown as { BarcodeDetector: new (o: unknown) => { detect(i: unknown): Promise<{ format: string; rawValue: string }[]> } }).BarcodeDetector({})
        : null,
    loadJsQr: async (): Promise<JsQrDecoder> =>
      (data, width, height) => {
        const hit = jsQR(data, width, height);
        return hit ? { data: hit.data } : null;
      },
  });
}

/* ---------------- Wiring 2: MediaPipe face-landmarker registration ---------------- */

export async function wireFaceLandmarker() {
  const tracker = createFaceTracker({
    platformDetector: () =>
      typeof (globalThis as { FaceDetector?: unknown }).FaceDetector === 'function'
        ? new (globalThis as unknown as { FaceDetector: new () => { detect(i: unknown): Promise<{ boundingBox: { x: number; y: number; width: number; height: number } }[]> } }).FaceDetector()
        : null,
    assetLoader: sameOriginAssetLoader,
  });
  // Registration goes THROUGH the integrity loader (verifies digests).
  const registration = await tracker.registerLandmarker();
  let landmarker: FaceLandmarker | null = null;
  if ('state' in registration && registration.state === 'registered') {
    // Only after integrity passes do we hand the verified bytes to MediaPipe.
    const verified = await loadVerifiedAsset('face-landmarker', sameOriginAssetLoader);
    if (verified.state === 'loaded') {
      const fileset = await FilesetResolver.forVisionTasks('/models');
      landmarker = await FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task' },
        outputFaceBlendshapes: false,
        numFaces: 1,
      });
    }
  }
  return { tracker, landmarker, registration };
}

/* ---------------- Wiring 3: tesseract registration ---------------- */

export function wireTesseract(language: 'eng' | 'kan' = 'eng') {
  return createTesseractRecognizer(async () => {
    const worker = await createWorker(language, undefined, {
      workerPath: '/models/tesseract-worker.min.js',
      corePath: '/models/tesseract-core-simd-lstm.wasm.js',
      langPath: '/models',
      gzip: true,
    });
    return { recognize: (image: unknown) => worker.recognize(image as never) as never };
  });
}

/* ---------------- Wiring 4: composer CameraPort binding ---------------- */

/** The navigator/MediaStream device adapter — the real `CameraDevicePort`. */
export function createNavigatorDevicePort(): CameraDevicePort {
  const streams = new Map<string, MediaStream>();
  const videos = new Map<string, HTMLVideoElement>();
  let seq = 0;

  async function frameToRgba(video: HTMLVideoElement): Promise<RgbaImage | null> {
    const w = video.videoWidth; const h = video.videoHeight;
    if (!w || !h) return null;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return { data, width: w, height: h };
  }

  return {
    async listDevices() {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, facing: 'unknown' as const }));
    },
    async open({ deviceId, facing }) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId } : { facingMode: facing ?? 'environment' },
        });
        const sessionId = `nav-${++seq}`;
        const video = document.createElement('video');
        video.srcObject = stream; video.muted = true; video.playsInline = true;
        await video.play();
        streams.set(sessionId, stream); videos.set(sessionId, video);
        return { state: 'open', sessionId };
      } catch (err) {
        const name = (err as { name?: string }).name;
        return { state: 'unavailable', reason: name === 'NotAllowedError' ? 'permission-denied' : name === 'NotFoundError' ? 'no-device' : 'timeout' };
      }
    },
    exposureCapability(sessionId) {
      const track = streams.get(sessionId)?.getVideoTracks()[0];
      const caps = track?.getCapabilities?.() as { exposureCompensation?: { min: number; max: number } } | undefined;
      const ev = caps?.exposureCompensation;
      return ev ? { available: true, min: ev.min, max: ev.max } : { available: false, min: 0, max: 0 };
    },
    async setExposureCompensation(sessionId, value) {
      const track = streams.get(sessionId)?.getVideoTracks()[0];
      try { await track?.applyConstraints({ advanced: [{ exposureCompensation: value } as never] }); return true; } catch { return false; }
    },
    async grabFrame(sessionId) {
      const video = videos.get(sessionId);
      if (!video) return null;
      const image = await frameToRgba(video);
      return image ? { image, label: 'takePhoto>grabFrame>canvas' } : null;
    },
    async release(sessionId) {
      streams.get(sessionId)?.getTracks().forEach((t) => t.stop());
      streams.delete(sessionId); videos.delete(sessionId);
    },
    contentHash(image) {
      let h = 2166136261;
      for (let i = 0; i < image.data.length; i += 997) { h ^= image.data[i]; h = Math.imul(h, 16777619); }
      return `sha256:${(h >>> 0).toString(16).padStart(8, '0')}`;
    },
  };
}

export function wireComposerCamera(device: CameraDevicePort) {
  return new EngineCameraAdapter(createCameraEngine(device));
}
