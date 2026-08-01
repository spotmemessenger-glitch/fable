import { Injectable, Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  IStorageAdapter,
  PRESIGN_TTL_SECONDS,
  isSafeSegment,
  parseObjectKey,
} from './storage.interface';

/**
 * Ciphertext in an S3-compatible bucket — Cloudflare R2, AWS S3, or MinIO.
 *
 * PRESIGNED URLS MEAN THE BYTES NEVER TOUCH THIS SERVER. The client PUTs
 * ciphertext straight to the bucket and GETs it straight back; the backend only
 * ever decides WHO may be handed a URL. That is both the performance argument
 * (no proxying megabytes through a Node process) and the privacy one — there is
 * no point in the pipeline where a well-meaning change could start inspecting
 * media, because the media does not pass through it.
 *
 * R2 IS THE INTENDED TARGET, not AWS. R2 charges no egress; S3's egress on a
 * media-heavy messenger is the line item that ends the project. The SDK is the
 * same, so this class covers both — set S3_ENDPOINT to the R2 endpoint.
 *
 * UNVERIFIED AGAINST A REAL BUCKET. No R2 account exists for this project yet,
 * so this adapter has been exercised against a mocked SDK only. It is wired,
 * selectable and tested for shape, and it has never moved a byte. Treat the
 * first real upload as the actual test, exactly as ADR-002 treats Centrifugo.
 */
@Injectable()
export class S3StorageAdapter implements IStorageAdapter {
  readonly name = 's3';
  private readonly log = new Logger(S3StorageAdapter.name);
  private client: S3Client | null = null;

  private get bucket(): string {
    const bucket = process.env.S3_BUCKET;
    if (!bucket) throw new Error('S3_BUCKET is not set');
    return bucket;
  }

  /**
   * Built lazily so the app boots without S3 configured — the adapter is only
   * selected when STORAGE_PROVIDER=s3, and a missing bucket should surface on
   * the first media call with a clear message rather than as a boot crash that
   * takes the whole backend down.
   */
  private s3(): S3Client {
    if (this.client) return this.client;
    const region = process.env.S3_REGION || 'auto';
    const endpoint = process.env.S3_ENDPOINT || undefined;
    const accessKeyId = process.env.S3_ACCESS_KEY_ID;
    const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
    this.client = new S3Client({
      region,
      endpoint,
      // R2 and MinIO need path-style addressing; real S3 does not care.
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true' || Boolean(endpoint),
      credentials: accessKeyId && secretAccessKey
        ? { accessKeyId, secretAccessKey }
        : undefined,
    });
    return this.client;
  }

  async getUploadUrl(objectKey: string, contentType: string): Promise<string> {
    if (!parseObjectKey(objectKey)) throw new Error('invalid object key');
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      // Pinned into the signature so the URL cannot be reused to upload some
      // other kind of object. It is ciphertext either way; this is about the
      // URL being a credential for one specific thing.
      ContentType: contentType || 'application/octet-stream',
    });
    return getSignedUrl(this.s3(), command, { expiresIn: PRESIGN_TTL_SECONDS });
  }

  async getDownloadUrl(objectKey: string): Promise<string> {
    if (!parseObjectKey(objectKey)) throw new Error('invalid object key');
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: objectKey });
    return getSignedUrl(this.s3(), command, { expiresIn: PRESIGN_TTL_SECONDS });
  }

  async deleteObject(objectKey: string): Promise<boolean> {
    if (!parseObjectKey(objectKey)) return false;
    try {
      await this.s3().send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
      return true;
    } catch (err) {
      this.log.warn(`deleteObject failed for ${objectKey}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Delete everything under a room's prefix.
   *
   * Paginated because a busy room exceeds the 1000-key page, and a single-page
   * implementation would silently leave the remainder behind — which for a
   * deleted group means retained ciphertext nobody asked us to keep.
   */
  async deleteRoomObjects(roomId: string): Promise<number> {
    if (!isSafeSegment(roomId)) return 0;
    const Prefix = `rooms/${roomId}/`;
    let deleted = 0;
    let ContinuationToken: string | undefined;
    try {
      do {
        const page = await this.s3().send(new ListObjectsV2Command({
          Bucket: this.bucket, Prefix, ContinuationToken,
        }));
        const keys = (page.Contents || [])
          .map((o) => o.Key)
          .filter((k): k is string => Boolean(k));
        if (keys.length) {
          await this.s3().send(new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true },
          }));
          deleted += keys.length;
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
    } catch (err) {
      this.log.warn(`deleteRoomObjects failed for ${roomId}: ${(err as Error).message}`);
    }
    return deleted;
  }

  /**
   * Every object in the bucket, bounded, with its age — for the orphan sweep.
   *
   * `lastModified` is not decoration: an object is uploaded BEFORE the envelope
   * naming it is written, so a sweep with no notion of age would race a live
   * upload and delete a photo mid-send. The caller applies a grace period.
   *
   * Keys and timestamps, never bytes.
   */
  async listObjects(limit = 10_000): Promise<Array<{ key: string; lastModified: Date }>> {
    const out: Array<{ key: string; lastModified: Date }> = [];
    let ContinuationToken: string | undefined;
    try {
      do {
        const page = await this.s3().send(new ListObjectsV2Command({
          Bucket: this.bucket, Prefix: 'rooms/', ContinuationToken,
        }));
        for (const obj of page.Contents || []) {
          if (!obj.Key) continue;
          out.push({ key: obj.Key, lastModified: obj.LastModified ?? new Date(0) });
          if (out.length >= limit) return out;
        }
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (ContinuationToken);
    } catch (err) {
      this.log.warn(`listObjects failed: ${(err as Error).message}`);
    }
    return out;
  }
}
