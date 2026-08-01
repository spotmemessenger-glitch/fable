import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RoomsService } from '../src/rooms/rooms.service';
import { StorageCleanupService } from '../src/storage/storage-cleanup.service';
import { LocalStorageAdapter } from '../src/storage/local-storage.adapter';
import { buildObjectKey } from '../src/storage/storage.interface';

/**
 * Deleting a message must delete its BYTES — and the sweep must not eat live ones.
 *
 * These are two halves of one hazard. `burnAttachment` removes the RoomEvent
 * rows that point at an attachment; if the objects survive, a "burned" private
 * photo is still sitting in storage with nothing referencing it, which is
 * precisely the state nobody would ever notice. And the sweep that exists to
 * catch those leftovers is itself dangerous: an object is uploaded BEFORE the
 * message naming it is sent, so a sweep with no sense of age would delete
 * photos mid-send.
 *
 * Prisma is stubbed — what is under test is the wiring and the age rule, not
 * Postgres, and the real burn against a real database is already covered by
 * test/view-once.e2e-spec.ts.
 */

const hex = (n: number) =>
  Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

describe('burnAttachment purges stored objects', () => {
  let root: string;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'spotme-purge-'));
    process.env.STORAGE_LOCAL_DIR = root;
    storage = new LocalStorageAdapter();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.STORAGE_LOCAL_DIR;
  });

  /** A Prisma stand-in holding one attachment of three slices. */
  const prismaFor = (once: boolean) => ({
    roomEvent: {
      findFirst: jest.fn(async () => ({ senderId: 'sender1', meta: { once } })),
      findMany: jest.fn(async () => [
        { meta: { seq: 0, total: 3, once } },
        { meta: { seq: 1, total: 3 } },
        { meta: { seq: 2, total: 3 } },
      ]),
      deleteMany: jest.fn(async () => ({ count: 3 })),
    },
    viewOnce: { upsert: jest.fn(async () => ({})) },
  });

  it('deletes every slice object when a view-once attachment burns', async () => {
    const roomId = `room${hex(6)}`;
    const attachId = `att${hex(6)}`;
    for (const seq of [0, 1, 2]) {
      await storage.write(buildObjectKey(roomId, attachId, seq), Buffer.from(`slice-${seq}`));
    }

    const prisma = prismaFor(true);
    const rooms = new RoomsService(prisma as never, storage);
    const destroyed = await rooms.burnAttachment(roomId, attachId, 'viewer1');

    expect(destroyed).toBe(3);
    for (const seq of [0, 1, 2]) {
      expect(await storage.read(buildObjectKey(roomId, attachId, seq))).toBeNull();
    }
  });

  it('leaves objects alone when the attachment is NOT view-once', async () => {
    const roomId = `room${hex(6)}`;
    const attachId = `att${hex(6)}`;
    await storage.write(buildObjectKey(roomId, attachId, 0), Buffer.from('ordinary'));

    const prisma = prismaFor(false);
    const rooms = new RoomsService(prisma as never, storage);
    expect(await rooms.burnAttachment(roomId, attachId, 'viewer1')).toBe(0);
    // A stray meta.burn must not be able to destroy an ordinary attachment.
    expect(await storage.read(buildObjectKey(roomId, attachId, 0))).toEqual(Buffer.from('ordinary'));
  });

  it('still burns when there is no storage adapter at all', async () => {
    const prisma = prismaFor(true);
    const rooms = new RoomsService(prisma as never);
    await expect(rooms.burnAttachment('room1', 'att1', 'viewer1')).resolves.toBe(3);
  });
});

describe('orphan sweep', () => {
  let root: string;
  let storage: LocalStorageAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'spotme-sweep-'));
    process.env.STORAGE_LOCAL_DIR = root;
    storage = new LocalStorageAdapter();
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.STORAGE_LOCAL_DIR;
  });

  /** Backdate a file so it is older than the sweep's grace period. */
  const age = async (key: string, hours: number) => {
    const file = path.resolve(root, key);
    const when = new Date(Date.now() - hours * 3600_000);
    await fs.utimes(file, when, when);
  };

  const sweeperWith = (live: Array<{ roomId: string; attachId: string }>) => {
    const prisma = { roomEvent: { findMany: jest.fn(async () => live) } };
    return new StorageCleanupService(storage, storage, null as never, prisma as never);
  };

  it('deletes an old object whose room events are gone', async () => {
    const key = buildObjectKey('roomOrphan', 'attGone', 0);
    await storage.write(key, Buffer.from('leftover'));
    await age(key, 3);

    const result = await sweeperWith([]).runSweep();
    expect(result.deleted).toBe(1);
    expect(await storage.read(key)).toBeNull();
  });

  it('SPARES a recent object — it is an upload in flight, not an orphan', async () => {
    const key = buildObjectKey('roomLive', 'attNew', 0);
    await storage.write(key, Buffer.from('mid-send'));
    // No backdating: written just now, and its message has not been sent yet.

    const result = await sweeperWith([]).runSweep();
    expect(result.deleted).toBe(0);
    expect(await storage.read(key)).toEqual(Buffer.from('mid-send'));
  });

  it('SPARES an old object that a room event still references', async () => {
    const key = buildObjectKey('roomKeep', 'attKeep', 0);
    await storage.write(key, Buffer.from('referenced'));
    await age(key, 5);

    const result = await sweeperWith([{ roomId: 'roomKeep', attachId: 'attKeep' }]).runSweep();
    expect(result.deleted).toBe(0);
    expect(await storage.read(key)).toEqual(Buffer.from('referenced'));
  });

  it('sweeps orphans while leaving referenced siblings in the same room', async () => {
    const keep = buildObjectKey('roomMixed', 'attKeep', 0);
    const drop = buildObjectKey('roomMixed', 'attDrop', 0);
    await storage.write(keep, Buffer.from('keep'));
    await storage.write(drop, Buffer.from('drop'));
    await age(keep, 4);
    await age(drop, 4);

    const result = await sweeperWith([{ roomId: 'roomMixed', attachId: 'attKeep' }]).runSweep();
    expect(result.deleted).toBe(1);
    expect(await storage.read(keep)).toEqual(Buffer.from('keep'));
    expect(await storage.read(drop)).toBeNull();
  });
});
