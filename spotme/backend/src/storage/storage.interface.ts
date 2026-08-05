/**
 * Spot Me — where encrypted attachment bytes live. Phase 4.
 *
 * Today every slice of every attachment is a `RoomEvent.payload Bytes` row in
 * Postgres. That works and is fully encrypted, but it puts megabytes of opaque
 * blob into the primary database, its backups and its replication stream, and
 * a 25 MB file is ~200 rows of 128 KB. Object storage is where those bytes
 * belong; this interface is the seam that lets them move without the rest of
 * the app knowing which store answered.
 *
 * ---------------------------------------------------------------------------
 * THE ADAPTER NEVER SEES PLAINTEXT, AND NEVER HOLDS A KEY
 *
 * The same rule the transport adapters live under (ADR-002 §2, ADR-001).
 * Sealing happens on the client, in `socket-transport.js`; what arrives here is
 * ciphertext plus routing metadata. An adapter's whole job is to allocate a
 * key-shaped STRING, hand back a URL, and delete bytes when told. It must never
 * derive a room key, decrypt, inspect, transcode or thumbnail anything —
 * generating a thumbnail server-side would require plaintext and is exactly the
 * "helpful" change that silently ends end-to-end encryption.
 *
 * `test/storage.spec.ts` asserts the prohibition rather than trusting this
 * paragraph, the same way `web/test/transport.test.js` does for transports.
 *
 * ---------------------------------------------------------------------------
 * OBJECT KEYS ARE ROOM-SCOPED, AND THAT IS LOAD-BEARING
 *
 * `rooms/<roomId>/<attachId>/<seq>` — because:
 *   - `deleteRoomObjects(roomId)` becomes a prefix sweep, so deleting a group
 *     can actually reach its media;
 *   - a download request carries the roomId INSIDE the key it asks for, so
 *     membership is checked against the thing being fetched rather than against
 *     a roomId the caller also supplies (which they could simply lie about);
 *   - nothing in the key describes the content. The roomId is already the
 *     access model, and attachId already travels in cleartext routing meta.
 */

/** How long a presigned URL stays usable. Short: it is a bearer credential. */
export const PRESIGN_TTL_SECONDS = 5 * 60;

/** Parsed form of an object key. */
export interface ObjectKeyParts {
  roomId: string;
  attachId: string;
  seq: number;
}

/**
 * A path segment we are willing to put on a filesystem or in a bucket.
 *
 * Deliberately a whitelist. `.` is excluded entirely, which kills `..`
 * traversal at the root rather than trying to detect it, and rules out the
 * dot-segments and encoded variants that make traversal filters leak.
 */
export function isSafeSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Build a room-scoped object key.
 *
 * Every component is validated rather than interpolated blindly: these strings
 * become filesystem paths in the local adapter and S3 keys in the other, and an
 * `attachId` of `../../etc/passwd` must not be able to become one.
 */
export function buildObjectKey(roomId: string, attachId: string, seq: number): string {
  if (!isSafeSegment(roomId)) throw new Error('invalid roomId for object key');
  if (!isSafeSegment(attachId)) throw new Error('invalid attachId for object key');
  if (!Number.isInteger(seq) || seq < 0 || seq > 1_000_000) {
    throw new Error('invalid seq for object key');
  }
  return `rooms/${roomId}/${attachId}/${seq}`;
}

/**
 * Parse an object key back, or null if it is not one we issued.
 *
 * Returning null rather than throwing is deliberate: this runs on caller-
 * supplied input from the download route, where an unparseable key is a 403,
 * not a 500.
 */
export function parseObjectKey(objectKey: string): ObjectKeyParts | null {
  if (typeof objectKey !== 'string' || objectKey.length > 512) return null;
  const parts = objectKey.split('/');
  if (parts.length !== 4 || parts[0] !== 'rooms') return null;
  const [, roomId, attachId, rawSeq] = parts;
  if (!isSafeSegment(roomId) || !isSafeSegment(attachId)) return null;
  if (!/^\d{1,7}$/.test(rawSeq)) return null;
  return { roomId, attachId, seq: Number(rawSeq) };
}

