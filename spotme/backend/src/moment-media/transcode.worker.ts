/**
 * `{moment-media}` — the real transcode worker (M3).
 *
 * WHY RAW UPLOADS CANNOT BE SERVED. A phone records H.265/HEVC in a container
 * whose `moov` atom sits at the END of the file, at whatever bitrate the
 * camera chose. Three consequences, all of them felt on a feed: Chrome on
 * Android often cannot decode HEVC at all; a trailing `moov` means the player
 * must fetch the whole file before it can show frame one (so "time to first
 * frame" becomes "time to download 40 MB"); and a 4K 40 Mbps stream stutters
 * on a mid-range phone even when it does decode.
 *
 * So every video is normalised here:
 *   - H.264 High + AAC — the codec pair every browser on every phone decodes
 *   - `-movflags +faststart` — moov to the FRONT, which is the single change
 *     that turns "download it all" into "play almost immediately"
 *   - 720p and 480p variants — the player picks by viewport/connection
 *   - a poster frame — something to show while the first bytes arrive
 *   - `-map_metadata -1` — strips container metadata (GPS included). The
 *     image path strips EXIF before storing; this is the video equivalent,
 *     and it is why the ORIGINAL is never what gets served.
 *
 * HLS IS DELIBERATELY NOT USED HERE. For a sub-30s reel a faststart MP4 beats
 * HLS: no manifest round-trip, no segment requests, no MSE warm-up — the
 * player just starts. HLS earns its overhead on longer clips where mid-stream
 * bitrate switching matters; `NEEDS_HLS_SECONDS` marks that boundary and the
 * job records when a clip crosses it rather than silently doing the wrong
 * thing.
 */

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRedisConnection, isRedisConfigured } from '../queue/redis.connection';

const run = promisify(execFile);

export const MOMENT_MEDIA_QUEUE = '{moment-media}';
/** Past this, a clip is long enough that HLS would start to pay for itself. */
export const NEEDS_HLS_SECONDS = 30;

/** The ladder. 720p is the default served rung; 480p is the fallback. */
export const VARIANTS = [
  { name: '720p', height: 720, videoBitrate: '2000k', audioBitrate: '128k' },
  { name: '480p', height: 480, videoBitrate: '900k', audioBitrate: '96k' },
] as const;

export interface TranscodeResult {
  mediaId: string;
  durationSeconds: number | null;
  variants: Array<{ name: string; bytes: number; storageKey: string }>;
  posterKey: string | null;
  needsHls: boolean;
  msElapsed: number;
}

/** What the worker needs from the outside — kept narrow so it is testable. */
export interface TranscodeIO {
  /** Fetch the stored original. */
  readOriginal(mediaId: string): Promise<{ bytes: Buffer; mimeType: string } | null>;
  /** Store one derived rendition. */
  writeDerived(mediaId: string, name: string, bytes: Buffer, contentType: string): Promise<string>;
  /** Record the finished ladder against the asset. */
  recordVariants(mediaId: string, result: TranscodeResult): Promise<void>;
}

/** ffprobe → duration in seconds, or null when it cannot be determined. */
export async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file,
    ]);
    const n = Number(String(stdout).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * The ffmpeg argument list for one rung. Exported so a test can assert the
 * flags that actually matter (faststart, metadata strip, codecs) rather than
 * trusting a comment about them.
 */
export function transcodeArgs(input: string, output: string, v: (typeof VARIANTS)[number]): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    // GPS and every other container tag: gone. The image path strips EXIF;
    // this is the same promise for video.
    '-map_metadata', '-1',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast',
    '-b:v', v.videoBitrate, '-maxrate', v.videoBitrate, '-bufsize', '2M',
    /* THE GUARD THAT KEEPS `-profile:v high` HONEST.
     *
     * H.264 High profile is 8-bit 4:2:0 ONLY. Hand libx264 anything else and
     * it does not degrade — it REFUSES, and the job dies before a byte is
     * written ("high profile doesn't support 4:4:4" / "…doesn't support
     * 10-bit"). To the person who shot the clip that is simply "my video
     * didn't post", with nothing on screen to explain it.
     *
     * Two real sources hit this, and the second is not an edge case:
     *   - 4:4:4 footage from screen recorders and some pro capture apps
     *   - 10-bit HDR, which is what an iPhone 12 or newer SHOOTS BY DEFAULT
     *     with Dolby Vision on (yuv420p10le)
     *
     * Forcing the pixel format converts both to what the profile can encode
     * instead of failing on them. It must come BEFORE the scale filter's
     * output is handed to the encoder, which is where ffmpeg applies it. */
    '-pix_fmt', 'yuv420p',
    // Scale to the rung's height, keep the aspect, force even dimensions
    // (H.264 requires them; an odd width is a hard encoder failure).
    '-vf', `scale=-2:'min(${v.height},ih)'`,
    '-c:a', 'aac', '-b:a', v.audioBitrate, '-ac', '2',
    // THE FLAG THIS WHOLE FILE EXISTS FOR.
    '-movflags', '+faststart',
    output,
  ];
}

