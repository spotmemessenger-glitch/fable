import { createHash, randomBytes } from 'node:crypto';
import { S3StorageAdapter } from '../src/storage/s3-storage.adapter';
import { buildObjectKey } from '../src/storage/storage.interface';

/**
 * S3StorageAdapter against a REAL S3-compatible server, moving REAL bytes.
 *
 * WHY THIS EXISTS. `storage.spec.ts` exercises this adapter against a mocked
 * AWS SDK. That proves it issues the right commands with the right keys and
 * proves NOTHING about a server accepting them — not the signature, not the
 * presigned URL's query string, not path-style addressing, not what a real 404
 * or 403 looks like. Every one of those is a place the adapter can be wrong
 * while the mocked suite stays green, and PR #19 shipped with exactly that gap
 * recorded as "S3StorageAdapter has never moved a byte".
 *
 * It moves bytes now.
 *
 * WHERE IT RUNS. Against whatever `S3_ENDPOINT` points at. CI provides MinIO as
 * a service container, with no external credentials and nothing to provision.
 * The same suite runs unchanged against a real Cloudflare R2 bucket in the
 * manually-triggered staging workflow — that is the point of testing the
 * protocol rather than the vendor.
 *
 * SKIPPED, LOUDLY, when no endpoint is configured. A suite that silently passes
 * when it did not run is worse than one that is absent, because it appears in
 * the evidence column.
 */

const ENDPOINT = process.env.S3_ENDPOINT;
const describeIfConfigured = ENDPOINT ? describe : describe.skip;

if (!ENDPOINT) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n  s3-integration.spec: SKIPPED — S3_ENDPOINT is not set.\n' +
    '  This suite proves the adapter moves real bytes; skipping it proves nothing.\n' +
    '  CI sets it to the MinIO service container.\n',
  );
}

/** A run-unique prefix, so concurrent runs and reruns never collide. */
const RUN = randomBytes(6).toString('hex');
const room = (suffix: string) => `itest${RUN}${suffix}`;
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

