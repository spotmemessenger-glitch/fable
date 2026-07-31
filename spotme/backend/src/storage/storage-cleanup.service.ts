import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { LocalStorageAdapter } from './local-storage.adapter';
import { S3StorageAdapter } from './s3-storage.adapter';
import { IStorageAdapter, STORAGE_ADAPTER, parseObjectKey } from './storage.interface';

/**
 * Sweep stored objects whose parent room events are gone. Phase 4 §3.3.
 *
 * WHY AN ORPHAN IS POSSIBLE AT ALL. Deletion happens in two places that can
 * disagree: `burnAttachment` removes RoomEvent rows and then asks storage to
 * drop the bytes, and a group hard-delete does the same for a whole room. If
 * the second half fails — bucket unreachable, process killed between the two —
 * the rows are gone and the ciphertext stays. Nothing would ever notice,
 * because nothing reads an object without a row pointing at it. That is the
 * definition of a leak that does not show up in testing.
 *
 * ---------------------------------------------------------------------------
 * THE GRACE PERIOD IS THE WHOLE SAFETY ARGUMENT
 *
 * An object is uploaded BEFORE the envelope naming it exists — the client
 * presigns, PUTs the slice, and only then sends the message. For that window an
 * object legitimately has no RoomEvent, and a sweep without a notion of age
 * would delete photos mid-send. So only objects older than GRACE_MS are
 * considered, and the sweep is a no-op for anything recent.
 *
 * It also never deletes more than MAX_DELETES_PER_RUN. A sweep that suddenly
 * decides everything is an orphan — a bad migration, an empty database, a
 * mis-parsed key — should cost a bounded amount of damage and leave a loud log,
 * not run to completion at machine speed.
 */

/** An object with no envelope for this long is genuinely unreferenced. */
const GRACE_MS = 60 * 60 * 1000;

/** Bounded per run, both for safety and to keep one sweep off the event loop. */
const MAX_SCAN_PER_RUN = 5_000;
const MAX_DELETES_PER_RUN = 500;

@Injectable()
export class StorageCleanupService {
  private readonly log = new Logger(StorageCleanupService.name);
  private running = false;

  constructor(
    @Inject(STORAGE_ADAPTER) private storage: IStorageAdapter,
    private local: LocalStorageAdapter,
    private s3: S3StorageAdapter,
    private prisma: PrismaService,
  ) {}

  /**
   * Listing is not part of IStorageAdapter — it is a maintenance concern, and
   * widening the interface for one caller is how a four-method contract becomes
   * a filesystem API. The concrete adapters are resolved here instead.
   */
  private lister(): { listObjects(limit?: number): Promise<Array<{ key: string; lastModified: Date }>> } | null {
    if (this.storage.name === 'local') return this.local;
    if (this.storage.name === 's3') return this.s3;
    return null;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async sweep(): Promise<{ scanned: number; deleted: number } | null> {
    // Overlap protection: an hourly cron plus a slow bucket is how two sweeps
    // end up racing each other's deletes.
    if (this.running) {
      this.log.warn('sweep already running — skipping this tick');
      return null;
    }
    this.running = true;
    try {
      return await this.runSweep();
    } catch (err) {
      this.log.error(`sweep failed: ${(err as Error).message}`);
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Exposed for tests and for an operator who wants to run it on demand. */
  async runSweep(): Promise<{ scanned: number; deleted: number }> {
    const lister = this.lister();
    if (!lister) return { scanned: 0, deleted: 0 };

    const cutoff = Date.now() - GRACE_MS;
    const objects = await lister.listObjects(MAX_SCAN_PER_RUN);
    const stale = objects.filter((o) => o.lastModified.getTime() < cutoff);
    if (!stale.length) return { scanned: objects.length, deleted: 0 };

    // One query for the whole batch rather than one per object: a sweep that
    // does 5,000 round trips is a sweep somebody turns off.
    const wanted = new Map<string, { roomId: string; attachId: string }>();
    for (const obj of stale) {
      const parts = parseObjectKey(obj.key);
      if (parts) wanted.set(`${parts.roomId}/${parts.attachId}`, parts);
    }
    if (!wanted.size) return { scanned: objects.length, deleted: 0 };

    const live = await this.prisma.roomEvent.findMany({
      where: {
        type: 'bin',
        OR: [...wanted.values()].map((p) => ({ roomId: p.roomId, attachId: p.attachId })),
      },
      select: { roomId: true, attachId: true },
      distinct: ['roomId', 'attachId'],
    });
    const alive = new Set(live.map((r) => `${r.roomId}/${r.attachId}`));

    let deleted = 0;
    for (const obj of stale) {
      if (deleted >= MAX_DELETES_PER_RUN) {
        this.log.warn(`hit the ${MAX_DELETES_PER_RUN}-delete ceiling — more orphans remain`);
        break;
      }
      const parts = parseObjectKey(obj.key);
      if (!parts) continue;
      if (alive.has(`${parts.roomId}/${parts.attachId}`)) continue;
      if (await this.storage.deleteObject(obj.key)) deleted++;
    }

    if (deleted) this.log.log(`orphan sweep: removed ${deleted} of ${objects.length} objects`);
    return { scanned: objects.length, deleted };
  }
}