/** A single frame, one second in — far enough to miss a black opening frame. */
export function posterArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input, '-ss', '00:00:01', '-frames:v', '1',
    '-vf', 'scale=-2:720', '-q:v', '4',
    output,
  ];
}

/** Transcode one asset. Pure of Nest/Redis so tests can drive it directly. */
export async function transcodeOne(mediaId: string, io: TranscodeIO): Promise<TranscodeResult> {
  const started = Date.now();
  const original = await io.readOriginal(mediaId);
  if (!original) throw new Error(`no stored original for ${mediaId}`);

  const dir = await mkdtemp(join(tmpdir(), 'spotme-mm-'));
  try {
    const input = join(dir, 'in');
    await writeFile(input, original.bytes);
    const durationSeconds = await probeDuration(input);

    const variants: TranscodeResult['variants'] = [];
    for (const v of VARIANTS) {
      const out = join(dir, `${v.name}.mp4`);
      await run('ffmpeg', transcodeArgs(input, out, v));
      const bytes = await readFile(out);
      const storageKey = await io.writeDerived(mediaId, v.name, bytes, 'video/mp4');
      variants.push({ name: v.name, bytes: bytes.length, storageKey });
    }

    let posterKey: string | null = null;
    try {
      const p = join(dir, 'poster.jpg');
      await run('ffmpeg', posterArgs(input, p));
      posterKey = await io.writeDerived(mediaId, 'poster', await readFile(p), 'image/jpeg');
    } catch {
      // A missing poster degrades the first frame, it does not fail the job —
      // the variants are the thing that makes playback work.
      posterKey = null;
    }

    const result: TranscodeResult = {
      mediaId,
      durationSeconds,
      variants,
      posterKey,
      needsHls: (durationSeconds ?? 0) > NEEDS_HLS_SECONDS,
      msElapsed: Date.now() - started,
    };
    await io.recordVariants(mediaId, result);
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The Nest-facing wrapper: a queue to enqueue onto and a worker to drain it.
 * INERT WITHOUT REDIS, exactly like the 1C foundation — no env, no connection,
 * and `enqueue()` reports that it did nothing rather than pretending.
 */
@Injectable()
export class TranscodeQueue implements OnModuleDestroy {
  private readonly log = new Logger(TranscodeQueue.name);
  private queue: Queue | null = null;
  private worker: Worker | null = null;

  /** Wire the worker. Called by the media module only when Redis is present. */
  start(io: TranscodeIO): boolean {
    if (!isRedisConfigured()) {
      this.log.warn('{moment-media}: REDIS_URL absent — transcode queue inert');
      return false;
    }
    const qConn = createRedisConnection();
    const wConn = createRedisConnection();
    if (!qConn || !wConn) {
      this.log.warn('{moment-media}: no redis connection — transcode queue inert');
      return false;
    }
    this.queue = new Queue(MOMENT_MEDIA_QUEUE, { connection: qConn });
    this.worker = new Worker(
      MOMENT_MEDIA_QUEUE,
      async (job: Job<{ mediaId: string }>) => transcodeOne(job.data.mediaId, io),
      { connection: wConn, concurrency: 2 },
    );
    this.worker.on('failed', (job, err) => {
      // Ids and a reason, never the payload — same rule as the 1C DLQ.
      this.log.error(`transcode_failed mediaId=${job?.data?.mediaId ?? 'unknown'} attempts=${job?.attemptsMade ?? 0} reason=${err?.message?.slice(0, 200)}`);
    });
    return true;
  }

  async enqueue(mediaId: string): Promise<{ enqueued: boolean }> {
    if (!this.queue) return { enqueued: false };
    await this.queue.add('transcode', { mediaId }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    });
    return { enqueued: true };
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close().catch(() => undefined);
    await this.queue?.close().catch(() => undefined);
  }
}
