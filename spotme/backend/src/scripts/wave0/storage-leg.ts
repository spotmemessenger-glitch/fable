/**
 * Wave 0 — R2 / object-storage leg.
 *
 * Exercises the REAL storage port (`S3StorageAdapter`, the same class the app
 * injects as `STORAGE_ADAPTER`), not a bespoke S3 client. It:
 *   - proves `STORAGE_PROVIDER=s3` actually takes effect rather than silently
 *     falling back to local storage (the exact failure this wave exists to
 *     catch — see `storage.module.ts`);
 *   - round-trips a synthetic object under a `wave0`-namespaced key, presigned
 *     PUT then presigned GET, and checks byte integrity (sha256 in == out);
 *   - runs an EXIF smoke: uploads bytes carrying a controlled EXIF sentinel and
 *     reports whether it survives the round trip;
 *   - deletes ONLY the object it created and confirms the delete took.
 *
 * The port enforces `rooms/<roomId>/<attachId>/<seq>` keys, so the wave0
 * namespace is expressed as the roomId segment (`rooms/wave0-.../...`). Nothing
 * else in the bucket is listed, inspected, or touched.
 */

import { createHash, randomBytes } from 'node:crypto';
import { S3StorageAdapter } from '../../storage/s3-storage.adapter';
import { buildObjectKey } from '../../storage/storage.interface';
import { LegResult, redactUrlMeta, round2, timed } from './guard';

/** ASCII sentinel embedded in a minimal EXIF APP1 segment. */
const EXIF_SENTINEL = 'WAVE0_EXIF_ARTIST_wave0-synthetic';

/**
 * A tiny synthetic JPEG-shaped buffer carrying a controlled EXIF APP1 segment.
 * Not a decodable photo — storage treats every byte as opaque ciphertext — but
 * it carries a real APP1 "Exif\0\0" marker plus a recognisable sentinel so we
 * can prove whether metadata survives a storage round trip.
 */
function syntheticExifImage(): Buffer {
  const soi = Buffer.from([0xff, 0xd8]); // Start of Image
  const exifBody = Buffer.concat([
    Buffer.from('Exif\0\0', 'latin1'),
    Buffer.from(EXIF_SENTINEL, 'latin1'),
  ]);
  const len = exifBody.length + 2; // APP1 length includes the 2 length bytes
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]),
    exifBody,
  ]);
  const payload = randomBytes(4096); // stand-in for pixel data
  const eoi = Buffer.from([0xff, 0xd9]); // End of Image
  return Buffer.concat([soi, app1, payload, eoi]);
}

