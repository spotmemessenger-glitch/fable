/**
 * Nearby Moments — reserved queue contracts (Phase 5B, M8).
 *
 * Reserves the four queue names and defines the JOB CONTRACTS + FIXTURE workers
 * only. Nothing here imports BullMQ or opens a connection — activation wires
 * these contracts onto the Phase 1C queue foundation (`src/queue/`, itself dark)
 * in a separate owner-authorized change. `createMomentQueues()` is INERT
 * without env: with no `REDIS_URL` it returns null, mirroring the 1C posture.
 */

/* Reserved names — same `{hashtag}` convention as the 1C `{maintenance}` queue. */
export const MOMENT_MEDIA_QUEUE = '{moment-media}';
export const STORY_EXPIRY_QUEUE = '{story-expiry}';
export const FEED_REFRESH_QUEUE = '{feed-refresh}';
export const MODERATION_QUEUE = '{moderation}';
export const MOMENT_QUEUE_NAMES = [
  MOMENT_MEDIA_QUEUE, STORY_EXPIRY_QUEUE, FEED_REFRESH_QUEUE, MODERATION_QUEUE,
] as const;

/* ------------------------------------------------------------ job contracts */

/** `{moment-media}` transcode job. The args template DOCUMENTS the future
 *  FFmpeg invocation; no binary is wired or executed this phase. */
export interface TranscodeJob {
  name: 'transcode';
  mediaId: string;
  targetMime: 'video/mp4' | 'image/jpeg';
  maxWidth: number;
  maxHeight: number;
  argsTemplate: string; // e.g. "ffmpeg -i {in} -vf scale='min({w},iw)':-2 -movflags +faststart {out}"
}

/** `{moment-media}` thumbnail job (libvips-shaped spec; data only). */
export interface ThumbnailJob {
  name: 'thumbnail';
  mediaId: string;
  maxDim: number;
  argsTemplate: string; // e.g. "vipsthumbnail {in} --size {d}x{d} -o {out}[Q=82]"
}

/** `{story-expiry}` sweep job (M3): expire stories published before the cutoff. */
export interface StoryExpiryJob {
  name: 'story-expiry';
  sweepBeforeUTC: number;
}

/** `{feed-refresh}` job: refresh a materialized feed seam (activation-era). */
export interface FeedRefreshJob {
  name: 'feed-refresh';
  mode: 'nearby' | 'friends' | 'city';
  cell: string | null;
}

/** `{moderation}` job: process one report (SANITIZED — ids + closed codes only,
 *  never content). `child-safety` reports are highest priority (M6). */
export interface ModerationJob {
  name: 'moderation';
  reportId: string;
  reason: string;
  priority: 'child-safety' | 'standard';
}

export type MomentJob = TranscodeJob | ThumbnailJob | StoryExpiryJob | FeedRefreshJob | ModerationJob;

/* ------------------------------------------------------------ fixture workers */

/** Deterministic in-memory fixture workers — the processing CONTRACT each real
 *  worker must satisfy; used by tests. No I/O, no binaries. */
export class FixtureMomentWorkers {
  readonly processed: MomentJob[] = [];

  async process(job: MomentJob): Promise<{ ok: boolean; queue: string }> {
    switch (job.name) {
      case 'transcode':
      case 'thumbnail':
        this.processed.push(job);
        return { ok: true, queue: MOMENT_MEDIA_QUEUE };
      case 'story-expiry':
        this.processed.push(job);
        return { ok: true, queue: STORY_EXPIRY_QUEUE };
      case 'feed-refresh':
        this.processed.push(job);
        return { ok: true, queue: FEED_REFRESH_QUEUE };
      case 'moderation':
        this.processed.push(job);
        return { ok: true, queue: MODERATION_QUEUE };
      default: {
        const never: never = job;
        throw new Error(`unknown moment job: ${JSON.stringify(never)}`);
      }
    }
  }
}

/* ------------------------------------------------------------ inert factory */

export interface MomentQueueDescriptors {
  names: readonly string[];
  /** Descriptors only — nothing connects until activation wires BullMQ (1C). */
  connected: false;
}

/** INERT without env (M8): returns null when no REDIS_URL is configured; even
 *  WITH env it returns descriptors only — no connection is ever opened here. */
export function createMomentQueues(env: { REDIS_URL?: string } = process.env): MomentQueueDescriptors | null {
  if (!env.REDIS_URL || !/^rediss?:\/\//.test(env.REDIS_URL)) return null;
  return { names: MOMENT_QUEUE_NAMES, connected: false };
}
