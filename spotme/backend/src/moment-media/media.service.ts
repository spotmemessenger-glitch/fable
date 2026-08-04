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
import { IStorageAdapter, STORAGE_ADAPTER } from '../storage/storage.interface';
import {
  IngestResult, MediaUploadIntentInput, MediaUploadSlot, MediaTransformSpec, ThumbnailSpec,
  MediaUploadPort, MediaTransformPort, ThumbnailPort, StoryMediaPort, MomentMediaPort,
} from './media.ports';
import { stripImageMetadata, UnsupportedImageError } from './exif-strip';
import { FixtureMomentWorkers, TranscodeJob, ThumbnailJob } from './media.queues';

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

  async ingest(mediaId: string, bytes: Buffer, mimeType: string): Promise<IngestResult> {
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
    await this.prisma.momentMediaAsset.create({
      data: { id: mediaId, kind, mimeType, sizeBytes: clean.length, contentHash, storageKey: `moments/assets/${mediaId}`, exifStripped: true },
    });
    // Enqueue the processing CONTRACTS (fixture record — nothing connects).
    if (kind === 'video') {
      await this.enqueueTransform({ mediaId, targetMime: 'video/mp4', maxWidth: 1920, maxHeight: 1920, argsTemplate: 'ffmpeg -i {in} -map_metadata -1 -vf "scale=\'min(1920,iw)\':-2" -movflags +faststart {out}' });
    }
    await this.enqueueThumbnail({ mediaId, maxDim: 512, argsTemplate: 'vipsthumbnail {in} --size 512x512 -o {out}[Q=82,strip]' });
    return { state: 'stored', mediaId, contentHash, deduplicated: false };
  }

  async enqueueTransform(spec: MediaTransformSpec): Promise<{ enqueued: boolean }> {
    const job: TranscodeJob = { name: 'transcode', ...spec };
    await this.workers.process(job);
    return { enqueued: true };
  }

  async enqueueThumbnail(spec: ThumbnailSpec): Promise<{ enqueued: boolean }> {
    const job: ThumbnailJob = { name: 'thumbnail', ...spec };
    await this.workers.process(job);
    return { enqueued: true };
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
