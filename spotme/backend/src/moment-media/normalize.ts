/**
 * Nearby Moments — the FORMAT NORMALISATION boundary (iPhone media support).
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT IN THE ASYNC WORKER. An iPhone shoots
 * photos as HEIC and videos as QuickTime `.mov`, and both carry GPS. The
 * byte-level stripper next door (`exif-strip.ts`) only understands JPEG and
 * PNG, so both formats were correctly REFUSED rather than stored unstripped.
 * Widening the accept-list without a transcode would have stored the original,
 * location-bearing file — the exact failure the upload route exists to prevent.
 *
 * The transcode therefore runs HERE, synchronously, at the ingest boundary —
 * BEFORE hashing, dedup or persistence. It cannot run in the `{moment-media}`
 * BullMQ worker, because that worker is drained after the bytes are already
 * stored and it writes DERIVED renditions alongside an original that would
 * still be sitting in the bucket with its coordinates intact. A promise of
 * "the stored bytes have no GPS" is only keepable before the write.
 *
 * MEASURED, NOT ASSUMED — `heif-convert` COPIES EXIF INTO ITS JPEG OUTPUT.
 * Converting HEIC→JPEG does not by itself remove anything: the GPS IFD is
 * carried straight across (verified with exiftool on a real GPS-tagged HEIC).
 * That is why every image path here ends by handing its output to
 * `stripImageMetadata`, which drops APP1/Exif. Transcode changes the CONTAINER;
 * the stripper is still what removes the metadata.
 *
 * Note for anyone verifying this by hand: GPS in EXIF and in a QuickTime
 * `udta` atom is stored as binary rationals / a packed ISO-6709 string, so
 * `strings file | grep 12.9716` prints nothing even on a file that is full of
 * coordinates. Grep is not a proof. Use exiftool, or
 * `containsMetadataMarkers` / `containsContainerLocationTags` below.
 *
 * Failure is always REFUSAL, never pass-through: a missing binary, a timeout,
 * a magic-byte mismatch and a non-zero exit all end as a typed refusal with
 * nothing persisted.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A transcode tool is absent from the runtime image. Refuse — never store raw. */
export class TranscodeUnavailableError extends Error {
  constructor(tool: string) {
    super(`transcode tool unavailable: ${tool} — upload refused (never persisted unnormalised)`);
    this.name = 'TranscodeUnavailableError';
  }
}

/** The transcode ran and failed (bad input, timeout, non-zero exit). */
export class NormalizeFailedError extends Error {
  constructor(detail: string) {
    super(`media normalisation failed: ${detail} — refused (never persisted unnormalised)`);
    this.name = 'NormalizeFailedError';
  }
}

/** Wall-clock ceiling for one transcode. A remux is fast; a re-encode fallback
 *  on a 50 MB clip is the slow case this bounds. */
const TRANSCODE_TIMEOUT_MS = 120_000;

/** MIME types accepted at the edge. The ones marked `via` are transcoded to a
 *  format the metadata stripper actually understands before anything is
 *  stored; the stored mime is `to`. */
/**
 * A1 (stories fail on Android): Android WebViews and camera intents routinely
 * hand the client a File with an EMPTY `type`, which the uploader forwards as
 * `application/octet-stream`. The old behaviour refused that outright -- and
 * the failure was ASYMMETRIC in the UI: a post quietly degraded to text and
 * "worked", while a story hard-requires media and died. Same file, same
 * device, one path green and one red.
 *
 * The fix is to sniff MAGIC BYTES when the declared type says nothing, and
 * ONLY into the formats already accepted above -- this widens recognition,
 * never the format set. A declared, accepted type still wins; sniffing is the
 * fallback, not an override.
 */
export function sniffMime(bytes: Buffer): string | null {
  if (bytes.length < 12) return null;
  if (bytes.readUInt16BE(0) === 0xffd8) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand.startsWith('hei') || brand.startsWith('mif')) return 'image/heic';
    if (brand === 'qt  ') return 'video/quicktime';
    return 'video/mp4'; // isom/mp42/3gp4/... -- every other ftyp brand the wild sends
  }
  return null;
}

export const ACCEPTED_INPUT_MIME: Record<string, { kind: 'image' | 'video'; to: string }> = {
  'image/jpeg': { kind: 'image', to: 'image/jpeg' },
  'image/png': { kind: 'image', to: 'image/png' },
  'image/heic': { kind: 'image', to: 'image/jpeg' },
  'image/heif': { kind: 'image', to: 'image/jpeg' },
  'video/mp4': { kind: 'video', to: 'video/mp4' },
  'video/quicktime': { kind: 'video', to: 'video/mp4' },
  'video/webm': { kind: 'video', to: 'video/webm' },
};

/** Formats whose bytes must be rewritten by a tool before they can be stored. */
export const TRANSCODED_MIME = new Set(['image/heic', 'image/heif', 'video/quicktime']);

export interface NormalizedMedia {
  bytes: Buffer;
  /** The mime of `bytes` — NOT necessarily the uploaded mime. */
  mimeType: string;
  kind: 'image' | 'video';
  /** The uploaded mime when a transcode happened, else null. Audit trail. */
  transcodedFrom: string | null;
}

function run(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TRANSCODE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (!err) return resolve();
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.code === 'ENOENT') return reject(new TranscodeUnavailableError(bin));
      if (e.killed) return reject(new NormalizeFailedError(`${bin} timed out after ${TRANSCODE_TIMEOUT_MS}ms`));
      reject(new NormalizeFailedError(`${bin} exited non-zero: ${String(e.message).slice(0, 200)}`));
    });
  });
}

