/**
 * The camera engine facade (Stage 1 C2) — ported from the CAM-1 engine
 * (#56, read-only source) into web-next platform idioms: instead of the
 * CAM 11-flag layering, darkness here is STRUCTURAL — nothing constructs
 * this engine unless a composer wires it, and no composer does (fence).
 *
 * The hardware seam is `CameraDevicePort`: everything the engine needs
 * from the platform (device list, stream open/close, frame grab, exposure
 * control) behind one injectable interface — deterministic in tests,
 * navigator-backed at activation. The CAM honesty laws port with the code:
 *
 *  - fusing identical exposures is fake HDR → `no-exposure-control`;
 *  - a session that opened a track ALWAYS releases it, on every path;
 *  - refusals are the closed contract vocabulary, never a dead feature.
 */

import type { CaptureResult, CapturedMediaRef, CaptureRequest } from '@spotme/contracts';
import { DEFAULT_EVS, fuseExposures } from './hdr';
import { stackFrames } from './night';
import type { NightOptions } from './night';
import type { RgbaImage } from './types';

/** Exposure-compensation capability as the platform reports it. */
export interface ExposureCapability {
  readonly available: boolean;
  readonly min: number;
  readonly max: number;
}

/** The one hardware seam. Implementations: fixture (tests) now; a
 *  navigator/MediaStream adapter at activation (Stage 2 validates it). */
export interface CameraDevicePort {
  listDevices(): Promise<readonly { deviceId: string; facing: 'user' | 'environment' | 'unknown' }[]>;
  /** Open a bounded session; the engine guarantees release() runs. */
  open(request: { deviceId?: string; facing?: 'user' | 'environment' }): Promise<
    | { state: 'open'; sessionId: string }
    | { state: 'unavailable'; reason: 'permission-denied' | 'no-device' | 'timeout' }
  >;
  exposureCapability(sessionId: string): ExposureCapability;
  setExposureCompensation(sessionId: string, ev: number): Promise<boolean>;
  /** Grab one frame; the label names the real path (takePhoto > grabFrame >
   *  canvas-draw in the browser adapter; 'fixture' in tests). */
  grabFrame(sessionId: string): Promise<{ image: RgbaImage; label: string } | null>;
  release(sessionId: string): Promise<void>;
  /** Rec.709-luma content hash for CapturedMediaRef — injected so tests are
   *  deterministic and the engine has no crypto dependency. */
  contentHash(image: RgbaImage): string;
}

export interface CameraEngine {
  capture(request: CaptureRequest): Promise<CaptureResult>;
  /** True while a session holds an open track — the covert-capture fence
   *  asserts this is false after every capture, including failures. */
  hasOpenSession(): boolean;
}

const BURST_DEFAULT_FRAMES = 6;
const NIGHT_DEFAULT_FRAMES = 6;

export function createCameraEngine(device: CameraDevicePort, night: NightOptions = {}): CameraEngine {
  let openSessions = 0;

  function mediaRef(image: RgbaImage, label: string, hash: string, seq = 0): CapturedMediaRef {
    return {
      mediaId: `cam:${hash.slice(0, 24)}:${seq}`,
      kind: 'image',
      mimeType: 'image/png',
      width: image.width,
      height: image.height,
      contentHash: hash,
      captureLabel: label,
    };
  }

  async function withSession<T>(
    request: CaptureRequest,
    body: (sessionId: string) => Promise<T | CaptureResult>,
  ): Promise<T | CaptureResult> {
    const opened = await device.open({ deviceId: request.deviceId, facing: request.facing });
    if (opened.state !== 'open') return { state: 'unavailable', reason: opened.reason };
    openSessions++;
    try {
      return await body(opened.sessionId);
    } finally {
      // The release guarantee: every path, including throw/refusal.
      openSessions--;
      await device.release(opened.sessionId);
    }
  }

  async function grabOrRefuse(sessionId: string): Promise<{ image: RgbaImage; label: string } | CaptureResult> {
    const frame = await device.grabFrame(sessionId);
    if (!frame) return { state: 'unavailable', reason: 'no-pixel-access' };
    return frame;
  }

  return {
    hasOpenSession: () => openSessions > 0,

    async capture(request: CaptureRequest): Promise<CaptureResult> {
      switch (request.kind) {
        case 'still':
          return withSession(request, async (sid) => {
            const frame = await grabOrRefuse(sid);
            if ('state' in frame) return frame;
            return { state: 'captured', media: mediaRef(frame.image, frame.label, device.contentHash(frame.image)) };
          }) as Promise<CaptureResult>;

        case 'hdr':
          return withSession(request, async (sid) => {
            const evCap = device.exposureCapability(sid);
            if (!evCap.available) {
              // Fusing identical exposures is fake HDR — refused (CAM law).
              return { state: 'unavailable', reason: 'no-exposure-control' } as CaptureResult;
            }
            const frames: RgbaImage[] = [];
            let label = '';
            for (const requested of DEFAULT_EVS) {
              const ev = Math.max(evCap.min, Math.min(evCap.max, requested));
              await device.setExposureCompensation(sid, ev);
              const frame = await grabOrRefuse(sid);
              if ('state' in frame) return frame;
              frames.push(frame.image);
              label = frame.label;
            }
            await device.setExposureCompensation(sid, 0); // never left where the bracket died
            const fused = fuseExposures(frames);
            if (!fused.available) return { state: 'unavailable', reason: fused.reason } as CaptureResult;
            return {
              state: 'captured',
              media: mediaRef(fused.image, `hdr-fusion:${label}`, device.contentHash(fused.image)),
            } as CaptureResult;
          }) as Promise<CaptureResult>;

        case 'night':
          return withSession(request, async (sid) => {
            const frames: RgbaImage[] = [];
            let label = '';
            for (let k = 0; k < NIGHT_DEFAULT_FRAMES; k++) {
              const frame = await grabOrRefuse(sid);
              if ('state' in frame) return frame;
              frames.push(frame.image);
              label = frame.label;
            }
            const stacked = stackFrames(frames, night);
            if (!stacked.available) return { state: 'unavailable', reason: stacked.reason } as CaptureResult;
            return {
              state: 'captured',
              media: mediaRef(stacked.image, `night-stack:${label}`, device.contentHash(stacked.image)),
            } as CaptureResult;
          }) as Promise<CaptureResult>;

        case 'burst':
          return withSession(request, async (sid) => {
            const budget = request.maxBytes ?? 24_000_000;
            const media: CapturedMediaRef[] = [];
            let spent = 0;
            for (let k = 0; k < BURST_DEFAULT_FRAMES; k++) {
              const frame = await grabOrRefuse(sid);
              if ('state' in frame) return frame;
              spent += frame.image.data.byteLength;
              if (spent > budget) {
                if (media.length === 0) return { state: 'unavailable', reason: 'byte-budget-exceeded' } as CaptureResult;
                break; // the budget bounds the burst, honestly partial
              }
              media.push(mediaRef(frame.image, frame.label, device.contentHash(frame.image), k));
            }
            return { state: 'captured-burst', media: media as [CapturedMediaRef, ...CapturedMediaRef[]] } as CaptureResult;
          }) as Promise<CaptureResult>;

        case 'video':
        case 'timelapse':
        case 'slow-mo':
          // The recorder layer (video.ts) owns these; the engine facade
          // refuses honestly where no recorder platform exists (jsdom).
          return { state: 'unavailable', reason: 'unsupported' };

        default: {
          const never: never = request.kind;
          return never;
        }
      }
    },
  };
}
