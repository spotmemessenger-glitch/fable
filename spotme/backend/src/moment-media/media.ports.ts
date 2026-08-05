/**
 * Nearby Moments — media ports (Phase 5B, M1). Provider-neutral interfaces the
 * MediaModule composes ON TOP of the EXISTING Phase 1 storage seam
 * (`IStorageAdapter` behind `STORAGE_ADAPTER`) — no new storage backend, no
 * production credentials. Fixture adapters only this phase.
 */

export interface MediaUploadIntentInput {
  ownerId: string;
  kind: 'image' | 'video';
  mimeType: string;
  sizeBytes: number;
}

/** A presigned upload slot — the contract a client uploads against. */
export interface MediaUploadSlot {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresAtUTC: number;
}

export interface MediaUploadPort {
  createUploadSlot(input: MediaUploadIntentInput): Promise<MediaUploadSlot>;
}

/** Transcode job SPEC (data only — no FFmpeg binary is wired this phase). */
export interface MediaTransformSpec {
  mediaId: string;
  targetMime: 'video/mp4' | 'image/jpeg';
  maxWidth: number;
  maxHeight: number;
  /** Documented arg template for the future worker; NEVER executed here. */
  argsTemplate: string;
}
export interface MediaTransformPort {
  enqueueTransform(spec: MediaTransformSpec): Promise<{ enqueued: boolean }>;
}

/** Thumbnail job SPEC (libvips-shaped; data only, no binary wired). */
export interface ThumbnailSpec {
  mediaId: string;
  maxDim: number;
  argsTemplate: string;
}
export interface ThumbnailPort {
  enqueueThumbnail(spec: ThumbnailSpec): Promise<{ enqueued: boolean }>;
}

/** Story media follows the same pipeline plus the 24h retention stamp. */
export interface StoryMediaPort {
  stampStoryRetention(mediaId: string, expiresAtUTC: number): Promise<void>;
}

/** The composed M1 media port the Moments backend (5C) depends on. */
export interface MomentMediaPort {
  upload: MediaUploadPort;
  transform: MediaTransformPort;
  thumbnail: ThumbnailPort;
  story: StoryMediaPort;
  /** Ingest uploaded bytes: STRIP metadata → hash → dedup → persist. The only
   *  path bytes may take toward storage; originals are never persisted. */
  ingest(mediaId: string, bytes: Buffer, mimeType: string): Promise<IngestResult>;
  /** Release one reference; deletes the asset + object when the last goes. */
  releaseReference(mediaId: string): Promise<{ deleted: boolean }>;
}

export type IngestResult =
  | { state: 'stored'; mediaId: string; contentHash: string; deduplicated: false }
  | { state: 'deduplicated'; mediaId: string; contentHash: string; deduplicated: true; canonicalMediaId: string }
  | { state: 'refused'; reason: 'unsupported-format' | 'too-large' | 'bad-mime' | 'storage-unavailable' };

export const MOMENT_MEDIA_PORT = Symbol('MOMENT_MEDIA_PORT');
