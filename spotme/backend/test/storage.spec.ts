import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LocalStorageAdapter } from '../src/storage/local-storage.adapter';
import {
  FORBIDDEN_STORAGE_SURFACE,
  buildObjectKey,
  parseObjectKey,
  isSafeSegment,
} from '../src/storage/storage.interface';

/**
 * Storage adapters: key hygiene, URL credentials, and the prohibition.
 *
 * THE KEY FORMAT IS A SECURITY CONTROL, NOT A NAMING CONVENTION. An object key
 * becomes a filesystem path in the local adapter and an S3 key in the other, and
 * the download route parses one out of attacker-controlled input to decide WHICH
 * ROOM to check membership against. So `..`, absolute paths and separator tricks
 * are tested here rather than assumed away.
 *
 * The S3 adapter is exercised against a mocked SDK — no bucket exists for this
 * project yet. That proves it calls the right commands with the right keys, and
 * proves nothing about R2 accepting them.
 */

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async (_client: unknown, command: { input?: Record<string, unknown> }) =>
    `https://bucket.example/${String(command?.input?.Key)}?X-Amz-Signature=stub`),
}));

describe('object keys', () => {
  it('accepts the ids the app actually generates', () => {
    expect(buildObjectKey('dm-abc123', 'att-9f3a', 0)).toBe('rooms/dm-abc123/att-9f3a/0');
    expect(parseObjectKey('rooms/dm-abc123/att-9f3a/7'))
      .toEqual({ roomId: 'dm-abc123', attachId: 'att-9f3a', seq: 7 });
  });

  it('refuses traversal in either segment', () => {
    expect(() => buildObjectKey('..', 'att', 0)).toThrow();
    expect(() => buildObjectKey('room', '../../etc/passwd', 0)).toThrow();
    expect(() => buildObjectKey('room/../other', 'att', 0)).toThrow();
    expect(isSafeSegment('..')).toBe(false);
    expect(isSafeSegment('a.b')).toBe(false);      // no dots at all, so no dot-segments
    expect(isSafeSegment('a/b')).toBe(false);
    expect(isSafeSegment('a\\b')).toBe(false);
    expect(isSafeSegment('')).toBe(false);
    expect(isSafeSegment('a'.repeat(129))).toBe(false);
  });

  it('refuses a negative, fractional or absurd slice number', () => {
    expect(() => buildObjectKey('room', 'att', -1)).toThrow();
    expect(() => buildObjectKey('room', 'att', 1.5)).toThrow();
    expect(() => buildObjectKey('room', 'att', 9_999_999)).toThrow();
  });

  it('parse() returns null rather than throwing on hostile input', () => {
    for (const bad of [
      'rooms/../../../etc/passwd/0',
      '/etc/passwd',
      'rooms/room/att',                 // too few segments
      'rooms/room/att/0/extra',         // too many
      'other/room/att/0',               // wrong root
      'rooms/room/att/notanumber',
      'rooms/room/att/-1',
      `rooms/${'a'.repeat(600)}/att/0`,
    ]) {
      expect(parseObjectKey(bad)).toBeNull();
    }
    expect(parseObjectKey(undefined as unknown as string)).toBeNull();
  });
});