/**
 * Moments object keys — `moments/<ownerId>/<mediaId>`.
 *
 * A SEPARATE namespace from `rooms/`, and separately parsed, so the two kinds
 * of object can never be confused for one another: a room key is E2EE
 * ciphertext whose access model is room membership, a moments key is plaintext
 * social media whose access model is the Moments policy. `parseObjectKey`
 * deliberately still rejects these — the chat download route must not serve a
 * moments object, and vice versa.
 */
export function buildMomentObjectKey(ownerId: string, mediaId: string): string {
  if (!isSafeSegment(ownerId)) throw new Error('invalid ownerId for moment object key');
  if (!isSafeSegment(mediaId)) throw new Error('invalid mediaId for moment object key');
  return `moments/${ownerId}/${mediaId}`;
}

/** Parse a moments key back, or null if it is not one we issued. */
export function parseMomentObjectKey(objectKey: string): { ownerId: string; mediaId: string } | null {
  if (typeof objectKey !== 'string' || objectKey.length > 512) return null;
  const parts = objectKey.split('/');
  if (parts.length !== 3 || parts[0] !== 'moments') return null;
  const [, ownerId, mediaId] = parts;
  if (!isSafeSegment(ownerId) || !isSafeSegment(mediaId)) return null;
  return { ownerId, mediaId };
}

/** Either namespace — for the methods both kinds of object legitimately share. */
export function isKnownObjectKey(objectKey: string): boolean {
  return parseObjectKey(objectKey) != null || parseMomentObjectKey(objectKey) != null;
}

/**
 * What every storage backend must provide.
 *
 * Four methods, no more — the narrowness is the same design choice as
 * ITransportAdapter. A wider surface would leak S3's semantics into the
 * interface and the local adapter would become an S3 emulator.
 */
export interface IStorageAdapter {
  /** Adapter name, for logs and for the health/debug surface. */
  readonly name: string;

  /** A short-lived URL the client may PUT ciphertext to. */
  getUploadUrl(objectKey: string, contentType: string): Promise<string>;

  /** A short-lived URL the client may GET ciphertext from. */
  getDownloadUrl(objectKey: string): Promise<string>;

  /**
   * Write bytes the SERVER already holds. Moments only (M1 activation).
   *
   * WHY THIS DOES NOT BREAK THE RULE ABOVE. Chat attachments are ciphertext
   * sealed on the device, so the server has no plaintext to write and this
   * method is never used for them — they keep the presigned-PUT path, and the
   * adapter still cannot decrypt, thumbnail, transcode or inspect anything
   * (FORBIDDEN_STORAGE_SURFACE is unchanged).
   *
   * Moments media is the opposite kind of object BY DESIGN: public social
   * content, not end-to-end encrypted. The server MUST hold its plaintext for
   * one reason — stripping EXIF/GPS before anything is persisted — and a
   * presigned direct-to-bucket upload would put the ORIGINAL, location-bearing
   * file in the bucket untouched. So the bytes travel through the server, get
   * stripped, and are written here. Storing an unstripped original is the
   * failure this method exists to prevent.
   */
  putObject(objectKey: string, bytes: Buffer, contentType: string): Promise<boolean>;

  /** Destroy one object. Idempotent: deleting what is not there is success. */
  deleteObject(objectKey: string): Promise<boolean>;

  /** Destroy every object belonging to a room. Returns how many went. */
  deleteRoomObjects(roomId: string): Promise<number>;
}

/** DI token — the interface is erased at runtime, so injection needs a symbol. */
export const STORAGE_ADAPTER = Symbol('STORAGE_ADAPTER');

/**
 * Members a storage adapter must NOT have.
 *
 * Same reasoning as the transport layer's FORBIDDEN_KEY_SURFACE: the prohibition
 * is only real if something fails when it is broken. An adapter that grows a
 * `decrypt` or a `thumbnail` has stopped being storage and started being a
 * party to the conversation.
 */
export const FORBIDDEN_STORAGE_SURFACE = Object.freeze([
  'roomKey', 'deriveKey', 'decrypt', 'encrypt', 'seal', 'open',
  'thumbnail', 'transcode', 'inspect', 'readPlaintext',
]);