/* ---------------------------------------------------------------- magic bytes
 * The `content-type` header is caller-controlled, so it decides only which
 * BRANCH runs; the bytes themselves have to agree before a tool is spawned.
 * An ISO-BMFF file (HEIC, MP4, MOV) names its flavour in the `ftyp` box brand
 * at offset 4. */

function ftypBrand(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  return buf.subarray(8, 12).toString('latin1');
}

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ']);
const MOV_BRANDS = new Set(['qt  ']);

/** True when the bytes plausibly ARE the declared type. Refusal on mismatch. */
export function magicMatches(bytes: Buffer, mimeType: string): boolean {
  const brand = ftypBrand(bytes);
  switch (mimeType) {
    case 'image/jpeg':
      return bytes.length > 3 && bytes.readUInt16BE(0) === 0xffd8;
    case 'image/png':
      return bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/heic':
    case 'image/heif':
      return brand !== null && HEIC_BRANDS.has(brand);
    case 'video/quicktime':
      // Some cameras write a `.mov` with an mp4 brand; accept either, the
      // remux handles both and the OUTPUT is what gets stored.
      return brand !== null && (MOV_BRANDS.has(brand) || MP4_BRANDS.has(brand));
    case 'video/mp4':
      return brand !== null && (MP4_BRANDS.has(brand) || MOV_BRANDS.has(brand));
    case 'video/webm':
      return bytes.length > 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    default:
      return false;
  }
}

/* ------------------------------------------------------------------- ffmpeg
 * `-map_metadata -1` drops the global metadata dictionary, which is where a
 * QuickTime recording keeps `com.apple.quicktime.location.ISO6709`. The two
 * per-stream forms drop the same thing at stream scope, which `-1` alone does
 * not reach. `-c copy` keeps this a REMUX — no re-encode, so a 40 MB clip is
 * rewritten in about a second and the picture is bit-identical. The browser
 * playability problem (HEVC) is deliberately left to the async ladder in
 * `transcode.worker.ts`; this step's single job is that the STORED bytes carry
 * no location. */
export function remuxArgs(input: string, output: string, format: 'mp4' | 'webm'): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map_metadata', '-1',
    '-map_metadata:s:v', '-1',
    '-map_metadata:s:a', '-1',
    '-c', 'copy',
    ...(format === 'mp4' ? ['-movflags', '+faststart'] : []),
    '-f', format === 'mp4' ? 'mp4' : 'webm',
    output,
  ];
}

/** Used only when `-c copy` refuses the codec pair for the target container. */
export function reencodeArgs(input: string, output: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-map_metadata', '-1',
    '-map_metadata:s:v', '-1',
    '-map_metadata:s:a', '-1',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    '-f', 'mp4',
    output,
  ];
}

/**
 * Rewrite uploaded bytes into a format the metadata stripper understands,
 * with container metadata removed. Throws on anything unexpected — the caller
 * turns that into a typed refusal.
 *
 * IMAGES ARE NOT FINISHED WHEN THIS RETURNS. The JPEG produced from a HEIC
 * still has its EXIF (heif-convert copies it). `ingest()` runs
 * `stripImageMetadata` on the result, and that is what removes the GPS.
 */
export async function normalizeForStorage(bytes: Buffer, mimeType: string): Promise<NormalizedMedia> {
  const spec = ACCEPTED_INPUT_MIME[mimeType];
  if (!spec) throw new NormalizeFailedError(`mime ${mimeType} is not accepted`);
  if (!magicMatches(bytes, mimeType)) throw new NormalizeFailedError(`${mimeType} magic-byte mismatch`);

  // JPEG and PNG need no rewrite — the stripper reads them directly.
  if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
    return { bytes, mimeType, kind: 'image', transcodedFrom: null };
  }

  const dir = await mkdtemp(join(tmpdir(), 'spotme-norm-'));
  try {
    const input = join(dir, 'in');
    await writeFile(input, bytes);

    if (mimeType === 'image/heic' || mimeType === 'image/heif') {
      const out = join(dir, 'out.jpg');
      // -q 92: high enough that a re-encode is not visible next to the JPEGs
      // an Android phone uploads directly.
      await run('heif-convert', ['-q', '92', input, out]);
      const jpeg = await readFile(out);
      if (jpeg.length === 0) throw new NormalizeFailedError('heif-convert produced an empty file');
      return { bytes: jpeg, mimeType: 'image/jpeg', kind: 'image', transcodedFrom: mimeType };
    }

    const format = mimeType === 'video/webm' ? 'webm' : 'mp4';
    const out = join(dir, `out.${format}`);
    try {
      await run('ffmpeg', remuxArgs(input, out, format));
    } catch (e) {
      // A missing binary is not something a re-encode can fix.
      if (e instanceof TranscodeUnavailableError) throw e;
      if (format !== 'mp4') throw e;
      await run('ffmpeg', reencodeArgs(input, out));
    }
    const video = await readFile(out);
    if (video.length === 0) throw new NormalizeFailedError('ffmpeg produced an empty file');
    return {
      bytes: video,
      mimeType: format === 'mp4' ? 'video/mp4' : 'video/webm',
      kind: 'video',
      transcodedFrom: TRANSCODED_MIME.has(mimeType) ? mimeType : null,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * True when a video container still carries a location/device tag. The video
 * counterpart of `containsMetadataMarkers`, used by the tests to assert on the
 * bytes that were actually STORED rather than on a tool's say-so.
 *
 * QuickTime keeps location in a `udta` atom under either the Apple reverse-DNS
 * key or the `©xyz` short key (0xA9 'x' 'y' 'z').
 */
export function containsContainerLocationTags(bytes: Buffer): boolean {
  const hay = bytes.toString('latin1');
  return (
    hay.includes('com.apple.quicktime.location') ||
    hay.includes('\xa9xyz') ||
    /ISO6709/.test(hay) ||
    hay.includes('location.ISO6709')
  );
}