describe('LocalStorageAdapter', () => {
  let adapter: LocalStorageAdapter;
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'spotme-storage-'));
    process.env.STORAGE_LOCAL_DIR = root;
    process.env.STORAGE_URL_SECRET = 'test-secret';
    adapter = new LocalStorageAdapter();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.STORAGE_LOCAL_DIR;
    delete process.env.STORAGE_URL_SECRET;
  });

  it('exposes none of the forbidden key surface', () => {
    for (const banned of FORBIDDEN_STORAGE_SURFACE) {
      expect((adapter as unknown as Record<string, unknown>)[banned]).toBeUndefined();
    }
  });

  it('round-trips bytes it is given, unchanged', async () => {
    const key = buildObjectKey('room1', 'att1', 0);
    const bytes = Buffer.from('encrypted-ciphertext-bytes');
    expect(await adapter.write(key, bytes)).toBe(true);
    expect(await adapter.read(key)).toEqual(bytes);
  });

  it('signs URLs, and a tampered signature is refused', async () => {
    const key = buildObjectKey('room1', 'att1', 0);
    const url = await adapter.getUploadUrl(key, 'application/octet-stream');
    const q = new URLSearchParams(url.split('?')[1]);
    const expires = Number(q.get('expires'));
    const sig = String(q.get('sig'));

    // The flip must actually CHANGE the last character — `replace(/.$/, '0')`
    // is a no-op roughly one time in sixteen, and a test that passes because it
    // compared a signature with itself is worse than no test.
    const tampered = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(tampered).not.toBe(sig);

    expect(adapter.verify(key, expires, 'PUT', sig)).toBe(true);
    expect(adapter.verify(key, expires, 'PUT', tampered)).toBe(false);
    expect(adapter.verify(key, expires, 'PUT', '')).toBe(false);
  });

  it('a DOWNLOAD url cannot be replayed as an UPLOAD', async () => {
    const key = buildObjectKey('room1', 'att1', 0);
    const url = await adapter.getDownloadUrl(key);
    const q = new URLSearchParams(url.split('?')[1]);
    // Same key, same expiry, same signature — only the method differs.
    expect(adapter.verify(key, Number(q.get('expires')), 'GET', String(q.get('sig')))).toBe(true);
    expect(adapter.verify(key, Number(q.get('expires')), 'PUT', String(q.get('sig')))).toBe(false);
  });

  it('a signature for one object does not open another', async () => {
    const a = buildObjectKey('room1', 'att1', 0);
    const b = buildObjectKey('room2', 'att2', 0);
    const q = new URLSearchParams((await adapter.getDownloadUrl(a)).split('?')[1]);
    expect(adapter.verify(b, Number(q.get('expires')), 'GET', String(q.get('sig')))).toBe(false);
  });

  it('refuses an expired url even when the signature is correct', async () => {
    const key = buildObjectKey('room1', 'att1', 0);
    const past = Math.floor(Date.now() / 1000) - 10;
    // A genuinely valid signature for a past expiry: the HMAC is right, the
    // clock is not. Expiry has to be checked independently of the signature.
    const forged = createHmac('sha256', 'test-secret')
      .update(`GET\n${key}\n${past}`)
      .digest('hex');
    expect(adapter.verify(key, past, 'GET', forged)).toBe(false);
  });

  it('never writes outside its root, whatever it is handed', async () => {
    for (const evil of ['rooms/../../escape/att/0', '../../../escape', 'rooms/room/../../att/0']) {
      expect(await adapter.write(evil, Buffer.from('x'))).toBe(false);
    }
    const escaped = path.resolve(root, '..', 'escape');
    await expect(fs.access(escaped)).rejects.toBeDefined();
  });

  it('deleteObject is idempotent — burning twice is not an error', async () => {
    const key = buildObjectKey('room1', 'att1', 0);
    await adapter.write(key, Buffer.from('bytes'));
    expect(await adapter.deleteObject(key)).toBe(true);
    expect(await adapter.deleteObject(key)).toBe(true);
    expect(await adapter.read(key)).toBeNull();
  });

  it('deleteRoomObjects takes the whole room and leaves other rooms alone', async () => {
    await adapter.write(buildObjectKey('roomA', 'att1', 0), Buffer.from('a0'));
    await adapter.write(buildObjectKey('roomA', 'att1', 1), Buffer.from('a1'));
    await adapter.write(buildObjectKey('roomA', 'att2', 0), Buffer.from('a2'));
    await adapter.write(buildObjectKey('roomB', 'att1', 0), Buffer.from('b0'));

    expect(await adapter.deleteRoomObjects('roomA')).toBe(3);
    expect(await adapter.read(buildObjectKey('roomA', 'att1', 0))).toBeNull();
    expect(await adapter.read(buildObjectKey('roomB', 'att1', 0))).toEqual(Buffer.from('b0'));
  });

  it('listObjects reports ages, which is what makes the orphan sweep safe', async () => {
    await adapter.write(buildObjectKey('roomA', 'att1', 0), Buffer.from('x'));
    const objects = await adapter.listObjects();
    expect(objects).toHaveLength(1);
    expect(objects[0].key).toBe('rooms/roomA/att1/0');
    expect(objects[0].lastModified.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('S3StorageAdapter (mocked SDK — no bucket exists)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { S3StorageAdapter } = require('../src/storage/s3-storage.adapter');
  let adapter: InstanceType<typeof S3StorageAdapter>;

  beforeEach(() => {
    process.env.S3_BUCKET = 'test-bucket';
    process.env.S3_ENDPOINT = 'https://example.r2.cloudflarestorage.com';
    adapter = new S3StorageAdapter();
  });
  afterEach(() => {
    delete process.env.S3_BUCKET;
    delete process.env.S3_ENDPOINT;
  });

  it('exposes none of the forbidden key surface', () => {
    for (const banned of FORBIDDEN_STORAGE_SURFACE) {
      expect((adapter as unknown as Record<string, unknown>)[banned]).toBeUndefined();
    }
  });

  it('presigns PUT and GET for the exact key asked for', async () => {
    const key = buildObjectKey('room1', 'att1', 3);
    expect(await adapter.getUploadUrl(key, 'application/octet-stream')).toContain(key);
    expect(await adapter.getDownloadUrl(key)).toContain(key);
  });

  it('refuses to presign a key it did not issue', async () => {
    await expect(adapter.getUploadUrl('rooms/../../etc/passwd/0', 'x')).rejects.toThrow();
    await expect(adapter.getDownloadUrl('/etc/passwd')).rejects.toThrow();
  });
});