function sha256(b: Buffer | Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * Replicate storage.module.ts's provider decision WITHOUT booting Nest, so we
 * can report which adapter the app would actually select — the silent-fallback
 * check. A real S3 round trip below is the definitive proof; this makes the
 * reason legible.
 */
function selectedProvider(): { requested: string; selects: 's3' | 'local'; reason: string } {
  const requested = (process.env.STORAGE_PROVIDER || 'local').trim().toLowerCase();
  if (requested === 's3') {
    if (!process.env.S3_BUCKET) return { requested, selects: 'local', reason: 'STORAGE_PROVIDER=s3 but S3_BUCKET unset — silent fallback to local' };
    return { requested, selects: 's3', reason: 'STORAGE_PROVIDER=s3 and S3_BUCKET set' };
  }
  return { requested, selects: 'local', reason: `STORAGE_PROVIDER="${requested}" — not s3` };
}

export async function runStorageLeg(): Promise<LegResult> {
  const notes: string[] = [];
  const detail: Record<string, unknown> = {
    endpoint: redactUrlMeta('S3_ENDPOINT'),
    bucketSet: Boolean(process.env.S3_BUCKET),
    provider: selectedProvider(),
  };

  const provider = detail.provider as ReturnType<typeof selectedProvider>;
  if (provider.selects !== 's3') {
    notes.push(`SILENT-FALLBACK RISK: ${provider.reason}. Storage leg cannot prove S3 — aborting before any write.`);
    return { leg: 'storage', status: 'FAIL', detail, notes };
  }

  const adapter = new S3StorageAdapter();
  const roomId = `wave0-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  const key = buildObjectKey(roomId, 'smoke', 0);
  detail.objectKey = key;
  const image = syntheticExifImage();
  detail.uploadedSha256 = sha256(image);
  detail.uploadedBytes = image.length;

  // ---- presigned PUT ----
  const put = await timed(async () => {
    const url = await adapter.getUploadUrl(key, 'application/octet-stream');
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array(image),
    });
    if (!res.ok) {
      // R2 error bodies are XML diagnostics (no secrets) — capture, bounded.
      const body = await res.text().catch(() => '');
      detail.putErrorBody = body.slice(0, 300);
      throw new Error(`PUT status ${res.status}`);
    }
    return res.status;
  });
  detail.putMs = round2(put.ms);
  detail.putStatus = put.value ?? null;
  if (put.error) {
    const body = String(detail.putErrorBody ?? '');
    // A credential-shaped rejection is a variable-VALUE misconfiguration (owner
    // fixes it — variables are owner-only), not a code fault. Report as BLOCKED
    // with the exact remedy rather than a generic failure.
    if (/access key has length|InvalidAccessKeyId|SignatureDoesNotMatch|should be \d+/i.test(body)) {
      notes.push(
        `upload rejected by R2 for a credential reason: "${body.replace(/\s+/g, ' ').trim()}". ` +
          'OWNER REMEDY: the storage port, presigning, and STORAGE_PROVIDER=s3 selection all work — ' +
          'this is a variable VALUE problem. Verify S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY on the ' +
          'api service (R2 access key IDs are 32 chars, secrets 64 — the two look swapped). ' +
          'Variables are owner-only; re-run this leg after correcting them.',
      );
      return { leg: 'storage', status: 'BLOCKED', detail, notes };
    }
    notes.push(`upload failed: ${put.error}`);
    return { leg: 'storage', status: 'FAIL', detail, notes };
  }

  // ---- presigned GET + integrity + EXIF survival ----
  let downloaded: Buffer | null = null;
  const get = await timed(async () => {
    const url = await adapter.getDownloadUrl(key);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET status ${res.status}`);
    downloaded = Buffer.from(await res.arrayBuffer());
    return res.status;
  });
  detail.getMs = round2(get.ms);
  detail.getStatus = get.value ?? null;
  if (get.error || !downloaded) {
    notes.push(`download failed: ${get.error ?? 'no body'}`);
    // still try to clean up
  } else {
    const dl = downloaded as Buffer;
    detail.downloadedSha256 = sha256(dl);
    detail.byteIntegrity = detail.downloadedSha256 === detail.uploadedSha256;
    detail.exifSentinelSurvived = dl.includes(Buffer.from(EXIF_SENTINEL, 'latin1'));
    if (detail.exifSentinelSurvived) {
      notes.push(
        'EXIF sentinel SURVIVED the round trip — expected and correct: the storage port is a ' +
          'forbidden-to-inspect pass-through (never transcodes/strips). EXIF protection in the ' +
          'product comes from CLIENT-SIDE sealing before upload (stored bytes are ciphertext), ' +
          'not from the storage layer. No server-side EXIF stripping exists or should.',
      );
    }
  }

  // ---- delete ONLY what we created, and confirm ----
  const del = await timed(() => adapter.deleteObject(key));
  detail.deleteMs = round2(del.ms);
  detail.deleteReported = del.value ?? false;
  const confirm = await timed(async () => {
    const url = await adapter.getDownloadUrl(key);
    const res = await fetch(url);
    return res.status; // expect 403/404 once gone
  });
  detail.postDeleteGetStatus = confirm.value ?? null;
  detail.deleteConfirmed = confirm.value === 403 || confirm.value === 404;
  if (!detail.deleteConfirmed) notes.push(`cleanup unconfirmed: post-delete GET returned ${confirm.value}`);

  const ok = detail.byteIntegrity === true && detail.deleteConfirmed === true;
  if (ok) notes.push('R2 round trip verified through the real storage port; test object cleaned up.');
  return { leg: 'storage', status: ok ? 'PASS' : 'FAIL', detail, notes };
}
