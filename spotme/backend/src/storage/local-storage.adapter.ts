import { Injectable, Logger } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  IStorageAdapter,
  PRESIGN_TTL_SECONDS,
  isSafeSegment,
  parseObjectKey,
} from './storage.interface';

/**
 * Bytes on this machine's disk, for local development and tests.
 *
 * IT STILL SIGNS ITS URLS. The obvious implementation returns
 * `/api/v2/media/local/<objectKey>` and lets the route serve whatever is asked
 * for — at which point "local" quietly means "unauthenticated", the dev
 * environment differs from production in the one dimension that matters, and
 * the first person to test authorisation locally proves nothing. So a URL from
 * here is the same shape of thing a presigned S3 URL is: a bearer credential
 * over one object, expiring, unforgeable without the secret.
 *
 * NO PLAINTEXT, NO KEYS (see storage.interface.ts). This writes the bytes it is
 * handed and reads them back. It never opens them.
 */

/** Where the bytes go. Kept out of the repo tree by default. */
const DEFAULT_ROOT = path.resolve(process.cwd(), '.media');

@Injectable()
export class LocalStorageAdapter implements IStorageAdapter {
  readonly name = 'local';
  private readonly log = new Logger(LocalStorageAdapter.name);
  private readonly root: string;
  private readonly baseUrl: string;

  constructor() {
    this.root = process.env.STORAGE_LOCAL_DIR
      ? path.resolve(process.env.STORAGE_LOCAL_DIR)
      : DEFAULT_ROOT;
    // Relative by default so it works behind any host or tunnel without a
    // second thing to configure and get wrong.
    this.baseUrl = (process.env.STORAGE_LOCAL_BASE_URL || '/api/v2/media/local').replace(/\/$/, '');
  }

  /**
   * The secret that makes a local URL a credential.
   *
   * Read per call rather than cached in the constructor so a test can set it
   * without re-instantiating the provider, and so a deployment that rotates it
   * does not need a restart to take effect.
   */
  private secret(): string {
    return process.env.STORAGE_URL_SECRET || process.env.JWT_ACCESS_SECRET || 'dev-only-secret';
  }

  private sign(objectKey: string, expires: number, method: 'PUT' | 'GET'): string {
    return createHmac('sha256', this.secret())
      .update(`${method}\n${objectKey}\n${expires}`)
      .digest('hex');
  }

  /**
   * Check a signature the route was handed. Constant-time, and it covers the
   * METHOD too — otherwise a download URL would double as an upload URL, and
   * anyone who could read an attachment could overwrite it.
   */
  verify(objectKey: string, expires: number, method: 'PUT' | 'GET', signature: string): boolean {
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    if (typeof signature !== 'string' || signature.length !== 64) return false;
    const expected = Buffer.from(this.sign(objectKey, expires, method), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    if (expected.length !== given.length) return false;
    return timingSafeEqual(expected, given);
  }

  private urlFor(objectKey: string, method: 'PUT' | 'GET'): string {
    const expires = Math.floor(Date.now() / 1000) + PRESIGN_TTL_SECONDS;
    const sig = this.sign(objectKey, expires, method);
    const q = new URLSearchParams({ key: objectKey, expires: String(expires), sig });
    return `${this.baseUrl}?${q.toString()}`;
  }

  async getUploadUrl(objectKey: string, _contentType: string): Promise<string> {
    if (!parseObjectKey(objectKey)) throw new Error('invalid object key');
    return this.urlFor(objectKey, 'PUT');
  }

  async getDownloadUrl(objectKey: string): Promise<string> {
    if (!parseObjectKey(objectKey)) throw new Error('invalid object key');
    return this.urlFor(objectKey, 'GET');
  }

  /**
   * Absolute path for an object key.
   *
   * Two independent defences, because a traversal here writes anywhere the
   * process can reach: the key is re-parsed through the whitelist, AND the
   * resolved path is required to sit under the root. Either alone would
   * probably do; a path bug is not the place to find out which.
   */
  private pathFor(objectKey: string): string | null {
    const parts = parseObjectKey(objectKey);
    if (!parts) return null;
    const full = path.resolve(this.root, 'rooms', parts.roomId, parts.attachId, String(parts.seq));
    const within = path.resolve(this.root) + path.sep;
    return full.startsWith(within) ? full : null;
  }

  /** Write bytes. Used by the local route, never by a remote caller. */
  async write(objectKey: string, bytes: Buffer): Promise<boolean> {
    const file = this.pathFor(objectKey);
    if (!file) return false;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return true;
  }

  /** Read bytes back, or null when absent. */
  async read(objectKey: string): Promise<Buffer | null> {
    const file = this.pathFor(objectKey);
    if (!file) return null;
    try {
      return await fs.readFile(file);
    } catch {
      return null;
    }
  }

  async deleteObject(objectKey: string): Promise<boolean> {
    const file = this.pathFor(objectKey);
    if (!file) return false;
    try {
      await fs.rm(file, { force: true });
      return true;
    } catch (err) {
      this.log.warn(`deleteObject failed for ${objectKey}: ${(err as Error).message}`);
      return false;
    }
  }

  async deleteRoomObjects(roomId: string): Promise<number> {
    if (!isSafeSegment(roomId)) return 0;
    const dir = path.resolve(this.root, 'rooms', roomId);
    if (!dir.startsWith(path.resolve(this.root) + path.sep)) return 0;
    let count = 0;
    try {
      // Counted rather than blind-removed: the caller logs how much media a
      // room deletion actually destroyed, and "0" is a finding worth seeing.
      for (const attach of await fs.readdir(dir)) {
        const sub = path.join(dir, attach);
        try {
          count += (await fs.readdir(sub)).length;
        } catch { /* not a directory — ignore */ }
      }
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      return count; // nothing stored for this room is a normal outcome
    }
    return count;
  }

  /**
   * Every object currently on disk, with its age, for the orphan sweep.
   *
   * `lastModified` is not decoration: an object is uploaded BEFORE the envelope
   * naming it is written, so a sweep with no notion of age would race a live
   * upload and delete a photo mid-send. The caller applies a grace period.
   *
   * Returns keys and timestamps, never bytes: the caller decides what to
   * delete, and this adapter has no business reading anything to decide it.
   */
  async listObjects(limit = 10_000): Promise<Array<{ key: string; lastModified: Date }>> {
    const out: Array<{ key: string; lastModified: Date }> = [];
    const roomsDir = path.resolve(this.root, 'rooms');
    let rooms: string[];
    try {
      rooms = await fs.readdir(roomsDir);
    } catch {
      return out;
    }
    for (const roomId of rooms) {
      if (!isSafeSegment(roomId)) continue;
      let attaches: string[];
      try {
        attaches = await fs.readdir(path.join(roomsDir, roomId));
      } catch { continue; }
      for (const attachId of attaches) {
        if (!isSafeSegment(attachId)) continue;
        let seqs: string[];
        try {
          seqs = await fs.readdir(path.join(roomsDir, roomId, attachId));
        } catch { continue; }
        for (const seq of seqs) {
          if (out.length >= limit) return out;
          try {
            const stat = await fs.stat(path.join(roomsDir, roomId, attachId, seq));
            out.push({ key: `rooms/${roomId}/${attachId}/${seq}`, lastModified: stat.mtime });
          } catch { /* vanished between readdir and stat — already gone */ }
        }
      }
    }
    return out;
  }
}
