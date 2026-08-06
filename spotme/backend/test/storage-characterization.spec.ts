/**
 * CHARACTERIZATION TESTS for the StorageProvider port.
 *
 * These pin the port's OBSERVABLE CONTRACT exactly as it is on master today —
 * key format, presign TTL, adapter names, forbidden surface, error mapping —
 * so any future refactor of the storage layer (adapter swap, port widening,
 * media-seam work) that would change externally visible behaviour fails HERE,
 * loudly, instead of shipping as an accidental contract change.
 *
 * They deliberately assert exact values, not properties: a characterization
 * test's job is to freeze the present, and changing one is a reviewable
 * statement that the contract is intentionally moving. Behavioural coverage
 * (signatures, tamper, expiry, sweeps) lives in storage.spec.ts and the CI
 * MinIO integration; this file is the contract's photograph.
 */
import {
  PRESIGN_TTL_SECONDS,
  FORBIDDEN_STORAGE_SURFACE,
  buildObjectKey,
  parseObjectKey,
  isSafeSegment,
} from '../src/storage/storage.interface';
import { LocalStorageAdapter } from '../src/storage/local-storage.adapter';
import { S3StorageAdapter } from '../src/storage/s3-storage.adapter';

describe('StorageProvider port — characterization (exact observable contract)', () => {
  describe('object keys', () => {
    it('key format is exactly rooms/<roomId>/<attachId>/<seq>', () => {
      expect(buildObjectKey('room_1', 'attach-2', 3)).toBe('rooms/room_1/attach-2/3');
    });

    it('parse is the exact inverse and yields the exact fields', () => {
      expect(parseObjectKey('rooms/room_1/attach-2/3')).toEqual({
        roomId: 'room_1',
        attachId: 'attach-2',
        seq: 3,
      });
    });

    it('segment whitelist is exactly [A-Za-z0-9_-]{1,128}', () => {
      expect(isSafeSegment('A-Za-z0-9_ok')).toBe(true);
      expect(isSafeSegment('a'.repeat(128))).toBe(true);
      expect(isSafeSegment('a'.repeat(129))).toBe(false);
      expect(isSafeSegment('dot.dot')).toBe(false); // '.' excluded by design
      expect(isSafeSegment('slash/em')).toBe(false);
      expect(isSafeSegment('')).toBe(false);
    });

    it('seq bounds are exactly 0..1_000_000 integer', () => {
      expect(buildObjectKey('r', 'a', 0)).toBe('rooms/r/a/0');
      expect(buildObjectKey('r', 'a', 1_000_000)).toBe('rooms/r/a/1000000');
      expect(() => buildObjectKey('r', 'a', -1)).toThrow();
      expect(() => buildObjectKey('r', 'a', 1_000_001)).toThrow();
      expect(() => buildObjectKey('r', 'a', 1.5)).toThrow();
    });
  });

  it('presigned URLs live exactly 5 minutes (300 s)', () => {
    expect(PRESIGN_TTL_SECONDS).toBe(300);
  });

  it('the forbidden surface is exactly the E2EE prohibition list', () => {
    expect([...FORBIDDEN_STORAGE_SURFACE]).toEqual([
      'roomKey', 'deriveKey', 'decrypt', 'encrypt', 'seal', 'open',
      'thumbnail', 'transcode', 'inspect', 'readPlaintext',
    ]);
  });

  describe('adapter identity and error mapping', () => {
    it('adapter names are exactly "local" and "s3"', () => {
      process.env.S3_BUCKET = 'test-bucket';
      try {
        expect(new LocalStorageAdapter().name).toBe('local');
        expect(new S3StorageAdapter().name).toBe('s3');
      } finally {
        delete process.env.S3_BUCKET;
      }
    });

    it('an unissued key is refused BEFORE any store is touched — same mapping both adapters', async () => {
      process.env.S3_BUCKET = 'test-bucket';
      try {
        const s3 = new S3StorageAdapter();
        // Throws the exact message, without constructing an SDK client.
        await expect(s3.getUploadUrl('../../etc/passwd', 'text/plain')).rejects.toThrow('invalid object key');
        await expect(s3.getDownloadUrl('not/a/key')).rejects.toThrow('invalid object key');
        // Deletes map invalid keys to `false`, never a throw (idempotent posture).
        await expect(s3.deleteObject('not/a/key')).resolves.toBe(false);

        const local = new LocalStorageAdapter();
        await expect(local.getUploadUrl('../../etc/passwd', 'text/plain')).rejects.toThrow('invalid object key');
        await expect(local.deleteObject('not/a/key')).resolves.toBe(false);
      } finally {
        delete process.env.S3_BUCKET;
      }
    });
  });
});