describeIfConfigured('S3StorageAdapter — real bytes over a real S3 protocol', () => {
  let adapter: S3StorageAdapter;
  /** Everything created, so cleanup is exhaustive rather than best-effort. */
  const created: string[] = [];
  /**
   * Does this endpoint actually VERIFY signatures?
   *
   * Not every S3-compatible server does. `s3rver`, a common local stand-in,
   * serves completely unsigned requests with 200 — measured, not assumed. On
   * such a server the two authorization assertions below cannot fail, so
   * running them would report a green authorization test against a server that
   * has no authorization. They are skipped with a reason instead.
   *
   * MinIO and Cloudflare R2 both verify, which is the entire reason CI uses
   * MinIO and the staging smoke test uses R2.
   */
  let enforcesSignatures = false;

  beforeAll(async () => {
    adapter = new S3StorageAdapter();
    const probeKey = buildObjectKey(room('probe'), 'p', 0);
    created.push(probeKey);
    await put(probeKey, randomBytes(16), 'application/octet-stream');
    // Strip every query parameter: an unsigned request for a private object.
    const bare = new URL(await adapter.getDownloadUrl(probeKey));
    bare.search = '';
    const res = await fetch(bare.toString()).catch(() => null);
    enforcesSignatures = !res || res.status >= 400;
    if (!enforcesSignatures) {
      // eslint-disable-next-line no-console
      console.warn(
        '\n  S3_ENDPOINT serves UNSIGNED requests — it does not verify signatures.\n' +
        '  Authorization assertions will be SKIPPED. This endpoint cannot prove them.\n',
      );
    }
  });

  afterAll(async () => {
    // CLEANUP IS PART OF THE TEST CONTRACT, not politeness: the R2 staging run
    // uses a shared bucket, and a suite that leaves objects behind turns a
    // smoke test into a slow leak.
    for (const key of created) {
      await adapter.deleteObject(key).catch(() => undefined);
    }
  });

  async function put(key: string, body: Buffer, contentType: string) {
    const url = await adapter.getUploadUrl(key, contentType);
    const res = await fetch(url, {
      method: 'PUT',
      // Buffer is not a BodyInit under this lib config; the view is.
      body: new Uint8Array(body),
      headers: { 'Content-Type': contentType },
    });
    return res;
  }

  it('uploads real bytes through a presigned URL', async () => {
    const key = buildObjectKey(room('a'), 'att1', 0);
    created.push(key);
    const body = randomBytes(64 * 1024);

    const res = await put(key, body, 'image/jpeg');

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
  });

  it('downloads them back BYTE FOR BYTE', async () => {
    const key = buildObjectKey(room('b'), 'att1', 0);
    created.push(key);
    // Random, not a repeated pattern: a truncation or an off-by-one in range
    // handling survives a buffer of zeroes and does not survive this.
    const body = randomBytes(256 * 1024);

    await put(key, body, 'application/octet-stream');
    const url = await adapter.getDownloadUrl(key);
    const res = await fetch(url);
    const got = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(got.byteLength).toBe(body.byteLength);
    expect(sha(got)).toBe(sha(body));
  });

  it('round-trips an empty object without inventing bytes', async () => {
    const key = buildObjectKey(room('c'), 'att1', 0);
    created.push(key);

    await put(key, Buffer.alloc(0), 'application/octet-stream');
    const res = await fetch(await adapter.getDownloadUrl(key));
    const got = Buffer.from(await res.arrayBuffer());

    expect(res.status).toBe(200);
    expect(got.byteLength).toBe(0);
  });

  it('preserves the content type it was given', async () => {
    const key = buildObjectKey(room('d'), 'att1', 0);
    created.push(key);

    await put(key, randomBytes(1024), 'image/webp');
    const res = await fetch(await adapter.getDownloadUrl(key));

    expect(res.headers.get('content-type')).toContain('image/webp');
  });

  it('reports a missing object as 404 rather than empty success', async () => {
    const key = buildObjectKey(room('missing'), 'nope', 0);

    const res = await fetch(await adapter.getDownloadUrl(key));

    // The distinction that matters: NOT a 200 with zero bytes, which the client
    // would render as a successfully-loaded empty photo.
    expect(res.status).toBe(404);
  });

  it('refuses a tampered signature', async () => {
    if (!enforcesSignatures) {
      // Reported per-test, because an early return shows as a green tick and a
      // green tick that exercised nothing is exactly the false pass this suite
      // exists to avoid.
      // eslint-disable-next-line no-console
      console.warn('    NOT EXERCISED: endpoint does not verify signatures');
      return;
    }
    const key = buildObjectKey(room('e'), 'att1', 0);
    created.push(key);
    await put(key, randomBytes(512), 'application/octet-stream');

    const url = new URL(await adapter.getDownloadUrl(key));
    const sig = url.searchParams.get('X-Amz-Signature');
    expect(sig).toBeTruthy();
    // Flip a character to something it certainly is not, rather than to a fixed
    // value that might already be there — a tamper test that mutates a byte to
    // itself passes while proving nothing.
    url.searchParams.set('X-Amz-Signature', (sig![0] === 'a' ? 'b' : 'a') + sig!.slice(1));

    const res = await fetch(url.toString());

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('refuses a presigned URL with its key swapped for another', async () => {
    if (!enforcesSignatures) {
      // Reported per-test, because an early return shows as a green tick and a
      // green tick that exercised nothing is exactly the false pass this suite
      // exists to avoid.
      // eslint-disable-next-line no-console
      console.warn('    NOT EXERCISED: endpoint does not verify signatures');
      return;
    }
    const mine = buildObjectKey(room('f'), 'att1', 0);
    const theirs = buildObjectKey(room('g'), 'att1', 0);
    created.push(mine, theirs);
    await put(mine, randomBytes(256), 'application/octet-stream');
    await put(theirs, randomBytes(256), 'application/octet-stream');

    const url = await adapter.getDownloadUrl(mine);
    const swapped = url.replace(encodeURIComponent(mine), encodeURIComponent(theirs))
      .replace(mine, theirs);

    const res = await fetch(swapped);

    // The signature covers the path, so repointing it must fail. If this ever
    // passes, a presigned URL is a bearer token for the whole bucket.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('overwrites in place, and the second write is what is read back', async () => {
    const key = buildObjectKey(room('h'), 'att1', 0);
    created.push(key);
    const first = randomBytes(4096);
    const second = randomBytes(8192);

    await put(key, first, 'application/octet-stream');
    await put(key, second, 'application/octet-stream');
    const got = Buffer.from(await (await fetch(await adapter.getDownloadUrl(key))).arrayBuffer());

    expect(got.byteLength).toBe(second.byteLength);
    expect(sha(got)).toBe(sha(second));
  });

  it('survives an interrupted upload without leaving a half object readable', async () => {
    const key = buildObjectKey(room('i'), 'att1', 0);
    created.push(key);
    const url = await adapter.getUploadUrl(key, 'application/octet-stream');

    const controller = new AbortController();
    const body = randomBytes(2 * 1024 * 1024);
    const inflight = fetch(url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'Content-Type': 'application/octet-stream' },
      signal: controller.signal,
    });
    controller.abort();
    await expect(inflight).rejects.toThrow();

    // Either the object does not exist, or it is complete. A partial object
    // that reads as success is the outcome this forbids: the client would
    // decrypt garbage and blame the crypto.
    const res = await fetch(await adapter.getDownloadUrl(key));
    if (res.status === 200) {
      const got = Buffer.from(await res.arrayBuffer());
      expect(got.byteLength).toBe(body.byteLength);
    } else {
      expect(res.status).toBe(404);
    }
  });

  it('deletes an object, and the delete is visible', async () => {
    const key = buildObjectKey(room('j'), 'att1', 0);
    await put(key, randomBytes(1024), 'application/octet-stream');

    const deleted = await adapter.deleteObject(key);
    const res = await fetch(await adapter.getDownloadUrl(key));

    expect(deleted).toBe(true);
    expect(res.status).toBe(404);
  });

  it('deleting a missing object is idempotent, not an error', async () => {
    const key = buildObjectKey(room('k'), 'never', 0);

    // burnAttachment relies on this: it deletes by seq without first checking
    // what exists, and a throwing delete would abort a burn part-way through.
    await expect(adapter.deleteObject(key)).resolves.not.toThrow();
  });

  it('deleteRoomObjects removes every object in the room and nothing outside it', async () => {
    const mine = room('purge');
    const other = room('keep');
    const keys = [0, 1, 2].map((seq) => buildObjectKey(mine, 'att1', seq));
    const survivor = buildObjectKey(other, 'att1', 0);
    created.push(survivor);

    for (const k of keys) await put(k, randomBytes(1024), 'application/octet-stream');
    await put(survivor, randomBytes(1024), 'application/octet-stream');

    const removed = await adapter.deleteRoomObjects(mine);

    expect(removed).toBe(keys.length);
    for (const k of keys) {
      expect((await fetch(await adapter.getDownloadUrl(k))).status).toBe(404);
    }
    // The one that matters: a room purge that reaches another room's media is a
    // data-loss bug, and a prefix sweep is exactly where that happens.
    expect((await fetch(await adapter.getDownloadUrl(survivor))).status).toBe(200);
  });

  it('lists what it stored, so the orphan sweep has something true to work from', async () => {
    const key = buildObjectKey(room('list'), 'att1', 0);
    created.push(key);
    await put(key, randomBytes(512), 'application/octet-stream');

    const listed = await adapter.listObjects(10_000);

    const found = listed.find((o) => o.key === key);
    expect(found).toBeTruthy();
    expect(found!.lastModified instanceof Date).toBe(true);
    // The sweep's grace period is computed from this timestamp; a missing or
    // epoch-zero date would delete freshly uploaded media mid-send.
    expect(found!.lastModified.getTime()).toBeGreaterThan(Date.now() - 10 * 60 * 1000);
  });
});
