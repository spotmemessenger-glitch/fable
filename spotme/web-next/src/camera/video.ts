/**
 * Video capture layer (Stage 1 C2) — the negotiated-recorder wrapper ported
 * from CAM-1 `video.js`/`timelapse.js`/`slowmo.js` disciplines (#56,
 * read-only source), against an injectable recorder seam:
 *
 *  - format negotiation via isTypeSupported (webm preferred, mp4 fallback);
 *  - guarded state machine (idle → recording → stopped) with duration/byte
 *    caps and an explicit `stoppedBy`;
 *  - SLOW-MO only where the track honestly does ≥100 fps — zero
 *    interpolation, ever (`no-high-fps-track` otherwise);
 *  - TIMELAPSE this stage is the LABELED REAL-TIME RECORDER PATH — the
 *    CAM-1 WebCodecs + own-EBML-muxer offline path remains on the source
 *    branch and is a documented later port (`timelapsePath` says which one
 *    ran; nothing pretends the offline path exists here).
 */

import type { CaptureUnavailableReason } from '@spotme/contracts';

export interface RecorderPort {
  /** Mirror of MediaRecorder.isTypeSupported. */
  isTypeSupported(mime: string): boolean;
  /** Real fps the track reports — slow-mo gates on this, never interpolates. */
  trackFrameRate(): number | null;
  start(mime: string): { state: 'recording' } | { state: 'unavailable'; reason: 'no-device' | 'permission-denied' };
  stop(): { bytes: number; durationMs: number };
}

export const VIDEO_MIME_PREFERENCE: readonly string[] = [
  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4',
];

export const SLOWMO_MIN_FPS = 100;

export type RecordingOutcome =
  | {
      state: 'recorded';
      mime: string;
      bytes: number;
      durationMs: number;
      stoppedBy: 'caller' | 'duration-cap' | 'byte-cap';
      /** Which path produced a timelapse — honesty label. */
      timelapsePath?: 'realtime-recorder';
    }
  | { state: 'unavailable'; reason: CaptureUnavailableReason };

export interface VideoTake {
  stop(): RecordingOutcome;
}

export function negotiateMime(recorder: RecorderPort): string | null {
  for (const mime of VIDEO_MIME_PREFERENCE) {
    if (recorder.isTypeSupported(mime)) return mime;
  }
  return null;
}

export function startRecording(
  recorder: RecorderPort,
  {
    kind = 'video',
    maxDurationMs = 5 * 60_000,
    maxBytes = 200_000_000,
    now = () => 0,
  }: { kind?: 'video' | 'timelapse' | 'slow-mo'; maxDurationMs?: number; maxBytes?: number; now?: () => number } = {},
): VideoTake | { state: 'unavailable'; reason: CaptureUnavailableReason } {
  if (kind === 'slow-mo') {
    const fps = recorder.trackFrameRate();
    // Zero interpolation, ever: no honest ≥100 fps track, no slow-mo.
    if (fps === null || fps < SLOWMO_MIN_FPS) {
      return { state: 'unavailable', reason: 'no-high-fps-track' };
    }
  }
  const mime = negotiateMime(recorder);
  if (!mime) return { state: 'unavailable', reason: 'unsupported' };
  const started = recorder.start(mime);
  if (started.state !== 'recording') return { state: 'unavailable', reason: started.reason };
  const startedAt = now();
  let done: RecordingOutcome | null = null;

  return {
    stop(): RecordingOutcome {
      if (done) return done;
      const { bytes, durationMs } = recorder.stop();
      const elapsed = Math.max(durationMs, now() - startedAt);
      const stoppedBy = bytes > maxBytes ? 'byte-cap' : elapsed >= maxDurationMs ? 'duration-cap' : 'caller';
      done = {
        state: 'recorded',
        mime,
        bytes: Math.min(bytes, maxBytes),
        durationMs: Math.min(elapsed, maxDurationMs),
        stoppedBy,
        ...(kind === 'timelapse' ? { timelapsePath: 'realtime-recorder' as const } : {}),
      };
      return done;
    },
  };
}
