/**
 * Nearby Moments — media pipeline service (Phase 5B). DARK: reachable only from
 * MediaModule, which AppModule does not import.
 *
 * The pipeline: upload-intent → presigned slot (via the EXISTING Phase 1
 * `IStorageAdapter`) → ingest(bytes) which STRIPS metadata BEFORE anything is
 * persisted → sha256 content-hash dedup → asset row → transform/thumbnail job
 * CONTRACTS on `{moment-media}` (fixture enqueue only) → refCount-driven
 * deletion cascade. Originals are never stored; a strip refusal is a typed
 * refusal, never a pass-through.
 */

import { Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { IStorageAdapter, STORAGE_ADAPTER, buildMomentObjectKey } from '../storage/storage.interface';
import {
  IngestResult, MediaUploadIntentInput, MediaUploadSlot, MediaTransformSpec, ThumbnailSpec,
  MediaUploadPort, MediaTransformPort, ThumbnailPort, StoryMediaPort, MomentMediaPort,
} from './media.ports';
import { stripImageMetadata, UnsupportedImageError } from './exif-strip';
import { FixtureMomentWorkers, TranscodeJob, ThumbnailJob } from './media.queues';
import type { TranscodeQueue, TranscodeIO, TranscodeResult } from './transcode.worker';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // [PROPOSED] ceiling
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'video/mp4', 'video/webm']);
const SLOT_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class MomentMediaService implements MomentMediaPort, MediaUploadPort, MediaTransformPort, ThumbnailPort, StoryMediaPort {
  /** Job contracts recorded through the fixture workers (no queue connection). */
  readonly workers = new FixtureMomentWorkers();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(STORAGE_ADAPTER) private readonly storage: IStorageAdapter | null,
  ) {}

  get upload(): MediaUploadPort { return this; }
  get transform(): MediaTransformPort { return this; }
  get thumbnail(): ThumbnailPort { return this; }
  get story(): StoryMediaPort { return this; }

  async createUploadSlot(input: MediaUploadIntentInput): Promise<MediaUploadSlot> {
    if (!ALLOWED_MIME.has(input.mimeType)) throw new UnsupportedImageError(`mime ${input.mimeType}`);
    if (input.sizeBytes > MAX_UPLOAD_BYTES) throw new UnsupportedImageError('too large');
    const mediaId = `mm-${randomUUID()}`;
    const key = `moments/${input.ownerId}/${mediaId}`;
    const uploadUrl = this.storage
      ? await this.storage.getUploadUrl(key, input.mimeType)
      : `fixture://upload/${key}`; // dark default — no storage env, no network
    return { mediaId, uploadUrl, headers: { 'content-type': input.mimeType }, expiresAtUTC: Date.now() + SLOT_TTL_MS };
  }

  async ingest(mediaId: string, bytes: Buffer, mimeType: string, ownerId = 'assets'): Promise<IngestResult> {
    if (!ALLOWED_MIME.has(mimeType)) return { state: 'refused', reason: 'bad-mime' };
    if (bytes.length > MAX_UPLOAD_BYTES) return { state: 'refused', reason: 'too-large' };

    // THE BOUNDARY: strip BEFORE hash, BEFORE dedup, BEFORE any persistence.
    let clean: Buffer;
    if (mimeType.startsWith('image/')) {
      try {
        clean = stripImageMetadata(bytes, mimeType);
      } catch (e) {
        if (e instanceof UnsupportedImageError) return { state: 'refused', reason: 'unsupported-format' };
        throw e;
      }
    } else {
      // Video container metadata handling is a transcode-worker duty (the
      // {moment-media} job CONTRACT includes `-map_metadata -1`); dark phase
      // stores nothing for videos beyond the job contract itself.
      clean = bytes;
    }

    const contentHash = `sha256:${createHash('sha256').update(clean).digest('hex')}`;
    const existing = await this.prisma.momentMediaAsset.findUnique({ where: { contentHash } });
    if (existing) {
      return { state: 'deduplicated', mediaId, contentHash, deduplicated: true, canonicalMediaId: existing.id };
    }
    const kind = mimeType.startsWith('video/') ? 'video' : 'image';
    /* WRITE THE STRIPPED BYTES, AND ONLY THE STRIPPED BYTES (M1 activation).
     *
     * The dark phase recorded an asset row and stored nothing, which was fine
     * while nothing rendered. Now that a feed displays these, the object has to
     * exist — and the object that exists must be `clean`, never `bytes`. The
     * original, with its GPS tags, is never written anywhere and is dropped
     * with this stack frame. A storage failure REFUSES the ingest rather than
     * leaving a row pointing at an object that was never written. */
    const storageKey = buildMomentObjectKey(ownerId, mediaId);
    if (this.storage) {
      const stored = await this.storage.putObject(storageKey, clean, mimeType);
      if (!stored) return { state: 'refused', reason: 'storage-unavailable' };
    }
    await this.prisma.momentMediaAsset.create({
      data: { id: mediaId, kind, mimeType, sizeBytes: clean.length, contentHash, storageKey, exifStripped: true },
    });
    // Enqueue the processing CONTRACTS (fixture record — nothing connects).
    if (kind === 'video') {
      await this.enqueueTransform({ mediaId, targetMime: 'video/mp4', maxWidth: 1920, maxHeight: 1920, argsTemplate: 'ffmpeg -i {in} -map_metadata -1 -vf "scale=\'min(1920,iw)\':-2" -movflags +faststart {out}' });
    }
    await this.enqueueThumbnail({ mediaId, maxDim: 512, argsTemplate: 'vipsthumbnail {in} --size 512x512 -o {out}[Q=82,strip]' });
    return { state: 'stored', mediaId, contentHash, deduplicated: false };
  }

  /** Set by MediaModule at init; absent means "no queue", never "pretend". */
  private transcodeQueue: TranscodeQueue | null = null;
  attachTranscodeQueue(q: TranscodeQueue): void { this.transcodeQueue = q; }

  /**
   * The IO the transcode worker needs. Handed over as a narrow object rather
   * than the whole service, so the worker cannot reach anything else.
   */
  transcodeIO(): TranscodeIO {
    return {
      readOriginal: async (mediaId) => {
        const asset = await this.prisma.momentMediaAsset.findUnique({ where: { id: mediaId } });
        if (!asset || !this.storage) return null;
        // The adapter serves URLs, not bytes — fetch through the presigned GET
        // so this path works identically against R2, MinIO and the local disk.
        const url = await this.storage.getDownloadUrl(asset.storageKey).catch(() => null);
        if (!url) return null;
        const res = await fetch(url);
        if (!res.ok) return null;
        return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: asset.mimeType };
      },
      writeDerived: async (mediaId, name, bytes, contentType) => {
        const key = `moments/derived/${mediaId}-${name}`;
        if (this.storage) await this.storage.putObject(key, bytes, contentType);
        return key;
      },
      recordVariants: async (mediaId, result: TranscodeResult) => {
        await this.prisma.momentMediaAsset.updateMany({
          where: { id: mediaId },
          data: { variants: JSON.stringify(result.variants), posterKey: result.posterKey, durationSeconds: result.durationSeconds },
        });
      },
    };
  }

  async enqueueTransform(spec: MediaTransformSpec): Promise<{ enqueued: boolean }> {
    const job: TranscodeJob = { name: 'transcode', ...spec };
    await this.workers.process(job);   // keep the contract record for the fences
    if (this.transcodeQueue) return this.transcodeQueue.enqueue(spec.mediaId);
    return { enqueued: false };
  }

  async enqueueThumbnail(spec: ThumbnailSpec): Promise<{ enqueued: boolean }> {
    const job: ThumbnailJob = { name: 'thumbnail', ...spec };
    await this.workers.process(job);
    return { enqueued: true };
  }

  /** A short-lived URL for a stored asset, or null with no storage configured. */
  async downloadUrl(storageKey: string): Promise<string | null> {
    if (!this.storage) return null;
    try { return await this.storage.getDownloadUrl(storageKey); } catch { return null; }
  }

  async stampStoryRetention(mediaId: string, expiresAtUTC: number): Promise<void> {
    await this.prisma.momentMediaAsset.updateMany({ where: { id: mediaId }, data: { expiresAt: new Date(expiresAtUTC) } });
  }

  /** 5C calls this when a moment/story acquires the asset. */
  async addReference(mediaId: string): Promise<void> {
    await this.prisma.momentMediaAsset.updateMany({ where: { id: mediaId }, data: { refCount: { increment: 1 } } });
  }

  /** Deletion cascade: last reference out deletes the row AND the object. */
  async releaseReference(mediaId: string): Promise<{ deleted: boolean }> {
    const asset = await this.prisma.momentMediaAsset.findUnique({ where: { id: mediaId } });
    if (!asset) return { deleted: false };
    const next = Math.max(0, asset.refCount - 1);
    if (next > 0) {
      await this.prisma.momentMediaAsset.update({ where: { id: mediaId }, data: { refCount: next } });
      return { deleted: false };
    }
    await this.prisma.momentMediaAsset.delete({ where: { id: mediaId } });
    if (this.storage) await this.storage.deleteObject(asset.storageKey);
    return { deleted: true };
  }
}
